import { z } from "zod";
import { generateStructured } from "@/lib/llm/structured";
import type { LlmClient } from "@/lib/llm/types";
import type { Market } from "@/lib/markets";
import type { Ledger } from "./ledger";
import { claimsOf, componentLine, evidenceOrder } from "./matrix";
import {
  EVIDENCE_DIMENSIONS,
  EVIDENCE_DIMENSION_LABEL,
  SLOT_LABEL,
  type AdjudicationResult,
  type BlindJudgment,
  type CandidatePlan,
  type EvidenceClaim,
  type EvidenceDimension,
  type EvidenceMatrix,
  type EvidenceSource,
  type LaunchBrief,
  type PlanTrack,
} from "./types";

/**
 * Blind, order-rotated adjudication. Deterministic hard gates run first and remove any plan that
 * breaks the brief; the judge never sees those. Plans with identical choices are judged once. The
 * judge sees random blind IDs, aliased claim IDs and the brief, never which track made a plan.
 * It is asked twice, in two orders where every plan changes position; its answers are resolved to
 * candidate IDs in code and checked. If the two orders disagree, or either answer is unusable,
 * the verdict is "unstable": nothing new was learnt between them, so a changed answer means
 * position, not evidence, decided it.
 */

/** Below this share of measured checks for every plan, there is nothing to adjudicate. */
export const MIN_COVERAGE = 0.2;

export const JUDGE_SYSTEM = `You compare anonymous launch plans for one brief, using only the numbered evidence claims given. Plans are labelled with random IDs that mean nothing, and their order is random. Decide which complete plan is best supported, or that they tie, or that the evidence is insufficient to say.
Priority, in order: (1) keep what the brief asks for (its named and fixed choices, its rules) and prefer a complete plan over one with open choices; (2) audience fit and role fit; (3) local relevance and fit across the plan; (4) feasibility; (5) distinctiveness, only to separate otherwise equal plans.
Unknown evidence is uncertainty, not failure; thin evidence is not a contradiction. Do not reward longer descriptions, more claims or the position a plan is shown in. Never predict or claim sales, attendance, engagement, revenue or success.
Cite the claim IDs that decide your verdict and the strongest claims against the winner. Return a tie when the evidence doesn't separate the plans.`;

const judgeSchema = z.object({
  verdict: z.enum(["winner", "tie", "insufficient_evidence"]),
  winner: z.string().nullable().optional().describe("the winning plan's ID, copied exactly; null unless verdict is winner"),
  decisive: z.array(z.string()).describe("claim IDs that decide the verdict, copied exactly"),
  counter: z.array(z.string()).describe("claim IDs that count against the winner, copied exactly"),
  dimensionWinners: z
    .array(z.object({ dimension: z.enum(EVIDENCE_DIMENSIONS), plans: z.array(z.string()) }))
    .describe("for each dimension the claims separate, the plan ID(s) best on it"),
  rationale: z.string().describe("two or three sentences citing claim IDs; no forecasts"),
});

/** What a claim's source is called in front of the judge: nothing that names a track. */
const NEUTRAL_SOURCE: Record<EvidenceSource, string> = {
  user: "brief",
  constraint: "constraint",
  qloo_affinity: "Qloo affinity",
  qloo_locality: "Qloo locality",
  qloo_coherence: "Qloo coherence",
  qloo_explainability: "Qloo explainability",
  entity_metadata: "Qloo entity data",
  logical_rubric: "rule",
  official_source: "official source",
  human: "human review",
  counterfactual: "robustness check",
};

/** Wording a verdict may not carry: outcomes the cultural evidence can't show. */
export const COMMERCIAL_CLAIM =
  /\b(sales?|revenue|roi|profit|conversions?|attendance|footfall|turnout|guarantee[sd]?|sell[- ]?outs?|go(?:es)? viral|will (?:drive|boost|increase|generate))\b/i;

/** Remove sentences that claim commercial outcomes; return the cleaned text and what was removed. */
export function stripCommercialClaims(text: string): { text: string; removed: string[] } {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const removed = sentences.filter((s) => COMMERCIAL_CLAIM.test(s));
  return { text: sentences.filter((s) => !COMMERCIAL_CLAIM.test(s)).join(" ").trim(), removed };
}

/** A neutral brief for the judge: the confirmed brief, without who-wrote-what labels. */
function judgeBrief(brief: LaunchBrief, market: Market): string {
  return [
    `Product: ${brief.productCategory}${brief.brandName ? ` (${brief.brandName})` : ""}`,
    `Goal: ${brief.launchGoal}`,
    brief.sourceText ? `Original description: ${brief.sourceText}` : "",
    `City: ${market.label}`,
    `Audience: ${brief.audienceDescription}`,
    brief.brandAttributes.length ? `Brand attributes: ${brief.brandAttributes.join(", ")}` : "",
    ...brief.existingChoices.map((c) => `Named in the brief (${SLOT_LABEL[c.slot]}): ${c.name}`),
    ...brief.constraints.map((c) => `${c.kind === "hard" ? "Hard" : "Soft"} rule: ${c.description}`),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Every plan moves: the second order is the first rotated by one. */
export function rotatedOrders(ids: string[]): string[][] {
  if (ids.length < 2) return [ids];
  return [ids, [...ids.slice(1), ids[0]]];
}

const TRACK_PRIORITY: PlanTrack[] = ["user", "llm", "agent", "hybrid"];
const signature = (c: CandidatePlan) =>
  [...c.plan.components]
    .map((x) => `${x.slot}=${x.entity?.id ?? x.label.toLowerCase()}|${x.tags.map((t) => t.id).sort().join(",")}`)
    .sort()
    .join(";") + `#open:${c.open.map((o) => o.slot).sort().join(",")}`;

/**
 * Plans with exactly the same choices are one plan. It keeps the identity of the track that
 * owns it most directly: the user's own plan first, then the LLM's, the agent's, a hybrid's.
 */
export function mergeIdentical(candidates: CandidatePlan[]): { kept: CandidatePlan[]; merged: Record<string, string> } {
  const bySig = new Map<string, CandidatePlan[]>();
  for (const c of candidates) bySig.set(signature(c), [...(bySig.get(signature(c)) ?? []), c]);
  const kept: CandidatePlan[] = [];
  const merged: Record<string, string> = {};
  for (const group of bySig.values()) {
    const [keep, ...rest] = [...group].sort((a, b) => TRACK_PRIORITY.indexOf(a.track) - TRACK_PRIORITY.indexOf(b.track));
    kept.push(keep);
    for (const r of rest) merged[r.candidateId] = keep.candidateId;
  }
  return { kept: candidates.filter((c) => kept.includes(c)), merged };
}

export interface AdjudicateInput {
  llm: LlmClient;
  stage: AdjudicationResult["stage"];
  candidates: CandidatePlan[];
  matrix: EvidenceMatrix;
  brief: LaunchBrief;
  market: Market;
  ledger: Ledger;
}

/** The judge's prompt for one order, and how its aliases map back to claim IDs. */
export function judgePrompt(order: CandidatePlan[], matrix: EvidenceMatrix, brief: LaunchBrief, market: Market) {
  const alias = new Map<string, EvidenceClaim>();
  const blocks = order.map((c) => {
    const claims = claimsOf(matrix, c.candidateId);
    const lines = claims.map((cl, i) => {
      const a = `${c.blindId}.${i + 1}`;
      alias.set(a, cl);
      const lim = cl.limitations.length ? ` [limits: ${cl.limitations.join(" ")}]` : "";
      return `  ${a} · ${EVIDENCE_DIMENSION_LABEL[cl.dimension]} · ${cl.stance}${cl.strength !== "unknown" ? ` (${cl.strength})` : ""} · ${NEUTRAL_SOURCE[cl.source]}: ${cl.claim}${lim}`;
    });
    return [
      `Plan ${c.blindId}`,
      ...c.plan.components.map((x) => `  ${componentLine(x)}`),
      ...c.open.map((o) => `  ${SLOT_LABEL[o.slot]}: (open)`),
      `  Claims:`,
      ...lines,
    ].join("\n");
  });
  return { prompt: [judgeBrief(brief, market), ...blocks].join("\n\n"), alias };
}

async function judgeOnce(input: AdjudicateInput, order: CandidatePlan[]): Promise<BlindJudgment> {
  const { prompt, alias } = judgePrompt(order, input.matrix, input.brief, input.market);
  const blind = new Map(order.map((c) => [c.blindId, c.candidateId]));
  const problems: string[] = [];
  let data: z.infer<typeof judgeSchema> | null = null;
  try {
    ({ data } = await generateStructured(input.llm, { schema: judgeSchema, system: JUDGE_SYSTEM, prompt, label: `adjudicate:${input.stage}` }));
  } catch (err) {
    problems.push(`The judge's answer couldn't be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const resolve = (ids: string[], what: string) =>
    ids.flatMap((a) => {
      const c = alias.get(a.trim());
      if (!c) problems.push(`Unknown ${what} claim ID "${a}".`);
      return c ? [c.claimId] : [];
    });
  const decisive = data ? resolve(data.decisive, "decisive") : [];
  const counter = data ? resolve(data.counter, "counter") : [];
  let winner: string | null = null;
  if (data?.verdict === "winner") {
    winner = data.winner ? (blind.get(data.winner.trim()) ?? null) : null;
    if (!winner) problems.push(`The winner "${data.winner ?? ""}" isn't one of the plans shown.`);
    else if (!decisive.some((id) => input.matrix.claims.find((c) => c.claimId === id)?.candidateId === winner))
      problems.push("No decisive claim belongs to the winner.");
  }
  const dimensionWinners: BlindJudgment["dimensionWinners"] = {};
  for (const d of data?.dimensionWinners ?? []) {
    const ids = d.plans.flatMap((p) => blind.get(p.trim()) ?? []);
    if (ids.length) dimensionWinners[d.dimension as EvidenceDimension] = ids;
  }
  const valid = !!data && !problems.some((p) => !p.startsWith("Unknown counter"));
  const record = input.ledger.add({
    purpose: `Blind ${input.stage} adjudication, order ${order.map((c) => c.blindId).join(" → ")}`,
    queryKind: "adjudication",
    sanitizedRequest: { order: order.map((c) => c.blindId), stage: input.stage },
    qlooEntityIds: [],
    results: [],
    resultCount: data ? 1 : 0,
    coverageStatus: valid ? "usable" : "error",
    warnings: problems,
  });
  return {
    order: order.map((c) => c.blindId),
    verdict: data?.verdict ?? "insufficient_evidence",
    winnerCandidateId: valid ? winner : null,
    decisiveClaimIds: decisive,
    counterevidenceClaimIds: counter,
    dimensionWinners,
    rationale: data?.rationale ?? "",
    evidenceId: record.evidenceId,
    valid,
    problem: problems.length ? problems.join(" ") : undefined,
  };
}

export async function adjudicate(input: AdjudicateInput): Promise<AdjudicationResult> {
  const { matrix } = input;
  const ids = input.candidates.map((c) => c.candidateId);
  const eliminated = Object.fromEntries(ids.filter((id) => matrix.hardFailures[id]?.length).map((id) => [id, matrix.hardFailures[id]]));
  const passing = input.candidates.filter((c) => !eliminated[c.candidateId]);
  const { kept, merged } = mergeIdentical(passing);
  const order = [...evidenceOrder(matrix, kept.map((c) => c.candidateId)), ...ids.filter((id) => !kept.some((k) => k.candidateId === id))];
  const base: AdjudicationResult = {
    stage: input.stage,
    candidateIds: ids,
    eliminated,
    merged,
    winnerCandidateId: null,
    verdict: "insufficient_evidence",
    dimensionWinners: {},
    rationale: "",
    decisiveClaimIds: [],
    counterevidenceClaimIds: [],
    orderResults: [],
    flagged: [],
    evidenceOrder: order,
  };
  if (!kept.length) return { ...base, rationale: "Every plan breaks a hard rule of the brief, so none can be recommended." };
  if (kept.length === 1) {
    const only = kept[0].candidateId;
    return {
      ...base,
      verdict: "winner",
      winnerCandidateId: only,
      rationale: Object.keys(eliminated).length || Object.keys(merged).length
        ? "Only one distinct plan passes the brief's hard rules."
        : "Only one plan was offered.",
      decisiveClaimIds: claimsOf(matrix, only).filter((c) => c.stance === "supports").map((c) => c.claimId),
    };
  }
  if (kept.every((c) => (matrix.coverageByCandidate[c.candidateId] ?? 0) < MIN_COVERAGE))
    return { ...base, rationale: "Qloo measured too little of any plan to compare them." };

  // Blind IDs are random per run, so sorting by them is a random order; the second order rotates it.
  const shown = [...kept].sort((a, b) => a.blindId.localeCompare(b.blindId));
  const orders = rotatedOrders(shown.map((c) => c.candidateId)).map((o) => o.map((id) => shown.find((c) => c.candidateId === id)!));
  const results: BlindJudgment[] = [];
  for (const o of orders) results.push(await judgeOnce(input, o));

  const [a, b] = results;
  const agree = a.valid && b.valid && a.verdict === b.verdict && a.winnerCandidateId === b.winnerCandidateId;
  const verdict: AdjudicationResult["verdict"] = agree ? a.verdict : "unstable";
  const cleaned = results.map((r) => stripCommercialClaims(r.rationale));
  const dimensionWinners: AdjudicationResult["dimensionWinners"] = {};
  if (agree)
    for (const d of EVIDENCE_DIMENSIONS) {
      const x = a.dimensionWinners[d] ?? [];
      const y = b.dimensionWinners[d] ?? [];
      const both = x.filter((id) => y.includes(id));
      if (both.length) dimensionWinners[d] = both;
    }
  return {
    ...base,
    verdict,
    winnerCandidateId: agree && verdict === "winner" ? a.winnerCandidateId : null,
    dimensionWinners,
    rationale: agree
      ? cleaned[0].text
      : `The two orders disagreed (${results.map((r) => (r.valid ? (r.verdict === "winner" ? `winner ${r.winnerCandidateId}` : r.verdict) : "unusable answer")).join(" vs ")}), so position rather than evidence decided at least one of them.`,
    decisiveClaimIds: agree ? [...new Set([...a.decisiveClaimIds, ...b.decisiveClaimIds])] : [],
    counterevidenceClaimIds: agree ? [...new Set([...a.counterevidenceClaimIds, ...b.counterevidenceClaimIds])] : [],
    orderResults: results,
    flagged: cleaned.flatMap((c) => c.removed),
  };
}
