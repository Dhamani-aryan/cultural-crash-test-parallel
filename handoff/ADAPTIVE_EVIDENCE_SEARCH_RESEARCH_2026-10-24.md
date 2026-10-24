# Adaptive Evidence Search research brief

**Date:** 24 October 2026  
**Repository:** `cultural-crash-test-parallel`  
**Status:** research recommendation; implement only as a measured experiment behind a flag  
**Decision:** keep the single evidence agent. Add an uncertainty-and-stability controller around its existing search rather than adding more agents.

## Executive finding

The current system already contains most of the architecture that recent agent-search work recommends:

- independent user, LLM and evidence-agent tracks;
- explicit tools and an evidence ledger;
- multi-view candidate retrieval and bounded beam search;
- deterministic hard screens;
- complete-plan re-testing after a substitution;
- blind adjudication in two different orders;
- strict budgets and frozen evaluation artifacts.

The largest remaining accuracy risk is not insufficient agent count. It is that the controller does not explicitly measure **decision instability**. It can retrieve and test many candidates, but it cannot yet say:

1. which uncertainty is capable of changing the winner;
2. whether the winner survives reasonable changes to audience anchors, evidence order and retrieval view;
3. whether one more Qloo call is worth its cost;
4. whether the final result should be a single recommendation, a close alternative, or a targeted human question.

The proposed improvement is **Adaptive Evidence Search (AES)**:

> Generate a small diverse set of complete plans, audit the leading plans under controlled evidence perturbations, quantify which unresolved fact has the highest value of information, then either acquire that evidence, ask one targeted question, or stop with a stability-qualified verdict.

This is a stronger and more defensible contribution than adding an orchestrator and sub-agents. It turns the existing agent into an auditable decision system and gives the judge a new, truthful claim: **the recommendation was not merely top-ranked once; it remained preferred under recorded stress tests.**

## Research that directly applies

### 1. Structured uncertainty and value of information

SAGE-Agent separates uncertainty about the user's specification from uncertainty in the model/tool system. It uses Expected Value of Perfect Information (EVPI) to decide whether a clarification is worth asking, reporting better ambiguous-task coverage with fewer questions. This fits the existing clarification gate closely, but supplies a principled selection rule instead of a collection of materiality booleans.

- Paper: [Structured Uncertainty guided Clarification for LLM Agents](https://aclanthology.org/2026.findings-acl.2028/)

**Adaptation:** retain the current deterministic eligibility checks. For each remaining material uncertainty, calculate a bounded *winner-flip value*: how many currently viable plans change eligibility or ordering under its possible answers? Ask only when that value exceeds the configured interaction cost. Do not use the model's verbal confidence.

### 2. Retrieval-and-reasoning consistency

R2C estimates uncertainty by perturbing retrieval/reasoning steps and measuring whether the outcome remains consistent. Its reported downstream gains come from treating retrieval uncertainty and reasoning uncertainty jointly rather than relying on one confidence statement.

- Paper: [Uncertainty Quantification for Retrieval-Augmented Reasoning](https://arxiv.org/abs/2510.11483)

**Adaptation:** perturb inputs that are meaningful for this product, not random prose:

- leave one audience anchor out;
- use audience-only versus audience-plus-plan retrieval;
- compare city-filtered and city-signalled results where the Qloo contract permits both;
- rotate evidence presentation order;
- optionally rerun the final structured adjudication with a second deterministic alias order.

The output is an empirical stability record, not a probability of commercial success.

### 3. Search helps only when verification is reliable

Language Agent Tree Search combines action, planning and reflection, but later work on verifier-guided search shows that imperfect verifiers can mis-rank and prune valid paths as search grows. More test-time search is therefore not automatically better.

- Official implementation: [LanguageAgentTreeSearch](https://github.com/andyz245/LanguageAgentTreeSearch)
- Analysis: [Scaling Flaws of Verifier-Guided Search in Mathematical Reasoning](https://openreview.net/pdf?id=9vFB91wspX)

**Adaptation:** do not add general MCTS. The plan space has four slots, strong deterministic screens and expensive external calls. Keep the bounded beam, but expand only the slot and evidence dimension that can change the winner. Preserve at least one diverse alternative instead of pruning solely by one verifier score.

### 4. Dynamic tool use should follow uncertainty

UALA inserts uncertainty into the thought/action/observation loop and reports better performance with fewer external calls. It also warns that verbalized model confidence is not a reliable uncertainty proxy.

- Paper and code: [Towards Uncertainty-Aware Language Agent](https://github.com/Jiuzhouh/Uncertainty-Aware-Language-Agent)

**Adaptation:** compute uncertainty from observable system state:

- missing or conflicting claims;
- retrieval-view disagreement;
- anchor perturbation winner flips;
- adjudicator order disagreement;
- small deterministic margin between non-dominated plans;
- unresolved identity or role screens.

Never ask the LLM to output a free-form confidence percentage.

### 5. Ranked evidence itself can steer a judge

Counterfactual evidence audits show that changing which otherwise ordinary evidence is selected can predictably change an agent's downstream decisions. The important lesson is to test the composed retrieval-plus-agent system, not the model in isolation.

- Paper: [Counterfactual Evidence Audits Predict LLM-Agent Susceptibility to Ranked Context](https://arxiv.org/abs/2606.00914)

**Adaptation:** for the final two plans, run a mirrored audit:

- evidence in normal order;
- evidence in reverse/rotated order;
- evidence without each anchor in turn;
- evidence from each retrieval lane separately.

If the winner flips without a substantive fact changing, mark the verdict unstable and do not manufacture a winner.

### 6. Qloo exposes a profile-comparison primitive that this agent does not use

Qloo's official documentation describes `/v2/analysis/compare` as a way to compare two groups of entities. The TypeScript client already implements `compareProfiles`, but the crash-test engine never calls it.

- Official API repository: [qloo/docs-public](https://github.com/qloo/docs-public)
- Official API overview: [Analysis and Analysis Compare](https://github.com/qloo/docs-public/blob/main/reference/api-overview.md)

**Adaptation:** experimentally compare each complete plan's resolved entity group with the audience-anchor group. Record:

- shared tags and their provenance;
- audience-only tags;
- plan-only tags;
- whether the same shared themes survive leave-one-anchor-out checks.

This must begin as an explanatory/stability signal, not a new hand-tuned scalar. Promote it into ranking only if the frozen evaluation shows that it improves human plausibility without reducing held-out performance.

### 7. Retrieval should be conditional, self-critical and budgeted

Self-RAG retrieves on demand and critiques retrieved material rather than treating every retrieval as equally useful. Qloo already provides structured evidence, so the useful part here is the control policy, not Self-RAG training.

- Official implementation: [Self-RAG](https://github.com/AkariAsai/self-rag)

**Adaptation:** add an evidence-quality gate after each retrieval lane:

- usable and discriminative: may affect the decision;
- usable but non-discriminative: record, then stop querying that dimension;
- empty/unknown: do not convert to negative evidence;
- contradictory across views: schedule a stability check;
- duplicate/memoized: do not spend budget again.

## Proposed architecture

```text
Frozen brief
    │
    ├── User plan
    ├── LLM-only plan
    └── Evidence agent: diverse candidate pools → bounded complete-plan beam
                         │
                         ▼
                 Shared evidence matrix
                         │
                         ▼
              Deterministic Pareto filter
              hard rules → role → audience → locality → coherence
                         │
                         ▼
               Stability audit on finalists
      leave-one-anchor-out · retrieval-lane split · order rotation
                         │
                         ▼
              Value-of-information controller
        acquire Qloo evidence / ask once / stop as stable or provisional
                         │
                         ▼
                  Final blind adjudication
```

The LLM proposes and explains. Code controls budgets, evidence identity, dominance, perturbations, stopping and promotion.

## New data structures

### `DecisionUncertainty`

```ts
type UncertaintyKind =
  | "specification"
  | "entity_identity"
  | "retrieval_coverage"
  | "retrieval_disagreement"
  | "adjudication_instability"
  | "candidate_margin";

interface DecisionUncertainty {
  id: string;
  kind: UncertaintyKind;
  affectedSlots: Slot[];
  affectedCandidateIds: string[];
  evidenceIds: string[];
  possibleActions: ("ask" | "query" | "retest" | "stop_provisional")[];
  winnerFlipCount: number;
  maxWinnerComparisons: number;
  estimatedCost: { qlooCalls: number; llmCalls: number; userTurns: number };
}
```

### `StabilityAudit`

```ts
interface StabilityAudit {
  candidateIds: string[];
  perturbations: {
    id: string;
    kind: "anchor_dropout" | "retrieval_lane" | "evidence_order";
    omittedEvidenceIds: string[];
    winnerCandidateId: string | null;
    verdict: "winner" | "tie" | "insufficient" | "unstable";
  }[];
  stableWinnerId: string | null;
  agreementRate: number;
  materialFlipReasons: string[];
}
```

`agreementRate` is a run statistic, not calibrated real-world confidence.

## Controller policy

1. Eliminate hard-rule failures.
2. Remove plans deterministically dominated on every evidence dimension.
3. Keep the best plan plus at least one materially different non-dominated plan.
4. Run cheap perturbations first using cached evidence.
5. Construct uncertainties only from observed disagreements or missing decisive claims.
6. Rank actions by bounded decision value:

```text
decision value = possible winner flips / comparisons affected
action cost    = normalized Qloo calls + model calls + user-turn penalty
priority       = decision value - action cost
```

7. Take the highest-positive action within budget.
8. Recompute the matrix and stability audit.
9. Stop when:

- the same winner survives every applicable perturbation;
- no remaining uncertainty can change the winner;
- the budget is exhausted; or
- the only useful information must come from the user.

10. If user information is needed, ask one question whose answers map to explicit candidate-set or constraint changes. Otherwise return the best supported plan with a visible provisional reason.

## The Qloo profile-overlap experiment

This is the most promising product-specific addition because it uses a Qloo capability already represented in the client.

For each finalist with at least two resolved entity choices:

```ts
compareProfiles({
  aEntities: audienceAnchorIds,
  bEntities: planEntityIds,
  locationQuery: market.qlooLocation,
  model: "predictive",
  take: 20,
});
```

Do not interpret shared tag count alone as quality. Build claims such as:

- “The audience and plan share X, supported by anchors A/B and choices C/D.”
- “This theme disappears when anchor A is removed; treat it as fragile.”
- “The plan is characterized by Y, which the audience profile does not share; this is a gap, not automatically a contradiction.”

Required spike before product use:

1. verify live response semantics for 5 known fixtures;
2. confirm `predictive` versus `descriptive` behavior;
3. check empty/one-entity groups;
4. record exact upstream responses in private fixtures with credentials removed;
5. ensure plan entities never appear as audience anchors;
6. measure whether the claims improve blinded human review.

## Implementation phases

### P0 — frozen research baseline

- Tag the current commit and freeze the existing 15-scenario inputs, anchors and human-review rubric.
- Add no ranking changes.
- Record current quality, stability, calls, latency and clarification count.

### P1 — stability audit, no behavior change

- Add `StabilityAudit` and cached perturbation evaluators.
- Expose stability only in downloaded/debug reports.
- Run anchor-dropout, lane-split and evidence-order checks on the top two plans.
- Measure how often current winners flip and why.

### P2 — value-of-information controller

- Convert existing clarification materiality and post-retrieval disagreements into `DecisionUncertainty` records.
- Add the deterministic action-cost and winner-flip calculation.
- Allow one extra Qloo acquisition or one clarification only when it can change the winner.
- Keep all existing hard budgets.

### P3 — Qloo profile comparison spike

- Add ledger support for `/v2/analysis/compare`.
- Add shared/profile-gap claims behind `QLOO_PROFILE_COMPARE_EXPERIMENT=1`.
- Do not rank on these claims yet.

### P4 — measured selection experiment

- Add stability as a deterministic tie-breaker after hard rules and core evidence, before the LLM judge.
- Optionally promote profile-overlap claims only after human-labelled evidence shows benefit.
- Run the complete frozen evaluation as a new version; never overwrite v2/v3 artifacts.

### P5 — judge-facing presentation

Only after promotion, add a compact receipt:

```text
Recommendation stability
4/4 evidence-order checks agreed
3/3 audience-anchor checks agreed
2 alternative complete plans were re-tested
1 uncertainty remained: venue capacity requires human verification
```

This belongs below the main result or inside the decision detail. Do not add another dashboard of scores.

## Metrics and promotion gates

Accuracy is not a single internal score. Track these separately:

| Metric | Required direction |
|---|---|
| Human blind preference: final vs LLM | improve over frozen baseline |
| Human plausibility failures | decrease |
| Held-out-anchor supported choices | no regression |
| Winner stability under perturbations | increase |
| Unsupported/unknown treated as failure | remain zero |
| Hard locks/rules broken | remain zero |
| Unnecessary clarification rate | no regression |
| Necessary clarification recall | improve or remain equal |
| Median Qloo upstream calls | no more than +15% unless quality gain is material |
| P95 latency | report; do not hide deterioration |
| Failed/incomplete runs | decrease or remain equal |

Promotion requires all safety invariants plus either:

- a statistically and practically meaningful human-preference gain; or
- the same recommendation quality with substantially better stability/cost.

Do not promote because the agent's own rubric score increases.

## Ideas explicitly rejected

- **More agents:** adds cost and correlated opinions without adding evidence.
- **Unbounded MCTS:** the action space is small and the verifier is imperfect; it risks optimizing the rubric rather than the plan.
- **LLM confidence percentages:** verbal confidence is not calibrated evidence.
- **Majority vote alone:** repeated generations can repeat the same retrieval bias.
- **A new weighted mega-score:** hides trade-offs and makes the demo harder to defend.
- **Web search as another cultural truth source:** creates provenance, freshness and comparability problems; use it only for operational facts in a separately labelled layer.
- **Training or RL before the deadline:** unjustified without a much larger labelled dataset.

## Honest claim if the experiment succeeds

> The agent generates and tests complete plans against Qloo, then stress-tests the finalists by varying the audience evidence and presentation order. It spends additional calls only on uncertainties that can change the decision and marks unstable recommendations as provisional.

That is technically substantive, easy for a judge to understand, and demonstrable from the evidence trace. It does not claim that Qloo predicts commercial success.

## Recommended next action

Implement **P1 only** first. It is read-only with respect to recommendations, reveals whether instability is a real problem in the 15 scenarios, and produces the evidence needed to decide whether P2/P3 are worth the deadline risk. Do not change the production ranking until P1 measurements exist.
