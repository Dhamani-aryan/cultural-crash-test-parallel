# Parallel v4 evaluation status

**Date:** 24 October 2026  
**Run tag:** `parallel-v4-final-r1`  
**Run version:** `crash:v15+parallel:v4`  
**Audience anchors:** frozen from `parallel-v2 (crash:v15+parallel:v2)`

## Status

The promotion run is incomplete because the ChatGPT Plus model provider returned `usage_limit_reached` after four scenarios. Those 11 rows are infrastructure failures, not recommendation outcomes, and must not be included in accuracy or win-rate claims. The runner preserved each error honestly and did not manufacture plans.

An active Codex heartbeat named **Complete v4 evaluation** will retry only the failed scenario IDs after the usage window clears. It must not rerun the four valid cases or overwrite a frozen baseline.

## Valid results so far

| Scenario | Supported choices | Final track | Blind verdict | Stability audit |
|---|---:|---|---|---|
| Streetwear — New York | 1 → 2 | Agent | Winner, stable | 5/5 preserved |
| Speakeasy — New York | 1 → 3 | Agent | Winner, stable | 5/5 preserved |
| Luxury handbags — London | 0 → 3 | Agent by evidence order | Unstable, provisional | 3/5 preserved; two blind-order reversals; all three anchor dropouts preserved |
| Non-alcoholic aperitivo — London | 1 → 2 | Agent | Winner, stable | 5/5 preserved |

Partial aggregate (four valid cases only):

- supported choices: **3 → 10**;
- final agent track: **4/4**;
- stable non-provisional verdicts: **3/4**;
- recorded checks preserved: **18/20**;
- anchor-dropout reversals: **0**;
- blind-order reversals: **2**, both in the London luxury case;
- outbound Qloo requests: **863**;
- model calls: **52**.

These figures are promising but are not the final 15-scenario result.

## Concrete finding

The London luxury case proves the stability layer is doing useful work. The two blind orders selected different plans, while the evidence-order recommendation survived all three audience-anchor removals. The UI correctly presents it as a **Provisional plan** and asks for human review instead of claiming a stable winner.

During review, one duplicate human check was found: order instability also produced an audience-definition warning even though no anchor-dropout check reversed. The controller now adds the audience warning only for actual anchor-dropout reversals; order instability keeps its own targeted warning.

## Promotion gate still required

1. Complete the remaining 11 scenarios under the same tag and frozen anchors.
2. Exclude every provider or infrastructure error from outcome metrics.
3. Inspect every unstable, tied, provisional, budget-limited, or support-regressing case.
4. Complete the blinded human review before opening its key.
5. Compare v4 with `scenario-summary-parallel-v3-final-r1.json` on support, judge preference, stability, failures and cost.
6. Promote v4 only if the full evidence is favorable; otherwise keep the v3 baseline and retain the stability audit as an experimental branch.
