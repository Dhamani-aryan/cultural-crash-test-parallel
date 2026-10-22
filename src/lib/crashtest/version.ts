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
