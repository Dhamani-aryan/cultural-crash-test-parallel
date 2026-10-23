import { z } from "zod";
import { EVENT_FORMATS } from "@/lib/crashtest/intent";
import { SLOTS } from "@/lib/crashtest/types";

/**
 * The conversational clarification gate (P0: policy and fixtures). Between "run" and the U/L/A
 * generation, the gate decides whether one or two unresolved decisions could materially change
 * the recommendation. Code decides; a model may only propose. Every answer, including "Decide for
 * me", maps to a deterministic patch on the structured brief, and every assumption is recorded.
 */
export const CLARIFY_VERSION = "clarify:v1";

/** At most two clarification turns and three questions in total; one question per turn by default. */
export const CLARIFY_BUDGET = { maxTurns: 2, maxQuestions: 3, maxPerTurn: 2, defaultPerTurn: 1 } as const;

export const CLARIFICATION_REASONS = ["conflict", "entity_identity", "choice_strength", "geography", "event_format", "tradeoff", "rule_meaning"] as const;
export type ClarificationReason = (typeof CLARIFICATION_REASONS)[number];

/** Ask in this order when several questions qualify (lower first). */
export const REASON_PRIORITY: Record<ClarificationReason, number> = {
  conflict: 1,
  rule_meaning: 1,
  entity_identity: 2,
  choice_strength: 3,
  geography: 4,
  event_format: 4,
  tradeoff: 5,
};

const Slot = z.enum(SLOTS);

/** A deterministic change to the structured brief. The user's original message is never edited. */
export const BriefPatchSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("choice_strength"), slot: Slot, name: z.string(), strength: z.enum(["locked", "preferred", "considered", "example"]) }),
  z.object({ kind: z.literal("geography"), place: z.string(), strictness: z.enum(["required", "nearby", "city"]) }),
  z.object({ kind: z.literal("event_format"), format: z.enum(EVENT_FORMATS) }),
  z.object({ kind: z.literal("priority"), keep: z.string(), over: z.string() }),
  z.object({ kind: z.literal("identity"), slot: Slot, name: z.string(), meaning: z.enum(["as_described_by_user", "qloo_match", "unresolved"]), country: z.string().optional() }),
  z.object({ kind: z.literal("quality"), quality: z.string(), polarity: z.enum(["required", "preferred", "avoid"]) }),
  z.object({ kind: z.literal("rule_meaning"), rule: z.string(), meaning: z.string() }),
  z.object({ kind: z.literal("assumption"), text: z.string() }),
]);
export type BriefPatch = z.infer<typeof BriefPatchSchema>;

export const ClarificationOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  value: z.string(),
  /** Internal/audit text: what choosing it does. Not generic UI microcopy. */
  consequence: z.string(),
  patches: z.array(BriefPatchSchema),
});
export type ClarificationOption = z.infer<typeof ClarificationOptionSchema>;

export const ClarificationQuestionSchema = z.object({
  id: z.string(),
  reason: z.enum(CLARIFICATION_REASONS),
  prompt: z.string(),
  inputKind: z.enum(["single_choice", "multi_choice", "free_text"]),
  options: z.array(ClarificationOptionSchema),
  allowCustom: z.literal(true),
  allowDelegate: z.literal(true),
  affectedSlots: z.array(Slot),
  sourcePhrases: z.array(z.string()),
  materialEffect: z.string(),
  delegatedAssumption: z.string(),
  /** What "Decide for me" applies; recorded as an assumption. */
  delegatedPatches: z.array(BriefPatchSchema),
  /** Delegating leaves a material uncertainty open: the result must be provisional. */
  delegationIsProvisional: z.boolean(),
});
export type ClarificationQuestion = z.infer<typeof ClarificationQuestionSchema>;

export const ClarificationAnswerSchema = z.object({
  questionId: z.string(),
  selectedOptionIds: z.array(z.string()).default([]),
  customText: z.string().max(500).optional(),
  delegated: z.boolean().default(false),
  answeredAt: z.string(),
});
export type ClarificationAnswer = z.infer<typeof ClarificationAnswerSchema>;

/** Which material conditions an uncertainty meets (any one makes it askable, see isMaterial). */
export const EffectsSchema = z.object({
  /** Interpretations produce different eligible candidate sets. */
  eligibility: z.boolean(),
  /** Interpretations produce different locked/preferred/open states or hard/soft constraints. */
  constraintState: z.boolean(),
  /** Interpretations change the required venue or event role. */
  eventRole: z.boolean(),
  /** Interpretations can reverse the ordering of two viable complete-plan directions. */
  winnerOrder: z.boolean(),
  /** Choosing silently risks the wrong real-world entity. */
  identity: z.boolean(),
});
export type Effects = z.infer<typeof EffectsSchema>;

/** The audit record for every proposed uncertainty, asked or not. */
export const UncertaintySchema = z.object({
  id: z.string(),
  reason: z.enum(CLARIFICATION_REASONS),
  what: z.string(),
  /** The brief phrases that created it, word for word. */
  sourcePhrases: z.array(z.string()),
  affectedSlots: z.array(Slot),
  interpretations: z.array(z.object({ label: z.string(), consequence: z.string(), patches: z.array(BriefPatchSchema) })).min(2),
  multi: z.boolean().default(false),
  effects: EffectsSchema,
  safeDefault: z.object({ assumption: z.string(), patches: z.array(BriefPatchSchema), provisional: z.boolean() }),
  origin: z.enum(["deterministic", "model"]),
  confidence: z.enum(["high", "medium", "low"]),
  limitations: z.array(z.string()),
  /** The concise question, when it is asked. */
  prompt: z.string(),
});
export type Uncertainty = z.infer<typeof UncertaintySchema>;

/** Something the brief already settles without asking ("booked" → a lock). */
export interface Resolution {
  patches: BriefPatch[];
  because: string;
  sourcePhrase: string;
}

/** The identity facts preflight gathered: a named act or brand Qloo knows only as a namesake. */
export interface IdentityFact {
  slot: (typeof SLOTS)[number];
  name: string;
  /** Where the brief or the model says the named one is from. */
  expectedCountry?: string;
  /** How Qloo describes the namesake it found (never another candidate's name). */
  qlooDescription: string;
}

export interface GateBudget {
  turnsUsed: number;
  questionsAsked: number;
}

export interface GateResult {
  version: string;
  decision: "ready" | "clarify";
  questions: ClarificationQuestion[];
  resolutions: Resolution[];
  /** Assumptions applied now (budget exhausted, or not material enough to ask). */
  assumptions: string[];
  /** The patches those assumptions stand for, applied to the brief with them. */
  assumedPatches: BriefPatch[];
  /** Material uncertainties left for the next turn, within the budget. */
  deferred: string[];
  /** Material uncertainties that stay open: the result must be marked provisional. */
  provisional: string[];
  audit: { id: string; reason: ClarificationReason; origin: Uncertainty["origin"]; outcome: "asked" | "deferred" | "assumed" | "dropped"; why: string }[];
  generator: "ok" | "failed" | "skipped";
}

/** Session state as the plan specifies it (P1 adds the state machine that drives it). */
export interface ClarificationSession {
  sessionId: string;
  state: "understanding" | "awaiting_clarification" | "ready" | "running" | "complete";
  originalMessage: string;
  questionsAsked: ClarificationQuestion[];
  answers: ClarificationAnswer[];
  assumptions: string[];
  turnsUsed: number;
  clarifiedBriefFingerprint?: string;
}
