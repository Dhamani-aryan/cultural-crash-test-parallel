# P2.1 — rare clarification and complete graph framing

**Status:** corrective implementation plan. Do this before P3 or any paid evaluation.

## Why this correction is required

The Morrow test exposed two policy errors and one graph-layout error:

1. The gate asked whether the brand identity or the proposed creative direction should win. That is recommendation work. The agent should test the proposed direction against the brand, audience and Qloo evidence, then keep or replace it with an explanation.
2. The gate asked whether Village Underground was fixed. An ordinary named choice in a current plan is a preference by default. Only explicit language such as `booked`, `signed`, `fixed`, `must use` or `cannot change` creates a lock.
3. Focused graph mode fits the camera to `layout.active`, while it still renders the final plan and the other receded decision nodes. Those rendered nodes can therefore fall outside the fitted camera and be clipped at the right edge.

Clarification exists to recover information that only the person can provide. It must not ask the person to do the agent's cultural reasoning.

## Correct product rule

The system receives the user's current plan, not a permissions form.

- `booked`, `signed`, `fixed`, `must`, `cannot change`, `non-negotiable` → locked.
- `considering`, `possibly`, `maybe`, `an example`, `something like` → considered/example.
- an ordinary named choice in `our plan is`, `we want`, `we plan to use`, or equivalent wording → preferred and replaceable only with recorded evidence.
- a brand attribute and a proposed choice that appear culturally inconsistent → do not ask. Test the inconsistency and let U/L/A expose it.
- absence of Qloo support → do not ask and do not call the choice wrong. Keep/flag or replace only under the existing evidence rules.
- unknown capacity, availability, permits, price or operational facts → do not block preflight. Show a result-time human check when material.

## Questions that are allowed

Ask only when the answer cannot responsibly be inferred or researched:

1. **Entity identity:** Qloo finds a plausible namesake and selecting either identity would measure a different real-world entity.
2. **Directly contradictory hard instructions:** for example, `Burberry is signed and must be used` together with `never use Burberry`.
3. **Uninterpretable hard rule:** the user explicitly makes a rule mandatory, but its meaning has two materially different, mutually exclusive readings and no conservative interpretation preserves it.
4. **Missing hard business fact explicitly made decisive by the user:** rare; if it can instead be reported as a feasibility/human check, do that after the recommendation.

Do not ask about strategic fit, audience fit, aesthetic coherence, local relevance, evidence strength, venue quality, whether the agent may explore alternatives, or which of two recommendations the user prefers. Those are the product's job.

## Clarification-gate changes

### 1. Remove default choice-strength questions

In `src/lib/clarify/detect.ts`, change the unqualified branch of `choiceStrength` from an `Uncertainty` to a deterministic `Resolution`:

```text
ordinary named choice → strength: preferred
because: the brief names it without lock or tentative wording
```

Do not emit `Is X fixed, or open to alternatives?` for ordinary plan language.

Keep the explicit locked, considered and example resolutions.

### 2. Stop treating recommendation tensions as clarification conflicts

The model proposal layer must not admit a conflict merely because:

- brand attributes differ from a proposed creative direction;
- an artist or brand seems too mainstream, premium, niche or local;
- two choices may appeal to different audiences;
- a proposed venue may be a weaker cultural fit;
- the model believes another option could perform better.

These become recorded hypotheses for the comparison/evidence agent, never intake questions.

For P2.1, allow model-proposed questions only for `rule_meaning`, and only when all of the following hold:

- the cited source phrase is verbatim;
- the phrase is explicitly mandatory/hard;
- two mutually exclusive interpretations change eligibility;
- neither interpretation can be safely preserved as a conservative hard rule;
- the question names no retrieved candidate.

Deterministic identity and direct-hard-conflict detectors remain allowed. Disable model-proposed `conflict`, `geography`, `tradeoff` and other strategic-fit questions at preflight.

### 3. Do not double-confirm the brief

The intake may summarize the parsed brief for transparency, but a complete brief should proceed automatically. Remove the mandatory `Confirm the brief to begin` / `Generate recommendations` stop for a complete brief.

The summary should have a lightweight edit affordance, not a second permission gate. Do not say `Brief locked` before the true human-only clarification gate has finished. Use a neutral transition such as `I have enough to test the plan.`

If preserving auto-run would be a large intake change, ship it separately in the same P2.1 commit with regression tests; do not leave two consecutive clarification systems.

### 4. Preserve the comparison contract

The Morrow scenario must reach U/L/A with these four user choices marked preferred, not locked:

- Central Cee
- Burberry
- Village Underground
- polished black-and-chrome gallery-style

The LLM and agent may keep or replace them. Each replacement must cite its own recorded reason. No code or prompt may force Burberry or the creative direction to lose merely because this scenario expects a challenge.

## Required clarification regression fixtures

Add frozen tests before changing implementation:

1. **Morrow full brief:** zero clarification questions; four preferred choices; runs immediately.
2. **Brand/creative tension:** `understated` brand plus `polished chrome` direction → zero questions.
3. **Ordinary venue:** `Our plan is Village Underground` → preferred resolution, zero questions.
4. **Locked venue:** `Village Underground is booked` → locked resolution, zero questions.
5. **Tentative venue:** `We are considering Village Underground` → considered resolution, zero questions.
6. **Namesake:** remains one identity question.
7. **Named and explicitly excluded:** remains one conflict question.
8. **Operational uncertainty:** missing capacity/availability → zero preflight questions and a result-time check when relevant.
9. Model proposes a strategic-fit conflict → code drops it.
10. Model proposes an ambiguous explicit hard rule → admitted only when the strict conditions above pass.

Update the frozen fixture fingerprint transparently. Keep its human-review status draft unless the user explicitly signs it off.

## Graph correction

### Root cause

`layoutGraph` computes camera `center` and `size` from the `active` set. In focused mode it nevertheless assigns and renders positions for `plan` and the three other final-choice nodes beyond the active path. They are not included in the camera bounds, so the node circles and labels at the right edge are clipped.

### Required layout behaviour

1. Fit to every currently rendered node, not only `layout.active`.
2. Include node radius and conservative label bounds in world-space extents.
3. Add at least 8% viewport-safe padding on all four sides, with a minimum pixel-equivalent gutter.
4. Recalculate fit after container resize, focus change, replay reset and font readiness.
5. `Fit graph` must use the same complete visible bounds.
6. Selecting a node may zoom closer, but the selected node circle and its full label must remain inside the viewport.
7. Do not hide a node label merely because the camera framed the node too close to an edge. First refit or choose an inward label position.
8. Labels may wrap to two lines within a fixed maximum width. No ellipsis for the selected node.
9. Edge-label collision routing must run after the final fitted camera is applied.
10. The graph must remain interactive and replay must still animate edges sequentially.

Implementation direction:

- In `judge-layout.ts`, calculate bounds from every node returned by `visibleGraph` that has a position.
- Expand each node's extent by `NODE_RADIUS[kind]` plus a label allowance derived from the rendered label length or a conservative constant.
- Do not use `active` as the camera-bounds input; retain it only for emphasis/opacity.
- In `JudgeGraphScene`, clamp candidate label positions inward before hiding them. Reserve hiding only for genuinely low-priority edge labels, never visible node labels.
- Add `ResizeObserver`/canvas-size coverage if the existing R3F `size` update is insufficient.

## Graph acceptance tests

At desktop and mobile widths, test overview and all four focused decisions:

- every rendered node circle is fully inside the dark canvas;
- every visible node has a readable label fully inside the canvas;
- no node sits underneath the controls or legend;
- no edge crosses a node label;
- `Fit graph` restores the complete visible graph after orbit/zoom;
- replay draws connections in order and ends with the same fitted complete graph;
- long venue, artist, collaboration and direction labels stay readable;
- the Morrow venue-focused graph does not clip the plan or the three receded nodes on the right.

Prefer deterministic layout/camera unit tests plus component tests. Also capture desktop and mobile screenshots for human review.

## Non-goals

- Do not tune rankings to make the agent beat the LLM.
- Do not add scenario-specific rules for Morrow, Burberry, Central Cee or Village Underground.
- Do not add new recommendation weights.
- Do not add more explanatory UI copy.
- Do not run the paid 15-scenario evaluation.
- Do not begin P3 until this correction passes visual review.

## Completion gate

P2.1 is complete only when:

1. the Morrow brief produces no clarification question;
2. the same parsed brief is supplied to U/L/A with four preferred choices;
3. actual hard conflicts and identity ambiguity still ask;
4. all existing and new tests, typecheck, lint and production build pass;
5. desktop and mobile graph screenshots show every rendered node and label inside the canvas;
6. the user visually approves the combined intake, clarification and graph experience.
