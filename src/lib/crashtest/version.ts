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

/**
 * The parallel engine's own version, recorded beside RUN_VERSION. v2: the user's named acts and
 * brands get namesake protection in every track (v1 could test a user's "Divine" as the wrong one).
 * v3: one evidence agent, independent of the user's unlocked choices, pools diverse Qloo candidates
 * per slot, screens them against the brief-intent contract, tests complete plans by bounded beam
 * search, challenges its own weakest choice, and an unstable verdict is shown as provisional.
 * v4: the final recommendation is stress-tested against blind order and leave-one-audience-anchor-out
 * re-evaluations; a reversal is surfaced as provisional instead of hidden behind a single verdict.
 * v5: explicit brief contradictions and structured role doubts rank ahead of raw affinity, so
 * several unrelated positive claims cannot hide one narratively wrong component.
 * v6: relational free-text rules remain coherence questions instead of being misread as lexical
 * bans on every noun they contain.
 * v7: a bounded official-source venue check can veto a concrete operational contradiction after
 * the cultural comparison; it cannot award cultural fit or invent live availability.
 * v8: a venue veto re-tests one bounded mixed plan so unrelated agent improvements are not lost;
 * equally thin user and agent choices are presented as workable options for a logistics decision.
 * v9: the agent starts from what the marketer plainly named: it keeps those choices unless one
 * concretely can't do its job, ranks plans by the judge's first priority, spends its challenge
 * rounds on the slots it fills, and proposes its own candidates for an open slot, each verified in
 * Qloo and screened like any other. The role check calls a choice wrong only for a concrete reason,
 * a bare "in Bushwick" counts as a neighbourhood once Qloo confirms it, and a venue's district is
 * never an operational veto.
 * v10: the web check reads every finalist's venue (up to four) and records cited fit facts: the
 * right kind of place, inside the named area, open to the guests. A finalist whose venue has fewer
 * such concerns, and keeps as many named choices, is preferred; the facts only choose among plans
 * that passed the blind comparison and never add a venue or rewrite a cultural score.
 * v11: before committing, the agent runs the same cited web fit check on its own top venues and may
 * move to another of its tested plans that is equally strong on rules, locks, named choices and
 * completeness, with fewer cited venue concerns. It never leaves a venue the user named.
 * v12: when the brief names a neighbourhood, the agent ranks a venue Qloo files under it above one
 * that is only within 2 km of its centre, and both above venues further out; that closeness counts
 * before soft host doubts when it picks among its plans, so a better-typed venue across town no
 * longer beats one in the named area.
 */
export const PARALLEL_VERSION = "parallel:v12";
/**
 * The structured evidence-claim rules (evidence matrix). v2: the brief-intent contract's screens
 * (host fit, neighbourhood, requested distinctiveness, product centrality, avoided qualities,
 * structured role readings), weighted user preferences, and the v3 plan-comparison order, in
 * which distinctiveness ranks plans only when the brief asks for it. v3: a venue Qloo files under
 * the named neighbourhood is in it, and coordinates are read where Qloo returns them. v4: the
 * named neighbourhood ranks with brief fit, above audience affinity, and 2–6 km from it is outside it.
 * v5: minimize explicit brief contradictions and structured role doubts before positive fit and
 * affinity; positive claims can no longer cancel a material mismatch in another slot.
 * v6: only lexically verifiable avoidances become entity-level claims; relational free-text rules
 * such as "don't mix unrelated fashion and music" are not reduced to "avoid fashion".
 * v7: official operational evidence replaces the venue-feasibility unknown when available and a
 * verified conflict becomes a deterministic hard gate.
 */
export const EVIDENCE_RUBRIC_VERSION = "evidence:v7";
/** The blind, order-rotated adjudication protocol. v2 gives contradictions and role doubts priority over affinity. */
export const ADJUDICATION_VERSION = "adjudicate:v2";

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
