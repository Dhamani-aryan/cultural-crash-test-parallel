# Parallel v6 targeted result

**Date:** 24 October 2026  
**Run tag:** `parallel-v6-targeted-r1`  
**Run version:** `crash:v15+parallel:v6`  
**Scenario:** `upcycled-denim-tokyo` only  
**Audience anchors:** frozen from parallel v2

## Why only one scenario ran

The v4 trace audit identified a false entity-level contradiction in this scenario: “without mixing unrelated fashion and music references” had been reduced to “avoid fashion.” v6 changes only that class of relational free-text rule, so no other live scenario was needed to validate it.

## Result

- Supported choices: **2/4 → 3/4**.
- Winner: evidence-first agent.
- Plan: Harunemuri; Beams; MONKEY CAFE / MONKEY GALLERY; a crafted, nostalgic denim workshop direction.
- Blind-order checks: **2/2 preserved**.
- Model calls: **12**.
- Outbound Qloo requests: **265**.
- The false Beams/fashion contradiction is gone.
- One explicit contradiction remains: the venue is 2.6 km outside Shimokitazawa.

## Honest decision

This is a better and more internally consistent result, but it is not a fully validated recommendation. The stable ordering means both blind presentations selected the same leading plan; it does not erase the neighbourhood conflict. The UI and stored final-verdict logic now label a leading plan with any explicit brief contradiction **Provisional**, even when its blind ordering is stable.

Do not run another scenario for this fix. The remaining venue trade-off is already visible and correctly calibrated. A future product improvement would require either a verified in-neighbourhood candidate or explicit user acceptance of leaving Shimokitazawa—not another identical agent loop.

