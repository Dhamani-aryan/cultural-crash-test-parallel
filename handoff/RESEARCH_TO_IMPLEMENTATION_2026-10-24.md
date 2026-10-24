# Research-to-implementation decision

**Input reviewed:** `C:\Users\dhama\Downloads\CULTURAL_CRASH_TEST_AGENT_RESEARCH.md`  
**Date:** 24 October 2026

## Outcome

The research largely validates the current architecture. The project already has the high-value pieces: independent tracks, typed Qloo access, entity resolution, a recorded evidence ledger, structured supported/contradicted/unknown claims, bounded candidate search and repair, explicit stop conditions, blind order-swapped adjudication, frozen anchors, and finalist stability checks.

The right next step is not LangGraph, DSPy, GEPA, a vector database, or multiple agents. Those would add machinery before the remaining decision errors are understood. The observed failures are narrower: role fit, brief contradictions, judge instability, anchor sensitivity, and genuine data coverage gaps.

## Implemented from the research

1. **CRITIC / evidence-first correction:** explicit brief contradictions and structured role doubts now rank ahead of raw affinity. Several unrelated positive claims cannot cancel one material mismatch.
2. **Consistent typed screens:** the strict venue-role screen is shared by agent selection and the evidence matrix. A restaurant, shop, or nightlife venue is not described as a requested gallery/showroom merely because it can host events.
3. **Calibrated judging:** the blind judge is told to minimize contradictions and role doubts before affinity and to return a tie when evidence does not separate plans.
4. **Trajectory-aware failure taxonomy:** `npm run eval:failures -- <tag>` classifies saved traces without any model or Qloo calls and selects a small representative set using deterministic greedy set cover.
5. **Regression tests:** stable improving scenarios are excluded; semantic, stability, anchor, zero-support and provider-error patterns are classified from the saved state.

## New evaluation policy

Do not rerun all 15 scenarios while developing a failure fix.

1. Write a deterministic unit/regression test for the observed pattern.
2. Run the offline failure selector on the most recent saved tag.
3. Choose at most one live representative directly affected by the change.
4. Rerun a stable control only when the change could plausibly affect that control.
5. Run the full frozen suite once, only after the targeted case improves and all local validation passes.
6. Treat provider/network errors as retryable infrastructure failures, not recommendation outcomes.
7. Treat persistent zero-support results as coverage gaps; do not spend repeated model calls trying to manufacture support.

## v5 sentinel evidence so far

The second sentinel was intentionally stopped before rerunning Sydney. Six completed rows showed:

- Stable improving cases: New York speakeasy 0→3; London luxury 0→3; Tokyo eyewear 2→3; Mexico City 0→2.
- Tokyo eyewear changed from an affinity-led tea venue to a stable hybrid retaining **Spiral**, showing the shared venue-role rule changed the intended failure.
- Upcycled Tokyo reached 4/4 support but remained blind-order unstable and still carried a brief contradiction; it is not solved.
- Mumbai accessories remained 0/4; it is a coverage gap, not a reason to repeat the same run.

The selector reduced those six rows to three representatives for the remaining pattern classes: `accessories-mumbai`, `upcycled-denim-tokyo`, and `eyewear-tokyo`. Eyewear needs no immediate rerun unless role-uncertainty logic changes again; Mumbai needs a product decision about abstention/low-confidence presentation, not more search.

## Deferred ideas

- **Qloo profile comparison:** the client supports `/v2/analysis/compare`, but adding calls is deferred until one current failure has a concrete hypothesis that this endpoint can answer.
- **Reflexion memory:** keep verified failure fixtures and traces, not free-form model “lessons” injected into every run. The deterministic taxonomy is the first safe slice.
- **LATS:** the current bounded beam and challenge loop already supplies the useful lightweight form. Full tree search would spend more calls without evidence of benefit.
- **GEPA/DSPy:** only after the human-reviewed benchmark is complete and a held-out metric exists.
- **Promptfoo:** optional packaging for CI later; the current Vitest and eval harness already enforce the important behavior.

## Remaining product decisions

1. A final plan with zero supported choices should be labelled **insufficient Qloo evidence**, even if its internal ordering is stable.
2. A stable verdict can still contain feasibility unknowns; the UI must keep those as human checks rather than imply availability.
3. The blinded human-review sheet must be completed before opening its key or making a final accuracy claim.

The detailed offline failure analysis is in `handoff/FAILURE_PATTERN_AUDIT_2026-10-24.md`.

