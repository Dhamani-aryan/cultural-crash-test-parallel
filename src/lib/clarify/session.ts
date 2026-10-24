import { createHash, randomUUID } from "node:crypto";
import { compileIntent } from "@/lib/crashtest/intent";
import { freezeBrief, userChoiceCountries } from "@/lib/crashtest/tracks";
import { LaunchBriefSchema, type LaunchBriefInput } from "@/lib/crashtest/types";
import type { LlmClient } from "@/lib/llm/types";
import { marketById } from "@/lib/markets";
import type { QlooClient } from "@/lib/qloo";
import { answerPatches, runGate } from "./gate";
import { interpretText } from "./interpret";
import { applyPatches } from "./patch";
import { identityFacts } from "./preflight";
import { CLARIFY_BUDGET, CLARIFY_VERSION, type BriefPatch, type ClarificationAnswer, type ClarificationQuestion, type GateResult, type IdentityFact } from "./types";

/**
 * The bounded clarification session (P1). States: understanding → awaiting_clarification ⇄
 * (answers) → ready → running → complete. At most two clarification turns and three questions;
 * after that "Decide for me" applies itself. There is no way back from running into intake.
 * The session is non-secret structured state, stored server-side by id; the user's original
 * message is never edited, and every patch and assumption is kept for the audit.
 */

export type SessionState = "understanding" | "awaiting_clarification" | "ready" | "running" | "complete";

/** What the client sees of a question: no patches (the server holds them). */
export type PublicQuestion = Omit<ClarificationQuestion, "options" | "delegatedPatches"> & { options: { id: string; label: string }[] };

export interface PublicSession {
  sessionId: string;
  state: SessionState;
  turnsUsed: number;
  questionsAsked: number;
  maxTurns: number;
  maxQuestions: number;
  assumptions: string[];
}

export type ClarifyEvent =
  | { type: "assistant_message"; text: string }
  | { type: "clarification_required"; session: PublicSession; questions: PublicQuestion[] }
  | { type: "clarification_applied"; sessionId: string; acknowledgement: string; briefDraft: LaunchBriefInput }
  | { type: "ready"; sessionId: string; clarifiedBrief: LaunchBriefInput; fingerprint: string; assumptions: string[]; provisional: string[] }
  | { type: "run_started"; runId: string; sessionId: string };

export interface Session {
  version: string;
  sessionId: string;
  state: SessionState;
  createdAt: string;
  /** The brief as first submitted; never changed. */
  original: LaunchBriefInput;
  /** The brief with every clarification applied so far. */
  brief: LaunchBriefInput;
  pending: ClarificationQuestion[];
  asked: ClarificationQuestion[];
  answers: { answer: ClarificationAnswer; patches: BriefPatch[]; acknowledgement: string }[];
  /** Every patch applied, with what it did. */
  audit: { source: string; patch: BriefPatch; effect: string }[];
  assumptions: string[];
  provisional: string[];
  turnsUsed: number;
  questionsAsked: number;
  fingerprint?: string;
  clarifiedBrief?: LaunchBriefInput;
  /** Answer submissions already processed, by key, with the events they produced (idempotency). */
  replies: Record<string, ClarifyEvent[]>;
  generator: GateResult["generator"][];
  /** Preflight identity facts, kept for every later gate pass in the session. */
  identities: IdentityFact[];
}

export interface SessionDeps {
  llm: LlmClient;
  qloo: QlooClient;
}

/** An answer as the client sends it: structured, or a typed chat message. */
export interface AnswerInput {
  questionId?: string;
  selectedOptionIds?: string[];
  customText?: string;
  delegated?: boolean;
  /** A normal chat message, read against the open question. */
  message?: string;
}

export class SessionError extends Error {
  constructor(
    readonly code: "invalid_state" | "unknown_question" | "invalid_answer" | "unanswered",
    message: string,
  ) {
    super(message);
  }
}

export const publicSession = (s: Session): PublicSession => ({
  sessionId: s.sessionId,
  state: s.state,
  turnsUsed: s.turnsUsed,
  questionsAsked: s.questionsAsked,
  maxTurns: CLARIFY_BUDGET.maxTurns,
  maxQuestions: CLARIFY_BUDGET.maxQuestions,
  assumptions: s.assumptions,
});

export const publicQuestion = (q: ClarificationQuestion): PublicQuestion => {
  const { delegatedPatches: _patches, options, ...rest } = q;
  void _patches;
  return { ...rest, options: options.map((o) => ({ id: o.id, label: o.label })) };
};

/** Start a session: preflight identity checks and the gate, before any U/L/A generation. */
export async function startSession(brief: LaunchBriefInput, deps: SessionDeps, sessionId = randomUUID()): Promise<{ session: Session; events: ClarifyEvent[] }> {
  const parsed = LaunchBriefSchema.parse(brief);
  const session: Session = {
    version: CLARIFY_VERSION,
    sessionId,
    state: "understanding",
    createdAt: new Date().toISOString(),
    original: structuredClone(brief),
    brief: structuredClone(brief),
    pending: [],
    asked: [],
    answers: [],
    audit: [],
    assumptions: [],
    provisional: [],
    turnsUsed: 0,
    questionsAsked: 0,
    replies: {},
    generator: [],
    identities: [],
  };
  const market = marketById(parsed.marketId);
  if (!market) throw new SessionError("invalid_answer", `Unsupported city: ${parsed.marketId}`);
  // Cheap preflight: which named acts or brands Qloo knows only as a namesake. A failure here only
  // skips identity questions; it never blocks the run.
  session.identities = await userChoiceCountries(deps.llm, parsed, market)
    .then((countries) => identityFacts(deps.qloo, parsed, market, countries))
    .catch(() => []);
  return { session, events: await gateTurn(session, deps) };
}

/** One gate pass on the current brief: ask within the budget, or freeze and be ready. */
async function gateTurn(session: Session, deps: SessionDeps): Promise<ClarifyEvent[]> {
  const brief = LaunchBriefSchema.parse(session.brief);
  const market = marketById(brief.marketId)!;
  const gate = await runGate({
    brief,
    market,
    identities: session.identities,
    llm: deps.llm,
    budget: { turnsUsed: session.turnsUsed, questionsAsked: session.questionsAsked },
    askedIds: session.asked.map((q) => q.id),
  });
  session.generator.push(gate.generator);
  if (gate.decision === "clarify") {
    session.state = "awaiting_clarification";
    session.pending = gate.questions;
    session.asked.push(...gate.questions);
    session.turnsUsed++;
    session.questionsAsked += gate.questions.length;
    const lead = session.turnsUsed === 1 ? (gate.questions.length > 1 ? "A couple of things could materially change the plan." : "One thing could materially change the plan.") : "One more thing could change the plan.";
    return [
      { type: "assistant_message", text: lead },
      { type: "clarification_required", session: publicSession(session), questions: gate.questions.map(publicQuestion) },
    ];
  }
  // Ready: what the brief settles itself, and every default the budget or materiality applied.
  const settled = gate.resolutions.flatMap((r) => r.patches);
  apply(session, "brief wording", settled);
  apply(session, "default", gate.assumedPatches);
  session.assumptions.push(...gate.assumptions.filter((a) => !session.assumptions.includes(a)));
  session.provisional.push(...gate.provisional.filter((a) => !session.provisional.includes(a)));
  const line = session.answers.length ? null : understood(gate);
  return [...(line ? [{ type: "assistant_message" as const, text: line }] : []), ready(session)];
}

function apply(session: Session, source: string, patches: BriefPatch[]) {
  if (!patches.length) return;
  const r = applyPatches(session.brief, patches);
  session.brief = r.brief;
  session.audit.push(...r.applied.map((a) => ({ source, ...a })));
  for (const a of r.assumptions) if (!session.assumptions.includes(a)) session.assumptions.push(a);
  for (const p of r.provisional) if (!session.provisional.includes(p)) session.provisional.push(p);
}

function ready(session: Session): ClarifyEvent {
  const clarified = LaunchBriefSchema.parse(session.brief);
  session.clarifiedBrief = session.brief;
  // The fingerprint every track's frozen brief will carry (the run freezes the same brief).
  session.fingerprint = freezeBrief(clarified).fingerprint;
  session.state = "ready";
  session.pending = [];
  return { type: "ready", sessionId: session.sessionId, clarifiedBrief: session.brief, fingerprint: session.fingerprint, assumptions: session.assumptions, provisional: session.provisional };
}

/** The opening line when nothing needs asking: what the brief already settles, in plain words. */
function understood(gate: GateResult): string | null {
  const said = gate.resolutions
    .flatMap((r) => r.patches)
    .flatMap((p) => {
      if (p.kind === "choice_strength")
        return p.strength === "locked" ? [`keep ${p.name}`] : p.strength === "considered" ? [`treat ${p.name} as one option to test`] : p.strength === "example" ? [`treat ${p.name} as an example`] : [];
      if (p.kind === "geography") return p.strictness === "required" ? [`keep it in ${p.place}`] : p.strictness === "nearby" ? [`aim for ${p.place} or nearby`] : [];
      return [];
    })
    .slice(0, 3);
  // The intake has already said it has enough; this adds only what the brief settles, if anything.
  if (!said.length) return null;
  const list = said.length > 1 ? `${said.slice(0, -1).join(", ")} and ${said.at(-1)}` : said[0];
  return `I’ll ${list}.`;
}

const keyOf = (answers: AnswerInput[]) =>
  createHash("sha256")
    .update(JSON.stringify(answers.map((a) => ({ q: a.questionId ?? "", o: [...(a.selectedOptionIds ?? [])].sort(), t: (a.customText ?? a.message ?? "").trim(), d: !!a.delegated }))))
    .digest("hex")
    .slice(0, 16);

/**
 * Apply answers to the open questions. The same submission twice returns the same events and
 * changes nothing. A typed message that doesn't answer the open question leaves it open.
 */
export async function answerSession(session: Session, answers: AnswerInput[], deps: SessionDeps): Promise<{ session: Session; events: ClarifyEvent[]; replayed: boolean }> {
  const key = keyOf(answers);
  if (session.replies[key]) return { session, events: session.replies[key], replayed: true };
  if (session.state !== "awaiting_clarification") throw new SessionError("invalid_state", `The session is ${session.state}, not waiting for an answer.`);
  if (!answers.length) throw new SessionError("unanswered", "No answer was given.");

  const resolved: { q: ClarificationQuestion; answer: ClarificationAnswer }[] = [];
  for (const a of answers) {
    // A typed message answers the only open question (or the one it names).
    const q = a.questionId ? session.pending.find((x) => x.id === a.questionId) : session.pending.length === 1 ? session.pending[0] : undefined;
    if (!q) {
      if (a.questionId && session.asked.some((x) => x.id === a.questionId)) throw new SessionError("invalid_answer", `${a.questionId} was already answered.`);
      throw new SessionError(a.questionId ? "unknown_question" : "invalid_answer", a.questionId ? `${a.questionId} isn't an open question.` : "Say which question this answers.");
    }
    const at = new Date().toISOString();
    if (a.message !== undefined && !a.selectedOptionIds?.length && !a.delegated) {
      const read = interpretText(q, a.message);
      if (read.kind === "unrelated") {
        // Not an answer: keep the question open and say so; nothing is consumed.
        return { session, replayed: false, events: [{ type: "assistant_message", text: "That doesn't answer the open question, so it is still open." }, { type: "clarification_required", session: publicSession(session), questions: session.pending.map(publicQuestion) }] };
      }
      resolved.push({ q, answer: { questionId: q.id, selectedOptionIds: read.kind === "option" ? [read.optionId] : [], customText: read.kind === "custom" ? read.text : undefined, delegated: read.kind === "delegate", answeredAt: at } });
    } else resolved.push({ q, answer: { questionId: q.id, selectedOptionIds: a.selectedOptionIds ?? [], customText: a.customText, delegated: !!a.delegated, answeredAt: at } });
  }
  const missing = session.pending.filter((q) => !resolved.some((r) => r.q.id === q.id));
  if (missing.length) throw new SessionError("unanswered", `Still open: ${missing.map((q) => q.id).join(", ")}.`);

  const acks: string[] = [];
  for (const { q, answer } of resolved) {
    const out = answerPatches(q, answer);
    if (!out.ok) throw new SessionError("invalid_answer", out.error);
    const counts = [session.assumptions.length, session.provisional.length];
    apply(session, q.id, out.patches);
    // The patches' own notes are the more specific record; the question's text only fills a gap.
    if (out.assumption && session.assumptions.length === counts[0] && !session.assumptions.includes(out.assumption)) session.assumptions.push(out.assumption);
    if (out.provisional && out.assumption && session.provisional.length === counts[1] && !session.provisional.includes(out.assumption)) session.provisional.push(out.assumption);
    const ack = answer.delegated
      ? `I'll decide: ${q.delegatedAssumption}`
      : answer.selectedOptionIds.length
        ? `Got it: ${answer.selectedOptionIds.map((id) => q.options.find((o) => o.id === id)!.label).join(", ")}.`
        : `Noted: "${answer.customText}".`;
    acks.push(ack);
    session.answers.push({ answer, patches: out.patches, acknowledgement: ack });
  }
  session.pending = [];
  const next = await gateTurn(session, deps);
  const done = next.some((e) => e.type === "ready");
  const events: ClarifyEvent[] = [
    { type: "clarification_applied", sessionId: session.sessionId, acknowledgement: `${acks.join(" ")}${done ? " I have enough information now. Running the comparison." : ""}`, briefDraft: session.brief },
    ...next,
  ];
  session.replies[key] = events;
  return { session, events, replayed: false };
}

/** The intent contract of the clarified brief, recompiled (what every screen will read). */
export function clarifiedContract(session: Session) {
  const b = LaunchBriefSchema.parse(session.brief);
  return compileIntent(b, marketById(b.marketId)!, { names: b.audienceAnchors, source: b.audienceAnchors.length ? "user" : "none" });
}
