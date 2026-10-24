import { z } from "zod";
import type { Architecture } from "./version";

/**
 * Domain types for a crash-test run. The whole decision history lives in one `RunState`:
 * the report and the UI are rendered from it, never reconstructed from model text.
 */

export const SLOTS = ["artist_music", "brand_collaboration", "event_place", "creative_direction"] as const;
export type Slot = (typeof SLOTS)[number];

export const SLOT_LABEL: Record<Slot, string> = {
  artist_music: "Music act",
  brand_collaboration: "Collaboration brand",
  event_place: "Pop-up venue",
  creative_direction: "Creative direction",
};

/** The Qloo entity type behind each entity slot. Creative direction is tested through tags. */
export const SLOT_TYPE: Record<Exclude<Slot, "creative_direction">, string> = {
  artist_music: "urn:entity:artist",
  brand_collaboration: "urn:entity:brand",
  event_place: "urn:entity:place",
};

export const DEPTHS = {
  quick: { maxRepairs: 3, maxQlooCalls: 700 },
  thorough: { maxRepairs: 6, maxQlooCalls: 1400 },
} as const;
export type Depth = keyof typeof DEPTHS;

export const ConstraintSchema = z.object({
  id: z.string(),
  description: z.string().trim().min(1).max(300),
  kind: z.enum(["hard", "soft"]),
  /** Machine-checked forms. A hard constraint without one is shown as not machine-checked. */
  lockSlot: z.enum(SLOTS).optional(),
  excludeNames: z.array(z.string().trim().min(1)).max(10).optional(),
});
export type Constraint = z.infer<typeof ConstraintSchema>;

export const LaunchBriefSchema = z.object({
  brandName: z.string().trim().max(80).optional(),
  productCategory: z.string().trim().min(2).max(120),
  launchGoal: z.string().trim().min(2).max(200),
  /** The user's own confirmed description, preserved so structured extraction cannot erase nuance. */
  sourceText: z.string().trim().max(4000).optional(),
  /** One of the supported market ids (src/lib/markets.ts). */
  marketId: z.string(),
  audienceDescription: z.string().trim().min(3).max(400),
  /** Names of brands or artists that stand for the audience. Optional: the agent proposes them. */
  audienceAnchors: z.array(z.string().trim().min(1)).max(4).default([]),
  brandAttributes: z.array(z.string().trim().min(1).max(120)).max(8).default([]),
  budgetBand: z.string().trim().max(60).optional(),
  existingChoices: z
    .array(z.object({ slot: z.enum(SLOTS), name: z.string().trim().min(1).max(120) }))
    .max(4)
    .default([]),
  constraints: z.array(ConstraintSchema).max(8).default([]),
  depth: z.enum(["quick", "thorough"]).default("quick"),
  /**
   * May the agent try better-supported alternatives to the user's own (unlocked) choices when
   * they are merely thin? On by default: a named choice is the user's current plan, not a hidden
   * lock. Replacement still has to pass the strict supported/material-improvement gates. A
   * per-choice lock always wins.
   */
  exploreUserChoices: z.boolean().default(true),
  /** Optional website, kept as metadata only: it is never fetched. */
  website: z.string().trim().max(200).optional(),
});
export type LaunchBrief = z.infer<typeof LaunchBriefSchema>;
export type LaunchBriefInput = z.input<typeof LaunchBriefSchema>;

/** The parts of a Qloo entity a plan keeps. */
export interface EntityRef {
  id: string;
  name: string;
  type: string | null;
  popularity: number | null;
  imageUrl: string | null;
  shortDescription: string | null;
}

export interface TagRef {
  id: string;
  name: string;
}

export interface Component {
  slot: Slot;
  /** What the plan calls it: the entity name, or the creative direction keywords. */
  label: string;
  origin: "user_provided" | "agent_proposed" | "agent_repair";
  locked: boolean;
  resolution: "resolved" | "ambiguous" | "not_found";
  entity: EntityRef | null;
  /** Creative direction only: the Qloo tags the direction was mapped to. */
  tags: TagRef[];
  /** For a pop-up venue: the place category it was tested in. */
  placeCategory: string | null;
  /** Ambiguous only: why Qloo's match is a different entity with the same name. */
  note?: string;
}

export interface CulturalPlan {
  anchors: EntityRef[];
  components: Component[];
}

// ---------- evidence ----------

export type Coverage = "usable" | "partial" | "empty" | "error";

export interface EvidenceItem {
  id: string;
  name: string;
  type?: string;
  rank?: number;
  affinity?: number;
  popularity?: number;
  /** Anchor or component ID → contribution, from Qloo's explainability. */
  explainability?: Record<string, number>;
}

export interface EvidenceRecord {
  evidenceId: string;
  iteration: number;
  purpose: string;
  queryKind: "search" | "entities" | "tags" | "insights" | "locality" | "adjudication" | "review";
  /** Parallel runs: which track or stage collected it ("shared", "user", "llm", "agent", …). */
  scope?: string;
  /** Parameters as sent, minus anything secret. Enough to reproduce the query. */
  sanitizedRequest: Record<string, unknown>;
  qlooEntityIds: string[];
  /** Top results only (the ledger is shown to people), with the queried item if present. */
  results: EvidenceItem[];
  /** How many results Qloo returned in total. */
  resultCount: number;
  coverageStatus: Coverage;
  warnings: string[];
  collectedAt: string;
}

// ---------- evaluation ----------

export const RUBRIC_VERSION = "crash-v1";
export const DIMENSIONS = ["audience", "local", "coherence", "distinct"] as const;
export type DimensionKey = (typeof DIMENSIONS)[number];
export const WEIGHTS: Record<DimensionKey, number> = {
  audience: 0.35,
  local: 0.3,
  coherence: 0.25,
  distinct: 0.1,
};
export const DIMENSION_LABEL: Record<DimensionKey, string> = {
  audience: "Audience affinity",
  local: "Local relevance",
  coherence: "Package coherence",
  distinct: "Distinctness",
};

export interface DimensionScore {
  key: DimensionKey;
  /** Undefined when there is no evidence; missing is never turned into 0. */
  score?: number;
  weight: number;
  evidenceIds: string[];
  explanation: string;
  /** Distinctness is our own heuristic, not a Qloo measure. */
  heuristic?: boolean;
}

export type ComponentStatus =
  | "supported"
  | "weak"
  | "no_support"
  | "unresolved"
  | "constraint_conflict";

export const STATUS_LABEL: Record<ComponentStatus, string> = {
  supported: "Supported",
  weak: "Weak evidence",
  no_support: "No support found",
  unresolved: "Unresolved",
  constraint_conflict: "Constraint conflict",
};

export interface ComponentAssessment {
  slot: Slot;
  label: string;
  status: ComponentStatus;
  total?: number;
  coverage: "adequate" | "partial" | "insufficient";
  dimensions: DimensionScore[];
  /** One line on the main reason for the status. */
  finding: string;
  /**
   * The evidence contradicts this choice (no support, a constraint conflict, or a global or
   * foreign import), so the agent should replace it. Thin evidence or a name Qloo doesn't know
   * is not a contradiction: those choices stay and are flagged for a human.
   */
  contradicted: boolean;
}

export interface PlanEvaluation {
  iteration: number;
  rubricVersion: string;
  /** Mean score of the components that have one. Read it with `supported` and `scored`. */
  totalScore?: number;
  /** Components that are Supported, out of all components. */
  supported: number;
  /** Components with a score at all (no-support and unresolved ones have none). */
  scored: number;
  /** Adjustable components the evidence contradicts. Zero means the plan is accepted. */
  contradicted: number;
  components: ComponentAssessment[];
  hardConstraintViolations: string[];
  /** Weakest unlocked component first; empty when nothing can be improved. */
  weakest: Slot[];
  accepted: boolean;
  materialImprovementFromPrevious?: number;
}

// ---------- changes and run ----------

/** Why a re-tested candidate was not kept. */
export type RejectionCode =
  | "no_improvement"
  | "target_not_supported"
  | "plan_regression"
  | "constraint_conflict"
  | "better_candidate_selected";

/** A candidate's full-plan re-test, as numbers: the source of truth the UI reads. */
export interface RetestResult {
  slotStatusBefore: ComponentStatus;
  slotStatusAfter: ComponentStatus;
  slotScoreBefore?: number;
  slotScoreAfter?: number;
  supportedBefore: number;
  supportedAfter: number;
  /** Components in the plan, for "2 of 4". */
  components: number;
  planScoreBefore?: number;
  planScoreAfter?: number;
  contradictedBefore: number;
  contradictedAfter: number;
  /** Other choices that were Supported before this re-test and are not after it. */
  lostSupported: Slot[];
  accepted: boolean;
  rejectionCode?: RejectionCode;
}

export interface PlanChange {
  iteration: number;
  slot: Slot;
  before: string;
  after: string;
  reason: string;
  triggeringEvidenceIds: string[];
  expectedEffect: string;
  /** A sentence for reports only; read `retest` for the facts. */
  observedEffect?: string;
  retest?: RetestResult;
  /** Set when the candidate was tested but not kept (worse, or another candidate tested better). */
  reverted?: boolean;
}

/** A ranked list a candidate can come from. v1 uses one combined list; v2 retrieves each intention separately. */
export type CandidateView = "combined" | "audience" | "local" | "coherence" | "proposals" | "neighborhood";

/** One candidate the agent considered for a choice: screened out, not picked, or re-tested. */
export interface CandidateTrial {
  iteration: number;
  slot: Slot;
  name: string;
  entityId?: string;
  source: "qloo_list" | "llm_proposal";
  evidenceIds: string[];
  /** Rank for this audience with the rest of the plan in the city (v1), or in the audience view (v2). */
  audienceRank?: number;
  /** v2: the candidate's rank in each view it appeared in, and its rank after reciprocal rank fusion. */
  views?: Partial<Record<CandidateView, number>>;
  fusedRank?: number;
  /** What the locality screen found ("from here", "just as big elsewhere", …). */
  localityResult?: string;
  /** Shared-role similarity with the original, 0–1, when there was an original to compare. */
  roleFit?: number;
  briefFit: "pass" | "fail" | "unknown";
  /** Set when the candidate never reached a re-test, with the recorded reason. */
  screenedOutReason?: string;
  retest?: RetestResult;
}

/** Where a result came from: run just now, or replayed from a recording. */
export interface RunProvenance {
  mode: "live" | "recorded";
  recordedAt?: string;
  runVersion: string;
}

/** What the run asked of Qloo, measured separately so none is mistaken for another. */
export interface QlooUsage {
  /** Logical operations the run asked for (what the budget counts). */
  checks: number;
  /** Repeats inside this run answered from the run's own memory. */
  reused: number;
  /** Answered from the server's shared cache. Present only when a cache was measured. */
  cacheHits?: number;
  /** Actual HTTP requests sent to Qloo. Present only when they were measured. */
  requests?: number;
}

export type StopReason =
  | "acceptance_criteria_met"
  | "no_material_improvement"
  | "iteration_limit"
  | "api_budget_limit"
  | "insufficient_data"
  | "user_cancelled"
  | "error";

export const STOP_LABEL: Record<StopReason, string> = {
  acceptance_criteria_met: "No adjustable choice is contradicted by the evidence",
  no_material_improvement: "Further repairs stopped improving the plan",
  iteration_limit: "Reached the repair-round limit",
  api_budget_limit: "Reached the Qloo call budget",
  insufficient_data: "Qloo has too little data to test this plan",
  user_cancelled: "Cancelled",
  error: "Stopped by an error",
};

export interface ActionRecord {
  iteration: number;
  kind: "find_alternatives" | "re_resolve" | "retest_direction";
  slot: Slot;
  why: string;
}

/** What a clarification session hands the run: the frozen brief's fingerprint and what it assumed. */
export interface RunClarification {
  sessionId: string;
  fingerprint: string;
  assumptions: string[];
  /** Material items left open (a delegated conflict, an unresolved identity): the result is provisional. */
  provisional: string[];
}

export interface RunState {
  runId: string;
  brief: LaunchBrief;
  /** The plain-words description the brief was read from, when there was one. */
  query?: string;
  marketLabel: string;
  initialPlan: CulturalPlan | null;
  plan: CulturalPlan | null;
  assumptions: string[];
  currentIteration: number;
  maxIterations: number;
  maxQlooCalls: number;
  qlooCallsUsed: number;
  llmCalls: number;
  evidenceLedger: EvidenceRecord[];
  evaluations: PlanEvaluation[];
  actions: ActionRecord[];
  changes: PlanChange[];
  /** Every candidate considered, per round, with its screening or re-test outcome. */
  trials?: CandidateTrial[];
  qlooUsage?: QlooUsage;
  provenance?: RunProvenance;
  unresolvedQuestions: string[];
  /** Names the agent tried and Qloo ruled out, per slot, so they aren't retried. */
  rejected: Partial<Record<Slot, string[]>>;
  stopReason?: StopReason;
  stopDetail?: string;
  /** The model's short verdict, written only from the recorded state. */
  verdict?: string;
  /** Absent in runs recorded before the parallel architecture existed: those are sequential. */
  architecture?: Architecture;
  /** Parallel runs only: the three tracks, the evidence matrix, adjudication and the final verdict. */
  parallel?: ParallelResult;
  /** The clarification session the brief came out of, when there was one. */
  clarification?: RunClarification & { fingerprintMatches: boolean };
  startedAt: string;
  finishedAt?: string;
}

export type RunEvent =
  | { type: "stage"; stage: string; message: string }
  | { type: "evidence"; record: EvidenceRecord }
  | { type: "plan"; plan: CulturalPlan; label: "initial" | "revised" }
  | { type: "evaluation"; evaluation: PlanEvaluation }
  | { type: "action"; action: ActionRecord }
  | { type: "change"; change: PlanChange }
  | { type: "budget"; qlooCallsUsed: number; maxQlooCalls: number }
  | { type: "done"; state: RunState }
  | { type: "error"; message: string };

// ---------- parallel three-track architecture ----------

/** Who produced a candidate plan. Display position is never identity: see `candidateId`. */
export type PlanTrack = "user" | "llm" | "agent" | "hybrid";
export const TRACK_LABEL: Record<PlanTrack, string> = {
  user: "You",
  llm: "LLM",
  agent: "Evidence-first agent",
  hybrid: "Hybrid",
};

/** Where one component of a candidate came from; "search" is the improvement loop's targeted search. */
export type ComponentSource = "user" | "llm" | "agent" | "search";
export const SOURCE_LABEL: Record<ComponentSource, string> = {
  user: "From you",
  llm: "From the LLM",
  agent: "From the evidence-first agent",
  search: "From a later targeted search",
};

/** A slot a candidate leaves open: the user didn't specify it, or the agent found nothing that passed its screens. */
export interface OpenSlot {
  slot: Slot;
  state: "not_specified" | "abstained";
  reason: string;
}

export interface CandidatePlan {
  /** Stable identity, e.g. "user", "llm", "agent", "agent-alt-1", "hybrid-2". */
  candidateId: string;
  track: PlanTrack;
  /** What the blind adjudicator sees instead of the track. Random per run, stable within it. */
  blindId: string;
  briefFingerprint: string;
  /** Only the components this candidate actually has; open slots are listed in `open`. */
  plan: CulturalPlan;
  open: OpenSlot[];
  sources: Partial<Record<Slot, ComponentSource>>;
  evaluation: PlanEvaluation | null;
  assumptions: string[];
  /** Hybrids and alternatives: the candidate they were built from. */
  parent?: string;
  provenance: { model?: string; qlooCalls: number; llmCalls: number; ms: number; generatedAt: string };
}

export const EVIDENCE_DIMENSIONS = [
  "constraint",
  "entity",
  "audience",
  "local",
  "coherence",
  "role_fit",
  "feasibility",
  "distinctiveness",
  "diversity",
  "coverage",
] as const;
export type EvidenceDimension = (typeof EVIDENCE_DIMENSIONS)[number];
export const EVIDENCE_DIMENSION_LABEL: Record<EvidenceDimension, string> = {
  constraint: "Constraint compliance",
  entity: "Entity correctness",
  audience: "Audience fit",
  local: "Local relevance",
  coherence: "Cross-slot coherence",
  role_fit: "Brief and role fit",
  feasibility: "Feasibility",
  distinctiveness: "Distinctiveness",
  diversity: "Diversity",
  coverage: "Evidence coverage",
};

export type EvidenceSource =
  | "user"
  | "constraint"
  | "qloo_affinity"
  | "qloo_locality"
  | "qloo_coherence"
  | "qloo_explainability"
  | "entity_metadata"
  | "logical_rubric"
  | "official_source"
  | "human"
  | "counterfactual";

/** A claim supports, contradicts, or can't say. Unknown is never turned into either. */
export type ClaimStance = "supports" | "contradicts" | "unknown";

/** Layer 6: what a person should make of one component. */
export type ComponentState = "supported" | "plausible_thin" | "conflicting" | "unverified" | "needs_human" | "rejected";
export const COMPONENT_STATE_LABEL: Record<ComponentState, string> = {
  supported: "Supported",
  plausible_thin: "Plausible but thin",
  conflicting: "Conflicting evidence",
  unverified: "Unverified",
  needs_human: "Needs human confirmation",
  rejected: "Rejected",
};

export interface EvidenceClaim {
  claimId: string;
  candidateId: string;
  slot?: Slot;
  dimension: EvidenceDimension;
  claim: string;
  stance: ClaimStance;
  source: EvidenceSource;
  /** Ledger records behind the claim; may be empty only when `ruleId` names the rule that made it. */
  evidenceIds: string[];
  /** The declared rule that produced the claim (logical and constraint claims always have one). */
  ruleId?: string;
  strength: "strong" | "moderate" | "thin" | "unknown";
  limitations: string[];
}

export interface EvidenceMatrix {
  rubricVersion: string;
  candidateIds: string[];
  claims: EvidenceClaim[];
  /** Share of the measurable checks (audience, local, coherence per component) that returned evidence. */
  coverageByCandidate: Record<string, number>;
  /** Components present, out of all slots. Kept apart from coverage: an unspecified slot isn't a failure. */
  completenessByCandidate: Record<string, number>;
  /** Deterministic vetoes. A candidate with any can't win. */
  hardFailures: Record<string, string[]>;
  componentStates: Record<string, Partial<Record<Slot, ComponentState>>>;
}

/** One order-specific blind judgment, resolved from blind IDs to candidate IDs in code. */
export interface BlindJudgment {
  /** Blind IDs in the order they were shown. */
  order: string[];
  verdict: "winner" | "tie" | "insufficient_evidence";
  winnerCandidateId: string | null;
  decisiveClaimIds: string[];
  counterevidenceClaimIds: string[];
  dimensionWinners: Partial<Record<EvidenceDimension, string[]>>;
  rationale: string;
  /** The ledger record of this judgment. */
  evidenceId: string;
  /** False when the judge's answer couldn't be used (unknown ID, missing claims); it then counts as no verdict. */
  valid: boolean;
  problem?: string;
}

export interface AdjudicationResult {
  stage: "initial" | "final";
  candidateIds: string[];
  /** Candidates removed by deterministic hard gates before the judge saw anything. */
  eliminated: Record<string, string[]>;
  /** Candidates with exactly the same choices as another, judged once as that one (duplicate → kept ID). */
  merged: Record<string, string>;
  winnerCandidateId: string | null;
  verdict: "winner" | "tie" | "unstable" | "insufficient_evidence";
  dimensionWinners: Partial<Record<EvidenceDimension, string[]>>;
  rationale: string;
  decisiveClaimIds: string[];
  counterevidenceClaimIds: string[];
  orderResults: BlindJudgment[];
  /** Wording removed because it claimed sales, attendance or other outcomes the evidence can't show. */
  flagged: string[];
  /** The deterministic evidence ordering, best first, shown beside the judge's verdict. */
  evidenceOrder: string[];
}

export type ChallengeKind = "constraint" | "weak_evidence" | "incoherent" | "better_alternative" | "unsupported_claim";

export interface ChallengeFinding {
  kind: ChallengeKind;
  candidateId: string;
  slot?: Slot;
  detail: string;
  claimIds: string[];
  /** better_alternative: the candidate whose component tested better. */
  alternativeFrom?: string;
}

export interface HybridAttempt {
  candidateId: string;
  parent: string;
  /** "challenge": the agent's own substitution for its weakest choice (parallel:v3). */
  kind: "union" | "swap" | "search" | "challenge";
  slot?: Slot;
  accepted: boolean;
  rejectionCode?: RejectionCode | "duplicate" | "hard_failure" | "locked" | "brief_fit_lost" | "repeated_plan" | "generic_bundle";
  reason: string;
  retest?: {
    supportedBefore: number;
    supportedAfter: number;
    contradictedBefore: number;
    contradictedAfter: number;
    lostSupported: Slot[];
    violationsBefore: number;
    violationsAfter: number;
    /** Supporting brief-fit claims (role fit, user intent) before and after. */
    briefFitBefore?: number;
    briefFitAfter?: number;
  };
}

export interface ImprovementRound {
  round: number;
  incumbent: string;
  challenges: ChallengeFinding[];
  attempts: HybridAttempt[];
  accepted?: string;
  /** The agent's challenge rounds: the failure it set out to fix, from recorded claims. */
  hypothesis?: { slot: Slot; claimIds: string[]; statement: string };
}

/** One candidate the evidence agent pooled for a slot, with where it came from and how each screen read it. */
export interface PoolRecord {
  slot: Slot;
  name: string;
  entityId?: string;
  source: "qloo" | "user";
  /** Rank in each Qloo view it appeared in. */
  views: Partial<Record<CandidateView, number>>;
  lanes: ("affinity" | "locality" | "brief_fit")[];
  screens: { role: string; locality: string; /** Fit to a neighbourhood the brief names, when it names one. */ hood?: "near" | "outside" | "far" | "unknown"; brief: string; distinct: string; central: string; notes: string[] };
  /** "pool" (composed into bundles), "reserve" (kept for the challenge loop) or why it was dropped. */
  outcome: string;
  evidenceIds: string[];
}

/** What the single evidence agent did (parallel:v3). */
export interface AgentRecord {
  contract: import("./intent").IntentContract;
  beamWidth: number;
  pools: PoolRecord[];
  bundlesTested: number;
  rounds: ImprovementRound[];
  stop: "no_weakness" | "no_improvement" | "no_alternative" | "repeated_plan" | "round_limit" | "budget";
  /** screens:v4: what the agent's own screens say against the plan it kept. */
  selection?: import("./agent").SelectionFlags;
}

export interface FinalVerdict {
  candidateId: string | null;
  track: PlanTrack | null;
  verdict: AdjudicationResult["verdict"];
  /** Both final orders agreed and no hard gate overrode the judge. */
  stable: boolean;
  /** "adjudication": the blind judge decided. "evidence_order": no stable verdict, so the deterministic order is shown and flagged for a person. */
  decidedBy: "adjudication" | "evidence_order" | "none";
  /** No stable blind verdict: the plan shown leads only on the evidence order and is for a person to confirm, not a winner. */
  provisional: boolean;
  plan: CulturalPlan | null;
  open: OpenSlot[];
  evaluation: PlanEvaluation | null;
  sources: Partial<Record<Slot, ComponentSource>>;
  bestSupportedComponents: { slot: Slot; label: string; candidateId: string; status: ComponentStatus }[];
  userChoicesPreserved: { slot: Slot; label: string; locked: boolean; preserved: boolean }[];
  assumptionsIntroduced: string[];
  evidenceLimitations: string[];
  rejectedAlternatives: { candidateId: string; reason: string }[];
  humanChecks: string[];
}

export interface TrackUsage {
  ms: number;
  qlooChecks: number;
  llmCalls: number;
}
export type UsageScope = "shared" | "user" | "llm" | "agent" | "adjudication" | "improvement";

export interface ParallelResult {
  architectureVersion: string;
  baseRubricVersion: string;
  evidenceRubricVersion: string;
  adjudicationVersion: string;
  briefFingerprint: string;
  /** Who chose the audience anchors every track is measured against. */
  anchorSource: "user" | "model_hypothesis" | "none";
  anchorNotes: string[];
  candidates: CandidatePlan[];
  matrix: EvidenceMatrix;
  initial: AdjudicationResult;
  rounds: ImprovementRound[];
  final: AdjudicationResult;
  verdict: FinalVerdict;
  usage: Record<UsageScope, TrackUsage>;
  /** parallel:v3: the single evidence agent's pools, bundles and challenge rounds. */
  agent?: AgentRecord;
  /** parallel:v3: what fixed the run's behaviour, frozen with it. */
  config?: RunConfig;
}

export interface RunConfig {
  model: string;
  ranking: string;
  contractVersion: string;
  screensVersion: string;
  beamWidth: number;
  challengeRounds: number;
  maxQlooCalls: number;
  /** SHA-256 of the system prompts the run used, so a prompt change shows. */
  promptsFingerprint: string;
  /** The provider doesn't expose temperature or a seed here; outputs are not deterministic. */
  sampling: string;
  /** Where the run's audience anchors were frozen from, when they were. */
  anchorsFrozenFrom?: string;
}
