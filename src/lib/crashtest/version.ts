/**
 * The agent's behaviour version. Bump it when the agent, rubric or prompts change in a way that
 * should invalidate recordings and frozen evaluation baselines.
 */
export const RUN_VERSION = "crash:v15";

/** How repair candidates are retrieved and ranked. v2 is the multi-view, rank-fused experiment. */
export type Ranking = "v1" | "v2";
export const DEFAULT_RANKING: Ranking = "v1";

/** The ranking a run uses: the explicit option, else RECOMMENDATION_RANKING, else the default. */
export function rankingFrom(option?: Ranking): Ranking {
  if (option) return option;
  const env = typeof process !== "undefined" ? process.env.RECOMMENDATION_RANKING : undefined;
  return env === "v2" || env === "v1" ? env : DEFAULT_RANKING;
}

/**
 * How a run is organised. "sequential" is the control: the LLM drafts, then the agent repairs
 * that draft. "parallel" builds a user plan, an LLM-only plan and an evidence-first agent plan
 * independently, then adjudicates them blind. The sequential engine stays the default until the
 * parallel one wins the agreed evaluation.
 */
export type Architecture = "sequential" | "parallel";
export const DEFAULT_ARCHITECTURE: Architecture = "sequential";

/** The parallel engine's own version, recorded beside RUN_VERSION. */
export const PARALLEL_VERSION = "parallel:v1";
/** The structured evidence-claim rules (evidence matrix). */
export const EVIDENCE_RUBRIC_VERSION = "evidence:v1";
/** The blind, order-rotated adjudication protocol. */
export const ADJUDICATION_VERSION = "adjudicate:v1";

/** The architecture a run uses: the explicit option, else RECOMMENDATION_ARCHITECTURE, else the default. */
export function architectureFrom(option?: Architecture): Architecture {
  if (option) return option;
  const env = typeof process !== "undefined" ? process.env.RECOMMENDATION_ARCHITECTURE : undefined;
  return env === "parallel" || env === "sequential" ? env : DEFAULT_ARCHITECTURE;
}

/** The version a run records: the control's, or the parallel engine's on top of it. */
export function runVersionFor(architecture: Architecture): string {
  return architecture === "parallel" ? `${RUN_VERSION}+${PARALLEL_VERSION}` : RUN_VERSION;
}
