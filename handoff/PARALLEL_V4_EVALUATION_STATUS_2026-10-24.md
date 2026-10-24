# Parallel v4 final evaluation

**Date:** 24 October 2026  
**Run tag:** `parallel-v4-final-r1`  
**Run version:** `crash:v15+parallel:v4`  
**Audience anchors:** frozen from `parallel-v2 (crash:v15+parallel:v2)`

## Decision

Do **not** promote v4 as the final recommendation engine. The full run completed with 15 valid scenarios and no infrastructure errors, but it failed the pre-declared promotion gates. Keep its stability audit; continue improving the selection policy from the observed failure patterns.

The retry automation has been paused because the run is complete.

## Full results

- Initial → final supported choices: **18 → 40 of 60**.
- Improved: **13/15**; unchanged: **2/15**; regressed: **0/15**.
- Final track: agent **13**, hybrid **2**, LLM **0**, user **0**.
- Stable: **10/15**; provisional: **5/15**.
- Stability checks: **61/68 preserved**, **5 blind-order reversals**, **2 anchor-dropout reversals**.
- Qloo requests: **3,502**; model calls: **202**.
- Hard-constraint violations: **0**; locked choices preserved.
- One zero-support final plan: `accessories-mumbai`.

Against the frozen v2 baseline, v4 had **40/60** supported choices versus **45/60** for v2. In the blinded v4-versus-v2 comparison, v4 won 4, v2 won 2, and 9 tied, with 9 order disagreements. Against its own LLM-only plan, the no-evidence intuitive judge preferred the agent once, the LLM 12 times, and tied twice. This exposes a real product weakness: stronger affinity evidence did not always produce a more narratively coherent brief fit.

## Failure patterns

The repeated failures were not city-wide accuracy failures. They were specific decision-policy failures:

1. A role-doubtful venue could win because several affinity/locality claims outweighed the doubt.
2. One explicit avoided-quality or neighbourhood contradiction could be averaged away by unrelated positive claims.
3. Generic or corporate collaborators could outscore locally coherent choices.
4. The agent sometimes changed a reasonable user/LLM choice without enough narrative benefit.
5. Mumbai accessories exposed a Qloo coverage gap; more looping did not create evidence.

These findings motivated the bounded v5 experiment. They do not justify rerunning stable scenarios after every change.

## Artifacts

- `eval/out/final-report-parallel-v4-final-r1.md`
- `eval/out/final-report-parallel-v4-final-r1.json`
- `eval/out/final-human-review-parallel-v4-final-r1.json`
- The separate `-key.json` remains unopened until human review is complete.
