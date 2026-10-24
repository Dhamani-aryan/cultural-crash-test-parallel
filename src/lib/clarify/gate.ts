import { z } from "zod";
import { compileIntent } from "@/lib/crashtest/intent";
import { SLOTS, type LaunchBrief } from "@/lib/crashtest/types";
import { generateStructured } from "@/lib/llm/structured";
import type { LlmClient } from "@/lib/llm/types";
import type { Market } from "@/lib/markets";
import { detect } from "./detect";
import {
  CLARIFY_BUDGET,
  CLARIFY_VERSION,
  REASON_PRIORITY,
  type BriefPatch,
  type ClarificationAnswer,
  type ClarificationQuestion,
  type Effects,
  type GateBudget,
  type GateResult,
  type IdentityFact,
  type Uncertainty,
} from "./types";

/**
 * The clarification gate: deterministic findings, plus one bounded model proposal, filtered by
 * code. The model never sees Qloo candidates or rankings, may only propose, and its failure never
 * blocks a run: the gate then proceeds on deterministic findings and disclosed assumptions.
 */

// ---------- materiality ----------

/**
 * Askable only when an interpretation changes eligibility, a lock or constraint, the event role,
 * or entity identity. "Reverses two viable complete-plan directions" needs plans, which don't
 * exist before the run, so a trade-off is never askable at this preflight checkpoint.
 */
export function isMaterial(e: Effects, stage: "preflight" | "with_plans" = "preflight"): boolean {
  return e.eligibility || e.constraintState || e.eventRole || e.identity || (stage === "with_plans" && e.winnerOrder);
}

/** Topics that never justify interrupting intake: result-time checks, evidence, or detail for its own sake. */
const NOT_AT_INTAKE = /\b(capacity|availab\w*|budget|price|pricing|cost|attendance|footfall|demographic\w*|age (?:range|group)|gender|income|affinity|qloo|evidence|popularity|followers|sales|willing\w*|insurance|permit\w*|logistics)\b/i;

/** Proper-name runs that don't open a sentence: "Nearby downtown Manhattan" → Manhattan. */
const NAME_RUN = /(?<=[^.!?:;\s]\s+)\p{Lu}[\p{L}'’&.-]*(?:\s+(?:of|de|la|le|the|&)?\s*\p{Lu}[\p{L}'’&.-]*)*/gu;
const GENERIC = new Set(["I", "I’m", "I'm", "Decide", "Keep", "Yes", "No", "Nearby", "Anywhere", "Just", "Preferred", "Only"]);

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();

/** Names a question uses that neither the brief nor the city gives: a sign it is steering. */
export function foreignNames(texts: string[], allowed: string): string[] {
  const ok = norm(allowed);
  return [...new Set(texts.flatMap((t) => [...t.matchAll(NAME_RUN)].map((m) => m[0].trim())))].filter((n) => !GENERIC.has(n) && !ok.includes(norm(n)));
}

// ---------- the bounded model proposal ----------

const proposalSchema = z.object({
  proposals: z
    .array(
      z.object({
        reason: z.enum(["conflict", "entity_identity", "choice_strength", "geography", "event_format", "tradeoff", "rule_meaning"]),
        what: z.string().describe("what is uncertain, one sentence"),
        sourcePhrases: z.array(z.string()).describe("the exact words in the brief that create it, copied verbatim"),
        affectedSlots: z.array(z.enum(SLOTS)),
        interpretations: z.array(z.object({ label: z.string().describe("a short answer option, in the user's terms"), consequence: z.string() })).describe("2-4 distinct readings"),
        multi: z.boolean().describe("true only when more than one option may apply at once"),
        changesEligibility: z.boolean().describe("would the readings make different candidates eligible?"),
        changesConstraint: z.boolean().describe("would the readings change what is fixed, preferred or ruled out?"),
        changesEventRole: z.boolean().describe("would the readings change what kind of venue or event can do the job?"),
        identityRisk: z.boolean().describe("could proceeding silently pick the wrong real-world person, brand or place?"),
        safeDefault: z.string().describe("the reasonable assumption if the user says 'decide for me'"),
        prompt: z.string().describe("the concise question to ask, without naming any brand, act or venue the brief doesn't name"),
        ruleIsMandatory: z.boolean().optional().describe("true only when the cited words are an explicitly mandatory rule (must, only, never, required)"),
        mutuallyExclusive: z.boolean().optional().describe("true only when the readings exclude each other"),
        conservativeReading: z.string().optional().describe("a reading that keeps the rule safe under every interpretation, or an empty string when none exists"),
      }),
    )
    .max(3),
});

export const CLARIFY_SYSTEM =
  "You review a product-launch brief for the rare fact only the user can supply before a plan is made. The plan's strategic, cultural and aesthetic fit (whether choices suit the brand or audience, are too mainstream or niche, or could be bettered) is the planner's job: never ask about it. Propose a question only for an explicitly mandatory rule whose words have two mutually exclusive readings that make different choices eligible, when no conservative reading keeps the rule safe; give that conservative reading when one exists. Copy the exact brief words. Never ask about capacity, availability, budget, demographics, evidence or data, and never suggest or name a brand, act or venue the brief doesn't name. Usually, return no proposals.";

/** Words that make a rule explicitly mandatory. */
const MANDATORY = /\b(must|only|never|no|required|mandatory|cannot|can'?t|always|non-negotiable|has to|have to)\b/i;

function proposalPrompt(brief: LaunchBrief, market: Market, known: Uncertainty[], remaining: number): string {
  const k = compileIntent(brief, market, { names: brief.audienceAnchors, source: brief.audienceAnchors.length ? "user" : "none" });
  return [
    `User's message:\n${brief.sourceText ?? "(none)"}`,
    `Structured brief: brand ${brief.brandName ?? "(unnamed)"}; product ${brief.productCategory}; goal ${brief.launchGoal}; city ${market.label}; audience ${brief.audienceDescription}`,
    `Named choices: ${k.choices.map((c) => `${c.name} (${c.slot}, reads as ${c.strength})`).join("; ") || "none"}`,
    `Hard rules: ${brief.constraints.map((c) => c.description).join("; ") || "none"}`,
    `Event formats read: ${k.formats.map((f) => f.phrase).join(", ") || "none"}; neighbourhoods: ${k.neighborhoods.map((n) => n.phrase).join(", ") || "none"}; avoids: ${k.negative.map((n) => n.phrase).join("; ") || "none"}`,
    `Already found (don't repeat): ${known.map((u) => u.what).join(" | ") || "nothing"}`,
    `Questions left: ${remaining}`,
  ].join("\n\n");
}

/** Model proposals into uncertainties; reasons the deterministic checks own are left to them. */
function fromModel(p: z.infer<typeof proposalSchema>["proposals"][number], i: number): Uncertainty | { dropped: string } {
  // P2.1: only the meaning of an explicitly mandatory rule may be asked; everything else is the agent's work.
  if (["choice_strength", "event_format", "entity_identity"].includes(p.reason)) return { dropped: `${p.reason} is decided by the deterministic checks, not the model` };
  if (p.reason !== "rule_meaning") return { dropped: "strategic, cultural and fit questions are the agent's work, not the user's" };
  const patch = (label: string): BriefPatch[] => [{ kind: "rule_meaning", rule: p.sourcePhrases[0] ?? "", meaning: label }];
  return {
    id: `model:${p.reason}:${i}`,
    reason: p.reason,
    what: p.what,
    sourcePhrases: p.sourcePhrases,
    affectedSlots: p.affectedSlots,
    interpretations: p.interpretations.map((x) => ({ ...x, patches: patch(x.label) })),
    multi: p.multi,
    effects: { eligibility: p.changesEligibility, constraintState: p.changesConstraint, eventRole: p.changesEventRole, winnerOrder: false, identity: p.identityRisk },
    safeDefault: { assumption: p.safeDefault, patches: [{ kind: "assumption", text: p.safeDefault }], provisional: true },
    origin: "model",
    confidence: "low",
    limitations: ["Proposed by the model; admitted only through the code filter."],
    prompt: p.prompt,
  };
}

// ---------- the gate ----------

export interface GateInput {
  brief: LaunchBrief;
  market: Market;
  identities?: IdentityFact[];
  /** null skips the model proposal (deterministic only). */
  llm: LlmClient | null;
  budget?: GateBudget;
  /** Questions already asked in this session (answered or delegated): never asked again. */
  askedIds?: string[];
  /** Names a question must never contain (e.g. candidates a run has retrieved). */
  forbiddenNames?: string[];
  /** Questions this turn: 1 by default, never more than CLARIFY_BUDGET.maxPerTurn. */
  perTurn?: number;
}

export async function runGate(input: GateInput): Promise<GateResult> {
  const { brief, market } = input;
  const budget = input.budget ?? { turnsUsed: 0, questionsAsked: 0 };
  const asked = new Set(input.askedIds ?? []);
  const found = detect(brief, market, input.identities ?? []);
  const audit: GateResult["audit"] = [];
  const turnsLeft = CLARIFY_BUDGET.maxTurns - budget.turnsUsed;
  const questionsLeft = Math.max(0, CLARIFY_BUDGET.maxQuestions - budget.questionsAsked);
  const canAsk = turnsLeft > 0 && questionsLeft > 0;

  // The bounded model proposal, only while questions can still be asked.
  let generator: GateResult["generator"] = "skipped";
  const proposed: Uncertainty[] = [];
  const conservativeAssumptions: { text: string; rule: string; meaning: string }[] = [];
  if (input.llm && canAsk) {
    try {
      const { data } = await generateStructured(input.llm, { schema: proposalSchema, system: CLARIFY_SYSTEM, prompt: proposalPrompt(brief, market, found.uncertainties, questionsLeft), label: "clarify:propose" });
      generator = "ok";
      const briefText = [brief.sourceText ?? "", brief.launchGoal, brief.productCategory, brief.audienceDescription, brief.brandAttributes.join(", "), ...brief.constraints.map((c) => c.description)].join("\n");
      const allowed = [briefText, market.label, market.qlooLocation, ...(market.locationAliases ?? []), brief.brandName ?? ""].join("\n");
      const forbidden = (input.forbiddenNames ?? []).map(norm).filter(Boolean);
      data.proposals.forEach((p, i) => {
        const u = fromModel(p, i);
        const id = `model:${p.reason}:${i}`;
        const drop = (why: string) => audit.push({ id, reason: p.reason, origin: "model", outcome: "dropped", why });
        if ("dropped" in u) return drop(u.dropped);
        const texts = [u.prompt, u.what, ...u.interpretations.map((x) => x.label)];
        if (!u.sourcePhrases.length || u.sourcePhrases.some((s) => !norm(briefText).includes(norm(s)))) return drop("cites words the brief doesn't contain");
        if (texts.some((t) => NOT_AT_INTAKE.test(t))) return drop("asks about something that is a result-time check or not needed to proceed");
        const leaked = forbidden.filter((n) => texts.some((t) => norm(t).includes(n)));
        if (leaked.length) return drop(`names a candidate (${leaked.join(", ")})`);
        // The question itself names nothing the brief doesn't; the readings may name what each refers to.
        const foreign = foreignNames([u.prompt, u.what], allowed);
        if (foreign.length) return drop(`names something the brief doesn't (${foreign.join(", ")})`);
        if (u.interpretations.length < 2) return drop("offers fewer than two readings");
        // The strict rule-meaning conditions: an explicitly mandatory rule, readings that exclude each
        // other and change eligibility, and no conservative reading that keeps the rule safe.
        const hardRule = u.sourcePhrases.some((s) => brief.constraints.some((c) => c.kind === "hard" && norm(c.description).includes(norm(s))) || MANDATORY.test(s));
        if (p.ruleIsMandatory !== true || !hardRule) return drop("the cited words aren't an explicitly mandatory rule");
        if (p.mutuallyExclusive !== true || !p.changesEligibility) return drop("the readings don't exclude each other or don't change eligibility");
        const conservative = (p.conservativeReading ?? "").trim();
        if (conservative) {
          conservativeAssumptions.push({ text: `"${u.sourcePhrases[0]}" is read conservatively: ${conservative}.`, rule: u.sourcePhrases[0], meaning: conservative });
          return drop("a conservative reading keeps the rule safe");
        }
        const dup = found.uncertainties.find((d) => d.reason === u.reason && d.affectedSlots.some((s) => u.affectedSlots.includes(s)));
        if (dup) return drop(`duplicates ${dup.id}`);
        proposed.push(u);
      });
    } catch {
      generator = "failed";
    }
  }

  const all = [...found.uncertainties, ...proposed];
  const material: Uncertainty[] = [];
  const assumptions: string[] = generator === "failed" ? ["The clarification model was unavailable; the run proceeds on what the brief says and the assumptions below."] : [];
  const provisional: string[] = [];
  const deferred: string[] = [];
  const assumedPatches: BriefPatch[] = conservativeAssumptions.map((c) => ({ kind: "rule_meaning", rule: c.rule, meaning: c.meaning }));
  assumptions.push(...conservativeAssumptions.map((c) => c.text));
  const assume = (u: Uncertainty, why: string, outcome: "assumed" | "dropped" = "assumed") => {
    assumptions.push(u.safeDefault.assumption);
    assumedPatches.push(...u.safeDefault.patches);
    if (u.safeDefault.provisional) provisional.push(u.safeDefault.assumption);
    audit.push({ id: u.id, reason: u.reason, origin: u.origin, outcome, why });
  };
  for (const u of all) {
    if (asked.has(u.id)) audit.push({ id: u.id, reason: u.reason, origin: u.origin, outcome: "dropped", why: "already asked in this session" });
    else if (!isMaterial(u.effects)) assume(u, u.reason === "tradeoff" ? "a trade-off is askable only between viable complete plans, which don't exist before the run" : "no reading changes eligibility, a constraint, the event role or identity");
    else material.push(u);
  }

  // Priority: conflicts and hard rules, identity, choice strength, geography and format, trade-offs;
  // then the deterministic finding before the model's, then the greater effect on eligibility.
  const weight = (u: Uncertainty) => (u.effects.eligibility || u.effects.identity ? 2 : 0) + (u.effects.constraintState || u.effects.eventRole ? 1 : 0);
  material.sort((a, b) => REASON_PRIORITY[a.reason] - REASON_PRIORITY[b.reason] || Number(a.origin === "model") - Number(b.origin === "model") || weight(b) - weight(a));
  const perTurn = Math.min(Math.max(1, input.perTurn ?? CLARIFY_BUDGET.defaultPerTurn), CLARIFY_BUDGET.maxPerTurn);
  const take = canAsk ? Math.min(perTurn, questionsLeft) : 0;
  const toAsk = material.slice(0, take);
  // What isn't asked now can wait for a later turn only if one remains after this one.
  const laterTurn = turnsLeft - (toAsk.length ? 1 : 0) > 0 && questionsLeft - toAsk.length > 0;
  for (const u of material.slice(take)) {
    if (laterTurn) {
      deferred.push(u.what);
      audit.push({ id: u.id, reason: u.reason, origin: u.origin, outcome: "deferred", why: "a later turn remains in the budget" });
    } else assume(u, canAsk ? "the question budget leaves no later turn" : "the clarification budget is used up");
  }
  for (const u of toAsk) audit.push({ id: u.id, reason: u.reason, origin: u.origin, outcome: "asked", why: describe(u.effects) });

  return {
    version: CLARIFY_VERSION,
    decision: toAsk.length ? "clarify" : "ready",
    questions: toAsk.map(toQuestion),
    resolutions: found.resolutions,
    assumptions,
    assumedPatches,
    deferred,
    provisional,
    audit,
    generator,
  };
}

const describe = (e: Effects) =>
  [e.eligibility && "changes which candidates are eligible", e.constraintState && "changes what is fixed or ruled out", e.eventRole && "changes the venue or event role", e.identity && "risks the wrong real-world entity"].filter(Boolean).join("; ");

export function toQuestion(u: Uncertainty): ClarificationQuestion {
  return {
    id: u.id,
    reason: u.reason,
    prompt: u.prompt,
    inputKind: u.multi ? "multi_choice" : "single_choice",
    options: u.interpretations.map((x, i) => ({ id: `${u.id}#${i + 1}`, label: x.label, value: x.label, consequence: x.consequence, patches: x.patches })),
    allowCustom: true,
    allowDelegate: true,
    affectedSlots: u.affectedSlots,
    sourcePhrases: u.sourcePhrases,
    materialEffect: describe(u.effects),
    delegatedAssumption: u.safeDefault.assumption,
    delegatedPatches: u.safeDefault.patches,
    delegationIsProvisional: u.safeDefault.provisional,
  };
}

// ---------- answers → patches (P1 applies them to the brief) ----------

export type AnswerOutcome =
  | { ok: true; patches: BriefPatch[]; assumption?: string; provisional: boolean; needsInterpretation: boolean }
  | { ok: false; error: string };

/** The deterministic patches an answer stands for. Validates the question and option IDs. */
export function answerPatches(q: ClarificationQuestion, a: ClarificationAnswer): AnswerOutcome {
  if (a.questionId !== q.id) return { ok: false, error: `answer is for ${a.questionId}, not ${q.id}` };
  if (a.delegated) return { ok: true, patches: q.delegatedPatches, assumption: q.delegatedAssumption, provisional: q.delegationIsProvisional, needsInterpretation: false };
  const ids = [...new Set(a.selectedOptionIds)];
  const unknown = ids.filter((id) => !q.options.some((o) => o.id === id));
  if (unknown.length) return { ok: false, error: `unknown option ${unknown.join(", ")}` };
  if (!ids.length) {
    const text = a.customText?.trim();
    if (!text) return { ok: false, error: "no option, text or delegation" };
    // A typed answer is recorded verbatim; P1 interprets it against the options.
    return { ok: true, patches: [{ kind: "assumption", text: `Answer to "${q.prompt}": ${text}` }], provisional: false, needsInterpretation: true };
  }
  if (q.inputKind === "single_choice" && ids.length > 1) return { ok: false, error: "only one option may be chosen" };
  return { ok: true, patches: ids.flatMap((id) => q.options.find((o) => o.id === id)!.patches), provisional: false, needsInterpretation: false };
}
