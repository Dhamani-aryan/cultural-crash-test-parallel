# Single-agent v3 improvement and 15-scenario evaluation plan

## Objective

Improve the recommendation agent without introducing a multi-agent system. Keep three comparison arms:

1. **User plan (U):** exactly what the user supplied, with missing slots left open.
2. **Plain LLM plan (L):** generated from the frozen brief without Qloo evidence.
3. **Single Qloo-grounded agent plan (A):** built independently by one agent using bounded retrieval, complete-plan testing and iteration.

The final comparison may select U, L, A or a tested hybrid. The evaluation judge is not part of the recommendation agent.

## Immutable before baseline

Do not overwrite or edit these artifacts:

- Branch commit: `40aa69d` (`crash:v15+parallel:v2`)
- Full states: `eval/out/scenario-runs-parallel-v2/`
- Summary: `eval/out/scenario-summary-parallel-v2.json`
- Earlier control: `eval/out/scenario-runs/` (`crash:v15`)

Current v2 headline over 15 scenarios:

- 45 of 60 final choices supported under the run's own anchors.
- 0 hard-constraint violations and 0 failed runs.
- 13 of 15 final adjudications stable.
- 2,948 budgeted Qloo checks, 170 model calls, mean run time 72.2 seconds.
- One serious failure: `accessories-mumbai` finished with 0 of 4 choices supported and an unstable LLM winner.

The earlier v1-vs-sequential comparison also exposed the central quality problem: parallel improved measured support, but the blind plan-quality judge preferred sequential in 10 scenarios, parallel in 3, with 2 ties. The recurring reasons were loss of local specificity, independent-brand character, appropriate venue format and whole-plan coherence.

## Non-goals

- Do not add orchestrator/sub-agent spawning.
- Do not add web search as recommendation evidence in this phase.
- Do not change Qloo's data or claim that affinity predicts sales, attendance or causation.
- Do not tune individual scenario outputs, names or expected winners.
- Do not change the frozen 15 briefs after seeing v3 results.
- Do not make the agent win by weighting its track identity or by weakening U/L.

## P0 agent improvements

### 1. Make Track A genuinely independent

Track A must receive the frozen brief, resolved anchors, explicit hard constraints and explicit slot locks. It must not start from Track U's components.

- A choice with an explicit lock remains mandatory.
- A non-locked user choice is a candidate and a statement of preference, not an automatic component of A.
- A Qloo-unknown user brand remains unchanged in U. It may appear as an unverified candidate for A, but must never be silently treated as contradicted.
- Track A must never read Track L's generated choices before its initial plan is complete.
- If all four user slots are populated but none are locked, U and A must still be capable of producing different plans.

Add tests proving all of the above.

### 2. Compile a deterministic brief-intent contract

Before retrieval, derive and store a structured contract from the already parsed brief. This is not another agent. It is a versioned input to every screen and explanation.

Required fields:

- city and any named neighborhood;
- audience anchors and whether they came from the user or model;
- product/category and brand attributes;
- desired event format and activity;
- named choices, divided into locked, preferred and merely considered;
- positive qualities (independent, intimate, experimental, local, understated, etc.);
- negative qualities (generic, celebrity-led, mainstream, beach-party, conventional tech launch, etc.);
- unverifiable requirements that require a person.

The contract must cite the exact brief field or phrase behind every item. Do not invent constraints from generic world knowledge.

### 3. Retrieve a diverse top-K candidate pool per entity slot

Replace first-acceptable selection with bounded candidate pooling.

- Retrieve from multiple existing Qloo views/signals.
- Deduplicate by resolved Qloo entity ID.
- Retain at least the strongest candidates from three useful lanes when available: highest affinity, strongest locality, and strongest brief/role fit.
- Keep candidate provenance: query, rank, affinity, locality, entity type and screen outcomes.
- Use one shared per-run cache and hard Qloo/model-call budgets.

Do not create separate music, brand or venue agents. Parallel Qloo requests are allowed; parallel reasoning agents are not.

### 4. Strengthen pre-composition screens

A high affinity must not rescue a choice that plays the wrong role in the brief.

Implement versioned deterministic or structured screens for:

- **Entity identity:** namesake and country protection.
- **Role fit:** artist is an artist; collaborator is an appropriate external brand; venue is a plausible host category.
- **Market/locality:** city/country validity and named-neighborhood preference when Qloo supplies adequate location data.
- **Brief fit:** preserve the product, event format, stated attributes and explicit positive/negative direction.
- **Distinctiveness:** flag top-mainstream or generic global defaults when the brief asks for independent, local, underground or non-generic choices.
- **Product centrality:** reject combinations likely to turn the product launch into an unrelated concert, gallery show or celebrity event.
- **Feasibility boundary:** capacity, availability, willingness and commercial arrangements remain unknown unless supplied; never mark them supported from affinity.

Hard constraints remain vetoes. Soft screens affect ranking and explanations, not fabricated certainty.

### 5. Optimize complete plans, not isolated slots

Construct a bounded set of complete candidate bundles from the screened pools.

- Use beam search or an equivalent deterministic bounded search; do not enumerate the full Cartesian product.
- Suggested initial beam width: 6 complete/partial plans, configurable and tested.
- Evaluate each completed bundle with the same evidence matrix.
- Plan comparison order:
  1. hard failures;
  2. explicit locks and user intent;
  3. completeness;
  4. role and brief fit;
  5. audience support;
  6. locality and neighborhood fit;
  7. cross-component coherence;
  8. distinctiveness;
  9. evidence coverage as confidence, never as quality.
- Do not let one exceptionally high affinity compensate for two weak or ill-fitting components.

### 6. Add a bounded single-agent challenge loop

After selecting its initial complete plan, the same agent performs at most two challenge rounds in quick mode and three in thorough mode.

For each round:

1. Identify the weakest component or weakest cross-component relationship from recorded claims.
2. State the failure hypothesis in structured form.
3. Search only the affected slot or relationship.
4. Substitute one candidate.
5. Re-evaluate the entire plan.
6. Keep the change only when it materially improves the evidence vector without losing a brief/role-fit claim or breaking a constraint.

Stop on no material improvement, budget exhaustion, repeated plan fingerprint or insufficient evidence. Record rejected substitutions and their rejection codes.

### 7. Make unstable outcomes honest

If rotated blind adjudication changes the winner, do not headline the evidence-order fallback as an ordinary stable winner.

- Keep a best-supported provisional plan if the product requires an answer.
- Label it `provisional`/`unstable`, state what disagreed and request human review.
- Preserve a real abstention when every candidate has insufficient evidence or fails hard rules.

## P0 evaluation protocol

### A. Versioning and isolation

- Bump only the agent architecture version to `parallel:v3`.
- If any evidence rule changes, bump `evidence:v2` separately and re-score both v2 and v3 under the new rubric. Never compare two systems using different hidden rubrics.
- Write new outputs to `eval/out/scenario-runs-parallel-v3/` and `scenario-summary-parallel-v3.json` using `SCENARIO_TAG=parallel-v3`.
- Do not overwrite v2 artifacts.

### B. Required comparisons

Run all 15 frozen scenarios and produce:

1. sequential control versus v2;
2. v2 versus v3 under the same anchors/rubric;
3. v3 agent plan versus its own LLM track;
4. final plans re-scored under both architectures' anchor sets;
5. blind plan preference in both presentation orders;
6. a separately blinded human-review sheet whose key is stored separately.

The comparison report must show per-scenario choices and reasons, not only totals.

### C. Metrics

Report exact counts, without significance language:

- hard-constraint violations and failed runs;
- supported/thin/conflicting/unverified choices;
- evidence coverage, kept separate from quality;
- stable/unstable/abstained verdicts;
- blind v3/v2/tie and v3/LLM/tie preference;
- named-neighborhood and venue-role fit failures;
- mainstream-default count for briefs requesting distinctiveness;
- user locks preserved and non-locked user choices kept/replaced;
- complete plans tested, substitutions accepted/rejected;
- Qloo logical checks, external requests, cache hits, model calls, latency and estimated cost;
- final-plan fingerprint stability across repeats.

### D. Noise control

One before/after run is the minimum demo comparison, not strong evidence. For a credible result:

- Run v3 twice over all 15 scenarios.
- Re-run v2 once with the same provider/model configuration if budget permits.
- At minimum, repeat every unstable scenario plus the five sentinel briefs: `streetwear-new-york`, `luxury-handbags-london`, `accessories-mumbai`, `sneakers-madrid`, and `sun-care-sydney`.
- Aggregate exact totals and show disagreements across repeats rather than choosing the better run.

Freeze model name, prompts, ranking version, budgets and intake fingerprints in every artifact. If temperature/seed are supported, record them; do not claim determinism when the provider does not guarantee it.

## Acceptance gates

All gates apply to the complete 15-scenario v3 set:

1. 0 failed runs and 0 hard-constraint violations.
2. 100% preservation of explicit locks.
3. No final plan with 0 supported choices unless the system explicitly abstains.
4. At least 14 of 15 stable final adjudications, with unstable results visibly provisional.
5. Final supported choices must not fall below the v2 baseline of 45/60 under comparable anchors/rubric.
6. Blind v3-versus-v2 preference must show more v3 wins than losses; otherwise do not promote v3.
7. The five sentinel scenarios must have no regression in the specific failure they test: independent/local streetwear, intimate British craft, Mumbai role fit, Madrid skate/locality, and Bondi location/event fit.
8. Median latency and external Qloo requests must be reported. An increase greater than 25% requires a demonstrated preference or quality gain and must be disclosed.
9. Human review remains mandatory before making a superiority claim.

These are promotion gates, not targets to tune against. Report a failed gate honestly.

## Tests required before live evaluation

- Track A differs from a fully specified but unlocked U plan.
- Explicit locks survive every bundle, challenge and final plan.
- Qloo-unknown user choices remain unknown, not contradicted.
- A high-affinity but wrong-role venue loses to a plausible host.
- A generic mainstream brand loses when the brief explicitly asks for independent/local/non-generic character and other evidence is comparable.
- Named-neighborhood fit is preserved when location evidence exists.
- Beam search can choose a lower-ranked individual candidate when it produces the stronger complete bundle.
- A proposed swap with better affinity but worse brief fit is rejected.
- Repeated plan fingerprints stop the loop.
- Budget exhaustion returns the best fully evaluated plan and an honest stop reason.
- Unstable adjudication is presented as provisional.
- Evaluation files cannot overwrite a different architecture/version tag.

Run unit/integration tests, typecheck, lint, production build and `git diff --check` before any paid live evaluation.

## Implementation sequence

1. Preserve/tag the v2 baseline and verify artifact fingerprints.
2. Add the brief-intent contract and tests.
3. Decouple Track A from non-locked Track U choices.
4. Add top-K diversified retrieval and strengthened screens.
5. Add bounded complete-plan beam search.
6. Adapt the existing improvement loop into the structured challenge loop.
7. Fix unstable/provisional presentation.
8. Add comparison/report fields and overwrite protection.
9. Run synthetic tests and the five sentinel scenarios first.
10. If the sentinel results are credible, run all 15 under `parallel:v3`.
11. Generate v2-v3 blind comparison and human-review artifacts.
12. Report every gate, including regressions; do not merge/promote automatically.

## Expected product story

The system should be described accurately:

> One recommendation agent independently retrieves culturally relevant candidates from Qloo, constructs and tests multiple complete launch plans, challenges its weakest choices, and returns the strongest evidence-backed plan. The app then compares that plan against the user's direction and an ungrounded LLM baseline using the same frozen evidence rules.

The value is disciplined search, complete-plan reasoning and auditable evidence—not the number of agents.
