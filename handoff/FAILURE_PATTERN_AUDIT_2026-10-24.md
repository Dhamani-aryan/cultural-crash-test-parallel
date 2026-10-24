# Failure-pattern audit

**Source:** saved `parallel-v4-final-r1` traces; no new model or Qloo calls  
**Scope:** 15 completed scenarios, 60 final choices

## Main finding

The system is not failing uniformly by city. Its meaningful failures cluster around semantic interpretation—especially venue role and free-text constraints.

All five provisional v4 scenarios contained at least one of:

- a structured venue-role doubt;
- an explicit or alleged brief contradiction;
- blind-order or audience-anchor sensitivity caused by those close semantic decisions.

The ten stable scenarios did not show that same combination. This is a much narrower problem than “agent accuracy” generally and does not justify repeatedly running all scenarios.

## Observed patterns

### 1. Venue role is the highest-risk slot

Four of five provisional cases had a role-doubtful venue:

- London luxury: The Harcourt was a pub/wedding venue with no established gallery fit.
- Tokyo eyewear: Sakurai Japanese Tea Experience had strong affinity but uncertain exhibition/music-session fit.
- Tokyo denim: MONKEY CAFE / MONKEY GALLERY could host displays, but its workshop/community fit was uncertain.
- Mexico City cocktail bar: Casa Basalta lacked enough facts and could overshadow the product.

Response: v5/v6 use the same strict host screen for agent selection and shared adjudication. Role doubts rank before affinity.

### 2. A lexical rule misread created a false contradiction

The Tokyo denim brief said not to mix **unrelated fashion and music references**. The old lexical screen extracted “fashion” and marked Beams contradictory simply because Qloo described it as fashion. That interpretation was not justified: the rule concerns the relationship between choices, not a ban on fashion.

Response: v6 treats relational negatives—mixing, unrelated references, “relying on,” “feeling like,” and afterthought constructions—as coherence questions. They no longer become entity-level lexical bans. Directly stated avoidances such as “avoid the beach-party aesthetic” remain screenable.

### 3. Genuine explicit contradictions correlate with instability

- Sydney selected entities described with “beach” despite an explicit request to avoid the usual beach-party aesthetic.
- Tokyo denim selected a venue outside the named neighbourhood.
- Mexico City contained a model-recorded product-centrality contradiction.

Response: explicit, code-verifiable contradictions rank before affinity. Relational free-text rules do not receive that status unless code can actually verify them.

### 4. Thin evidence for a user-named artist is common but usually not a failure

Several stable cases retained a named artist with thin audience evidence: Joy Crookes, Charlotte Day Wilson, Yseult, Maya Jane Coles, and others. Replacing these merely to raise the support count would violate the product policy.

Response: keep thin or Qloo-unknown user choices and flag them. Replace only when evidence contradicts the choice or a hard rule requires it.

### 5. Zero support is a capability-envelope result, not a loop invitation

Mumbai has strong measured aggregate artist and brand depth, but the accessories scenario's exact anchors and entities produced 0/4 support. City-level coverage does not guarantee evidence for every entity combination.

Response: the app now labels a zero-support ordering **Insufficient Qloo evidence** and shows the plan only as a human-validation hypothesis. Do not repeatedly rerun it expecting missing evidence to appear.

### 6. Stability failures have two distinct causes

- Blind-order sensitivity: London luxury, Tokyo eyewear, Tokyo denim and Sydney.
- Anchor sensitivity: Mexico City, where removing either frozen audience anchor changed the winner.

Response: keep these separate in the UI and evaluation. Order sensitivity calls for judge/calibration review; anchor sensitivity calls for audience confirmation.

## Efficient test policy

1. Unit-test the failure pattern first.
2. Use `npm run eval:failures -- <tag>` on saved traces.
3. Run one live representative only when the code change directly affects its pattern.
4. Do not rerun a stable case as a control unless the changed rule can plausibly affect it.
5. Run all 15 frozen scenarios only once at a release/promotion checkpoint.

For the current change, only `upcycled-denim-tokyo` is a justified future live rerun. Mumbai needs no rerun; Tokyo eyewear already demonstrated the venue-role improvement; stable scenarios are out of scope.

