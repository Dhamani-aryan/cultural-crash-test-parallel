# Cultural Crash-Test Agent

> **HACKATHON JUDGING AND RULES REFERENCE:** This is the repository file that records the Qloo Agentic Hackathon challenge context, equally weighted judging criteria, submission requirements, product requirements, and acceptance criteria. See **Section 2 — Hackathon fit and submission constraints** and **Section 13 — Acceptance criteria**. Give this file to an independent reviewer together with `handoff/INDEPENDENT_JUDGE_PROJECT_AND_CODEBASE_BRIEF.md`.

## Project specification, product requirements, technical plan, and coding-agent brief

> **Working tagline:** Find the cultural mismatch before launch. Then fix it.
>
> **One-sentence pitch:** Cultural Crash-Test is an autonomous cultural strategy agent that uses Qloo's taste intelligence to test a proposed consumer-brand launch concept, identify the weakest-supported cultural choices, find better-supported alternatives, and re-evaluate the revised plan with a transparent evidence trail.

---

## 1. Project at a glance

**Hackathon:** Qloo Agentic Hackathon  
**Core dependency:** Qloo API / taste graph  
**Product type:** Agentic web application  
**Primary audience:** Independent consumer brands and small creative/marketing agencies planning a launch or entering an unfamiliar market  
**Initial demo vertical:** A streetwear/lifestyle brand planning a launch campaign or pop-up in a target city  
**Central differentiator:** The agent does not stop after generating recommendations. It makes a plan, gathers Qloo evidence, scores the plan, detects weak components, chooses a targeted follow-up action, revises the plan, and tests it again under explicit constraints.

### Product thesis

A language model can write a plausible cultural campaign from general knowledge. That does not mean the campaign's music, brand references, creative direction, and physical setting are supported by the cultural tastes relevant to the intended audience and market.

Cultural Crash-Test treats a launch plan as a set of testable hypotheses. Qloo supplies external cultural-affinity signals. The LLM plans and interprets research steps. A deterministic evaluator checks evidence and constraints. An agent controller decides whether another research or repair step is justified.

The product should make it obvious that Qloo changed the agent's decisions. **Qloo is part of the decision loop, not a decorative API call.**

---

## 2. Hackathon fit and submission constraints

The uploaded hackathon brief describes the challenge as giving agents cultural grounding through Qloo's taste graph, rather than demonstrating something a general LLM can already do. The judging criteria are equally weighted:

1. **Technological implementation:** Substantive, working use of Qloo.
2. **Design:** A coherent product experience rather than a bare proof of concept.
3. **Potential impact:** A credible problem, audience, and use case.
4. **Quality of the idea:** Creative, non-obvious use of cultural intelligence.

The official rules require a working application integrating Qloo, a functional demo link, a public code repository with the source and setup instructions, an open-source license, and an English submission description. The demo must be available to judges without charge or access restrictions during judging.

**Implementation implication:** Optimize for a complete, inspectable end-to-end use case. Do not spread effort across many unrelated verticals. The demo should show a real Qloo-grounded iteration cycle from brief to diagnosis to repair to final plan.

Official materials:
- Hackathon brief supplied by the user: `HACKATHON_BRIEF.md`
- Official rules supplied by the user: `Pasted text.txt`
- Qloo developer guide: <https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide>
- Qloo API documentation repository: <https://github.com/qloo/docs-public>
- Qloo Insights API overview: <https://github.com/qloo/docs-public/blob/main/reference/api-overview.md>
- Qloo Insights API Deep Dive: <https://github.com/qloo/docs-public/blob/main/reference/insights-api-deep-dive.md>
- Qloo hackathon kit: <https://github.com/qloo/qloo-hackathon-kit>
- Qloo hackathon kit API access and limits: <https://github.com/qloo/qloo-hackathon-kit/blob/main/docs/API_ACCESS.md>
- Qloo hackathon kit submission guide: <https://github.com/qloo/qloo-hackathon-kit/blob/main/docs/SUBMISSION.md>

**Important:** Treat the live Qloo documentation and event-specific instructions as authoritative for exact endpoints, authentication, parameter names, limits, and response schemas. Do not assume that an example request or a field name in this document is guaranteed to be supported by the event key.

---

## 3. The problem

A small consumer brand or creative agency may need to choose a campaign direction for a market where it lacks first-hand cultural knowledge. A launch brief often contains several interconnected cultural choices:

- a creative theme or aesthetic;
- music or artist references;
- brand or collaboration references;
- an event or pop-up setting;
- other culture-linked entities that shape the concept.

A generic LLM can produce polished-sounding suggestions, but it may blend stereotypes, stale assumptions, popular global references, and unsupported local claims. A static recommendation list does not evaluate whether the choices work together or whether revising one of them improves the overall concept.

### The job to be done

> “Before we commit creative time and launch budget, help us identify the cultural assumptions in this plan that are weakly supported for our intended audience and market. Research alternatives, revise the weakest choices, and show us what changed and why.”

### Initial target user

An independent consumer brand founder or small creative agency with a launch brief but without a large in-house cultural insights team.

### Initial scenario

A fictional streetwear/lifestyle brand wants to plan a launch campaign or pop-up in a target city. The user supplies the concept, the desired audience, non-negotiable constraints, and any existing creative choices. The agent evaluates a small set of components, not an entire marketing organization.

### Non-goals

- Do not claim to predict sales, virality, conversion, or actual campaign outcomes without validated outcome data.
- Do not position the app as a person-level profiler or claim to know what a specific person likes.
- Do not build a generic “ask anything about culture” chatbot.
- Do not build a large recommendation catalog with no self-evaluation loop.
- Do not generate fabricated Qloo results, affinities, entities, or citations when the API returns no evidence.
- Do not attempt to cover every Qloo category in the first version.

---

## 4. The core idea: Cultural Crash-Test

Cultural Crash-Test reviews a proposed cultural launch concept like a pre-launch stress test. The user provides the commercial goal, target audience description, market, constraints, and an initial concept or asks the agent to draft one.

The agent then:

1. Converts the brief into a structured, testable plan.
2. Identifies the cultural assumptions that most affect the plan.
3. Resolves relevant names and concepts to valid Qloo entities/tags where possible.
4. Queries Qloo across the relevant supported categories and local context.
5. Builds an initial evidence-backed plan.
6. Scores individual components and the package using a transparent, project-defined evaluator.
7. Identifies the weakest-supported component and explains the missing or conflicting evidence.
8. Chooses a targeted next action, such as resolving an ambiguous entity, testing a different category, changing a seed signal, or finding alternatives.
9. Produces a revision and re-runs the relevant checks.
10. Stops when acceptance criteria are satisfied, progress stalls, or a safety/API/iteration budget is reached.
11. Presents the original and final concepts, the change log, the evidence, the limitations, and unresolved risks.

The key product behavior is **targeted iteration**: if only the venue choice is weakly supported, preserve the other components unless the evidence indicates that changing them is necessary. The system should not rewrite the entire plan randomly on every pass.

---

## 5. User experience and workflow

### A. Create a launch brief

The first screen should have a clean guided form with the following fields:

- **Project/brand name:** Optional; users can use a fictional brand.
- **Product/category:** Start with streetwear/lifestyle and allow a free-text description.
- **Launch goal:** For example, pop-up launch, new-market entry, campaign concept, or collaboration plan.
- **Target market:** City/region and country. Clarify that location coverage must be verified by Qloo.
- **Audience description:** A broad, user-provided audience concept. Do not infer sensitive traits.
- **Budget band:** Optional. Treat as a user constraint, not something Qloo predicts.
- **Brand attributes:** Examples: sustainable, minimalist, playful, premium, experimental.
- **Existing choices:** Optional entities or concepts to test.
- **Hard constraints:** Required categories, exclusions, budget limit, brand guidelines, or choices that must not be changed.
- **Research depth:** Quick or thorough, mapped to explicit query and iteration budgets rather than vague promises.

Users should be able to provide an incomplete brief. The agent may ask one focused follow-up question if a missing detail would make the research meaningless; otherwise it should state the assumption it is using.

### B. Run the cultural stress test

The main workspace should show a clear sequence of events:

- Brief structured.
- Research plan selected.
- Qloo entity/tag resolution performed.
- Qloo query completed, with request type and concise response summary.
- Evidence reviewed.
- Weak component identified.
- Next action selected and why.
- Candidate revised.
- Re-evaluation completed.
- Final status: accepted, stopped due to diminishing returns, or stopped due to a budget/coverage limitation.

Do not expose secrets, full sensitive request headers, or huge raw payloads by default. Provide an expandable technical trace with sanitized request parameters and response snippets for judges/developers.

### C. Review the result

The final report should include:

1. **Executive verdict:** A short summary of the strongest and weakest parts of the plan.
2. **Original vs. final plan:** Side-by-side comparison of the concepts and components changed.
3. **Component assessments:** Evidence-backed status for each selected component.
4. **Cultural evidence:** Which Qloo queries/results informed each decision, including valid entity IDs/names where appropriate and explainability metadata when supported.
5. **Revision log:** What changed in each iteration, why it changed, and what evidence triggered the change.
6. **Confidence/coverage caveats:** Distinguish strong evidence, weak evidence, missing evidence, and failed entity resolution.
7. **Next steps:** Practical launch research tasks that still require human validation.
8. **Export:** Download a Markdown report; optionally JSON for reproducibility.

The UI should never present a single score without explaining how it was constructed.

---

## 6. Agent behavior: what makes it agentic

The app must have an explicit tool-using controller with state, action selection, evaluation, and stop conditions. It must not be implemented as one prompt that produces a long answer.

### Agent roles

Implement this as one orchestrated agent with clear internal stages, not as a complex multi-agent swarm unless there is a demonstrated need.

- **Planner:** Converts the brief into a structured research plan and identifies assumptions to test.
- **Research tool caller:** Executes validated Qloo lookups and Insights API queries through server-side tools.
- **Evaluator:** Computes explicit metrics from actual API outputs and user constraints. Prefer deterministic logic over an LLM's unsupported self-rating.
- **Repair planner:** Chooses the next highest-value action based on the weakest component and remaining budget.
- **Report writer:** Explains the outcome using the recorded evidence ledger. It cannot invent new evidence.

The planner, repair planner, and report writer can use an LLM. API validation, hard constraints, score calculations, state transitions, budget enforcement, and stop conditions should be deterministic wherever practical.

### Suggested agent state

Persist or retain a structured state object similar to:

```ts
type AgentRunState = {
  runId: string;
  brief: LaunchBrief;
  constraints: Constraint[];
  plan: CulturalLaunchPlan;
  currentIteration: number;
  maxIterations: number;
  maxQlooCalls: number;
  qlooCallsUsed: number;
  evidenceLedger: EvidenceRecord[];
  evaluations: PlanEvaluation[];
  changes: PlanChange[];
  unresolvedQuestions: string[];
  stopReason?:
    | "acceptance_criteria_met"
    | "no_material_improvement"
    | "iteration_limit"
    | "api_budget_limit"
    | "insufficient_data"
    | "user_cancelled"
    | "error";
};
```

Adapt the final types to the chosen architecture. The important requirement is that the full decision history is structured and testable, not reconstructed from free-form chat text after the fact.

### State machine

```text
START
  -> VALIDATE_BRIEF
  -> PLAN_RESEARCH
  -> RESOLVE_ENTITIES_AND_TAGS
  -> GATHER_QLOO_EVIDENCE
  -> BUILD_OR_EVALUATE_PLAN
  -> CHECK_HARD_CONSTRAINTS
  -> CHECK_ACCEPTANCE_CRITERIA
       -> ACCEPTED: WRITE_FINAL_REPORT
       -> NOT_ACCEPTED: DIAGNOSE_WEAKEST_COMPONENT
            -> SELECT_TARGETED_ACTION
            -> CHECK_BUDGET_AND_PROGRESS
                 -> CONTINUE: GATHER_QLOO_EVIDENCE
                 -> STOP: WRITE_FINAL_REPORT_WITH_LIMITATIONS
```

### Tool-call loop pseudocode

```text
state = initialize_run(brief, budgets)

while not state.is_terminal:
    action = planner_or_repair_policy(state)
    validate_action(action, allowed_tools, schemas, remaining_budget)

    result = execute_tool(action)
    evidence = normalize_and_validate(result)
    append_to_evidence_ledger(state, action, evidence)

    evaluation = deterministic_evaluate(state.plan, state.evidence_ledger, state.constraints)
    append_evaluation(state, evaluation)

    if hard_constraint_violated(state.plan):
        state.plan = repair_hard_constraint_violation(state.plan)
        continue

    if acceptance_criteria_met(evaluation):
        stop(state, "acceptance_criteria_met")
    elif no_material_improvement_for_configured_rounds(state.evaluations):
        stop(state, "no_material_improvement")
    elif state.qlooCallsUsed >= state.maxQlooCalls:
        stop(state, "api_budget_limit")
    elif state.currentIteration >= state.maxIterations:
        stop(state, "iteration_limit")
    else:
        state.plan = apply_targeted_repair(state.plan, evaluation, action, evidence)

return report_from_recorded_state(state)
```

This pseudocode is conceptual. Implement a well-defined state machine rather than asking the model to decide whether it has obeyed the limits.

### Iteration limits

Use configurable, conservative defaults. Start with no more than three repair rounds and an explicit Qloo-call budget. The agent must also stop when:

- it meets configured acceptance criteria;
- additional research fails to add usable evidence;
- its score improvement is below a configurable threshold for consecutive iterations;
- an API error or entity-resolution uncertainty cannot be recovered from safely;
- the user cancels.

Do not claim that more loops automatically make the result better. Record when the system stops and why.

---

## 7. Qloo integration requirements

Qloo must be the application's cultural evidence source, not just a citation service. Verify the exact event API access and the supported fields before implementing assumptions.

### Relevant official capabilities to investigate

Qloo's public documentation describes:

- **Insights API:** Taste-driven recommendations/insights parameterized by entity type and relevant signals.
- **Entity search:** Resolves named entities to IDs for use in Insights requests.
- **Tag search and tag analysis:** Helps find valid tags and related cultural context.
- **Location-aware insights:** Supports location signals or locality queries for supported requests.
- **Cross-category signals:** Entity and tag interests can influence returned results in supported entity categories.
- **Explainability:** The Insights API documents `feature.explainability`; when supported and successfully computed, response metadata can indicate which input entities contributed to recommendations. The implementation must inspect the actual response schema and warnings.
- **Analysis/compare and trends APIs:** May help compare entity groups or inspect changes when useful, but are optional for the initial release.

Start from the official API docs, not from assumptions in this product brief. Verify API access, parameters, entity types, request methods, response fields, data limits, and safe-use restrictions against the provided event credentials.

### Qloo research strategy

Create a narrow set of server-side, typed functions around the verified API capabilities. Candidate functions include:

- `searchEntities(query, allowedTypes)`
- `searchTags(query, tagTypes)`
- `getTasteInsights(inputSignals, outputEntityType, location?, options?)`
- `analyzeEntityGroup(entities, context?)` (only if supported and relevant)
- `compareEntityGroups(groupA, groupB, context?)` (only if supported and relevant)

These are internal application tool names, not claims that Qloo provides endpoints with those exact names. Map each tool to the actual documented API operation. Do not create fake endpoints.

### Evidence record

Every result that influences a decision must be recorded in a normalized evidence object. For example:

```ts
type EvidenceRecord = {
  evidenceId: string;
  iteration: number;
  purpose: string;
  queryKind: string;
  sanitizedRequest: Record<string, unknown>;
  qlooEntityIds?: string[];
  resultEntities?: Array<{
    id?: string;
    name: string;
    entityType?: string;
    observedRank?: number;
    affinityValue?: number;
    sourceFields?: Record<string, unknown>;
  }>;
  explainability?: unknown;
  coverageStatus: "usable" | "partial" | "empty" | "error";
  warnings: string[];
  collectedAt: string;
};
```

Only populate fields that exist in the actual result. Never convert missing scores to zero, infer data not returned by Qloo, or treat a rank as a probability. Keep enough sanitized request metadata to reproduce the query without exposing the API key.

### Candidate input signals and output categories

For the initial use case, investigate a compact set of cultural components such as:

- brand entities for relevant collaboration or affinity references;
- artist entities for music direction;
- place entities for a pop-up/event context;
- tags for descriptors such as style or genre where supported.

The live API key may not support every desired category, parameter combination, or locality. Test the smallest end-to-end use case first and gracefully remove unsupported components rather than fabricating substitutes.

### Qloo result interpretation

- Treat scores as Qloo-defined affinities/ranks with the exact semantics described in current official documentation.
- Do not describe affinity as a literal probability that a person will like something.
- Do not say Qloo proved a campaign will succeed.
- Explain missing, sparse, or ambiguous data as uncertainty.
- Check entity matches before sending IDs into later requests.
- Prefer valid IDs and documented fields over fuzzy names in downstream calls.
- Use the optional explainability feature only where the endpoint/response supports it; handle explicit warnings.

### API access and safety

- Keep `QLOO_API_KEY` on the server or in the official harness's protected configuration.
- Never embed the key in client-side JavaScript, public environment variables, generated logs, screenshots, reports, or the repository.
- Never commit real `.env` files or credentials.
- Read the event's API access, rate-limit, and safe-use guidance before live calls.
- Apply timeouts, bounded retries, rate-limit-aware backoff, request budgets, and caching when permitted.
- Avoid logging complete raw requests/responses when they contain secrets or unnecessary data.
- Follow the API license and event data-handling instructions.

### Official kit

The official `qloo-hackathon-kit` documents three routes: exploratory agent chat, CLI workflows/raw API access, and MCP. Use the kit to validate queries early, and then select the simplest stable integration route for the app. Do not depend on kit commands/modes that the current event instructions explicitly say are unsupported. Keep a copy of successful, sanitized request/response fixtures for deterministic tests when permitted by the data terms.

---

## 8. Evaluation and scoring design

The app should generate a **project-defined cultural-support score** for comparing plans. It must not imply that Qloo returns a single official “campaign cultural fit” score unless that is explicitly documented by Qloo for the exact API response being used.

### Recommended evaluator principles

1. **Ground each metric in actual evidence.** If the evidence is missing, mark the metric unavailable/low coverage instead of fabricating a score.
2. **Separate cultural evidence from business constraints.** A plan can have strong affinity signals and still violate a budget or brand constraint.
3. **Reward coherent combinations, not merely individually popular items.** The score should consider whether cross-category queries and relevant location signals support the combination.
4. **Penalize uncertainty transparently.** Sparse evidence or unresolved entities should lower coverage/confidence, not be described as evidence of poor audience fit.
5. **Use deterministic calculations.** A model may recommend weights or explain results, but should not unilaterally assign the final numeric score.
6. **Keep the formula versioned.** Every run records the scoring rubric and weights used so two plans can be compared fairly.

### Starting rubric (hypothesis to validate)

Use this as a configurable initial design only if the API results support these components:

| Dimension | Initial weight | Meaning |
|---|---:|---|
| Audience-affinity evidence | 35% | Strength and relevance of Qloo-supported affinity signals for the selected audience/context, based on documented response semantics. |
| Local relevance | 30% | Support from queries incorporating the requested location, where the API supports the intended query. |
| Cross-category coherence | 25% | Evidence that the selected cultural components are supported together across category-specific queries, not only as isolated choices. |
| Non-redundancy/diversity | 10% | Whether the set adds meaningfully distinct references rather than repeating nearly identical options. This may require a clearly labeled application-level heuristic. |

These weights are design assumptions, not validated predictors. If actual Qloo fields do not support one of these dimensions, omit or redesign it and explain the trade-off. Do not force a metric simply to preserve the table.

### Avoid misleading scores

- Never present the score as a probability or measured sales uplift.
- Show coverage separately from fit; a high score based on very little evidence should not look fully reliable.
- Show per-component ratings and evidence behind the aggregate.
- Retain the baseline score, revised score, and their component changes.
- The LLM can explain why a score changed only by referencing recorded evaluation fields and the evidence ledger.

### Baseline experiment

Build a small fixed evaluation set of launch briefs. For each brief, run:

- **Baseline:** LLM generates a launch concept without Qloo evidence or the autonomous repair loop.
- **Treatment:** Qloo-powered agent researches, evaluates, repairs, and re-evaluates under the same brief and constraints.

Evaluate both using a written rubric that can be applied consistently, including constraint satisfaction, evidence traceability, useful specificity, local-context support where available, unsupported claims, and human reviewer preference. Retain the outputs and methodology. Report real observed results only. Do not invent a percentage improvement or claim statistical significance from a tiny sample.

---

## 9. Product interface and visual direction

Build a production-quality, responsive web interface. The interface should feel like a serious strategy/research product, not a playful chatbot.

### Main screens

#### 1. New stress test

- Guided launch-brief form.
- Clear examples and input hints.
- A small number of required fields.
- Visible privacy note: cultural evidence is aggregate/affinity-based and does not identify or predict any individual.
- “Run Cultural Crash-Test” primary action.

#### 2. Active run / agent console

- Current stage and iteration number.
- Progress/status events, not a fake percentage indicator.
- Current hypothesis being tested.
- Recent Qloo operations with statuses and short summaries.
- “Why this step?” explanation from the planned action.
- Stop/cancel control.
- Expandable sanitized technical trace.

#### 3. Results dashboard

- Original vs. revised plan.
- Component cards for creative direction, artist/music reference, collaboration/brand, and event/location if those sections have adequate data.
- Evidence and coverage labels: **Supported**, **Weak evidence**, **Unresolved**, **Constraint conflict**, or another small, consistent status set.
- Revision timeline and rationale.
- Transparent scoring breakdown, if implemented.
- Unresolved assumptions and next research actions.
- Export to Markdown; optional JSON export.

### Suggested visual system

- Dark, editorial, premium interface with restrained contrast.
- Clear typographic hierarchy and ample whitespace.
- Use graphs only when data justifies them. A decision timeline and before/after comparison are more important than decorative charts.
- Avoid colorful “AI confidence” badges that imply unsupported certainty.
- Use accessible colors and text labels for statuses; do not communicate meaning by color alone.
- Keep the raw tool output available for technical credibility without overwhelming the default view.

---

## 10. Recommended implementation architecture

Choose the stack that gets to a reliable deployed demo fastest. The following is a recommended default, not a mandatory technology constraint.

### Frontend

- Next.js with App Router
- TypeScript
- Tailwind CSS
- shadcn/ui or a similarly accessible component system
- Zod for validating forms, API payloads, and structured model/tool outputs

### Backend

- Next.js server route handlers or a separate Node.js service, whichever is simplest for the agent orchestration.
- A server-side Qloo client wrapping only verified operations.
- An LLM provider adapter so the planner/report generation is not tightly coupled to one provider.
- An explicit run controller/state machine with deterministic scoring and iteration limits.
- Persistent run storage is useful but keep it lightweight; SQLite or a small Postgres instance is optional. The initial demo can use a simpler persistence approach if it remains reliable across a session.

### Model responsibilities

Use the selected model only for tasks that benefit from reasoning and language generation:

- converting the brief into structured hypotheses;
- proposing the next research action from the allowed tool list;
- interpreting evidence with strict references to the ledger;
- generating concise explanations and the final report.

Do not rely on the LLM alone for:

- Qloo query validation;
- secret management;
- enforcing hard constraints;
- calculating numeric scores;
- counting requests or iterations;
- determining whether a request exceeds the configured budget;
- fabricating missing evidence;
- declaring success merely because its text sounds confident.

### Tool interface

Define each tool with:

- typed JSON input schema;
- typed normalized output schema;
- a short tool description for the model;
- server-side validation;
- timeout and retry policy;
- usage-budget accounting;
- structured logs with a run ID;
- clear failure and no-result behavior.

### Reliability behavior

- Use an idempotent run/step identifier where practical.
- Protect against duplicate form submissions and duplicate tool calls.
- Handle timeouts, 4xx/5xx errors, rate limits, invalid IDs, empty results, ambiguous entity matches, and missing explainability metadata.
- Use mock fixtures for automated tests; do not require a paid live API call for every test.
- Ensure the final report renders even if the agent stops early due to an API failure, clearly labeling partial findings.

---

## 11. Required domain types

Create sensible TypeScript/Zod schemas. The structure below is illustrative and should be refined during implementation.

```ts
type LaunchBrief = {
  brandName?: string;
  productCategory: string;
  launchGoal: string;
  targetMarket: {
    locality?: string;
    region?: string;
    country: string;
  };
  audienceDescription: string;
  brandAttributes: string[];
  budgetBand?: string;
  existingChoices: CulturalChoice[];
  constraints: Constraint[];
};

type CulturalChoice = {
  slot: "creative_direction" | "artist_music" | "brand_collaboration" | "event_place" | "other";
  proposedName?: string;
  description: string;
  qlooEntityId?: string;
  qlooEntityType?: string;
  origin: "user_provided" | "agent_proposed";
};

type Constraint = {
  id: string;
  description: string;
  kind: "hard" | "soft";
  category?: string;
};

type PlanEvaluation = {
  iteration: number;
  rubricVersion: string;
  totalScore?: number;
  dimensions: Array<{
    key: string;
    score?: number;
    weight?: number;
    coverage: "adequate" | "partial" | "insufficient";
    evidenceIds: string[];
    explanation: string;
  }>;
  hardConstraintViolations: string[];
  weakestComponentIds: string[];
  materialImprovementFromPrevious?: number;
};

type PlanChange = {
  iteration: number;
  componentId: string;
  before: unknown;
  after: unknown;
  reason: string;
  triggeringEvidenceIds: string[];
  expectedEffect: string;
  observedEffect?: string;
};
```

The final implementation should avoid `unknown` where a clear domain type is possible. The above is a design sketch, not a demand to copy it verbatim.

---

## 12. Security, privacy, and honest product claims

- Qloo's output is cultural affinity/aggregate intelligence. Do not infer the identity, personal tastes, beliefs, protected attributes, or future behavior of a specific person.
- Audience descriptions should be broad and supplied by the user. Avoid creating sensitive-trait targeting.
- Do not use or store real personal data unless clearly necessary, authorized, and compliant with the applicable policies and terms; the initial product does not need it.
- Never claim that an affinity relationship is causal.
- Never claim that the agent has “proved” a campaign will succeed.
- Label app-generated scores as application-defined and disclose their dimensions.
- Do not scrape private sources or bypass Qloo/API access controls.
- Do not expose API keys in the UI, repo, logs, exported report, screenshots, or demo video.
- Add a short disclaimer: “This assessment compares a plan against available cultural-affinity signals. It is not a sales forecast or a guarantee of campaign performance.”

---

## 13. Acceptance criteria

The application is not complete until the following are demonstrably working.

### Core functionality

- [ ] A user can submit a launch brief with a target market and clear constraints.
- [ ] The app validates the brief and exposes assumptions when optional details are missing.
- [ ] The agent calls the real Qloo API using verified, event-authorized access for its core research.
- [ ] The system resolves/validates entities or tags before using them in downstream requests.
- [ ] Qloo results actually influence candidate selection or evaluation.
- [ ] The agent maintains state and an evidence ledger across more than one step.
- [ ] The evaluator finds a concrete weakness or evidence gap in an initial plan.
- [ ] The agent chooses a targeted follow-up action and performs a revision.
- [ ] The revised plan is re-evaluated using new evidence or a documented reason that no new query was needed.
- [ ] Hard constraints cannot be silently overridden by the model.
- [ ] Iteration count and Qloo-call budgets are enforced outside the model.
- [ ] The app stops with a clear, truthful reason when it cannot improve or lacks data.
- [ ] The user can inspect a revision history and trace major decisions to recorded evidence.
- [ ] The report clearly separates Qloo-returned evidence from the application's own heuristic and LLM-generated explanation.

### Interface and deployability

- [ ] The interface is responsive and coherent from brief entry to final report.
- [ ] Loading, no-result, API-error, and partial-result states are designed.
- [ ] A working public demo can be opened by judges without payment or special access.
- [ ] A clean setup works from the public repository using documented instructions.
- [ ] The repository contains all required source/assets and an open-source license.
- [ ] No secret or real API key is committed.
- [ ] The final demo has a deterministic demonstration path, without depending on a random API result at the critical moment; fixtures may support tests/fallbacks but must never be presented as fresh live Qloo results.

### Evaluation

- [ ] There is a fixed test set with several briefs.
- [ ] An LLM-only baseline can be compared with the Qloo-powered agent.
- [ ] The evaluation rubric and sample size are documented.
- [ ] All reported measurements come from actual runs.
- [ ] The demo shows at least one successful end-to-end case where Qloo evidence changes the agent's decision.

---

## 14. Testing plan

### Unit tests

Test:

- brief validation and normalization;
- tool input schemas;
- Qloo response normalization;
- handling of empty and partial responses;
- scoring calculations and missing-data behavior;
- hard-constraint validation;
- iteration and API-budget stop conditions;
- deciding whether an improvement is material;
- report generation from the evidence ledger;
- key redaction from logs and export.

### Integration tests

Using mocked API fixtures:

- successful entity resolution followed by Insights query;
- an ambiguous entity match that triggers a clarification/research step;
- a candidate with strong individual evidence but weak package-level coherence;
- a location query with no usable results;
- a Qloo timeout or rate limit;
- a missing explainability section or warning;
- repair that improves the evaluator's score;
- repair that does not improve the score and correctly stops;
- a run that stops at the exact configured request budget.

### Live smoke tests

Run a limited number of real API tests after verifying the event-specific limits and credentials. Save sanitized outputs if permitted. Do not make the entire automated test suite depend on live Qloo availability.

### Demo scenario

Create a fixed example brief for a fictional streetwear/lifestyle launch. Pre-test it to confirm the event API returns enough usable results. The demo should show:

1. The initial concept and its constraints.
2. Real Qloo-backed research.
3. The evidence/coverage gap identified by the evaluator.
4. The agent's selected corrective action.
5. The new Qloo-backed evidence or documented comparison.
6. The revised concept and before/after comparison.
7. The score/evidence breakdown and caveats.

Do not script fake live results. If live API use is unavailable during a demo, label cached fixtures plainly as recorded example data.

---

## 15. What makes this stand out

The headline feature is not the aggregate score. The differentiator is an observable **cultural diagnosis-and-repair loop**.

A strong demo should prove these specific points:

- The agent discovers something it could not safely assume from the prompt alone.
- Qloo evidence changes an actual cultural choice in the plan.
- The agent explains why that choice is weakly supported, not simply unpopular.
- It researches a targeted alternative rather than rewriting the whole answer.
- It rechecks the revised package and preserves the evidence behind the change.
- Its stopping logic is explicit and it admits when it cannot resolve a question.

An LLM-only baseline should be included as an experiment, not a straw man. Run both systems on the same briefs and constraints. Make the comparison visible and report the actual differences.

---

## 16. Product demo narrative

A concise demo can follow this narrative without relying on a long slide deck:

1. **The decision:** A brand is preparing to enter a market and has limited budget for the launch.
2. **The risk:** The first concept looks polished, but some cultural choices are based on assumptions.
3. **The investigation:** The agent calls Qloo, resolves the cultural anchors, and inspects relevant category and location signals.
4. **The diagnosis:** The evaluator highlights one specific weakly supported choice and shows which evidence led to that conclusion.
5. **The repair:** The agent researches alternatives, selects a candidate, and preserves the unaffected components.
6. **The re-test:** It queries/evaluates the revised concept and shows what changed and what remains uncertain.
7. **The proof:** The final screen includes the decision trail, comparison against the initial plan, and the limitations of the score.

The story should be about an agent improving a real decision—not about how many recommendations it can generate or how long it can think.

---

## 17. Open technical questions to resolve from the live API

The coding agent must answer these by reading the current docs and making small, authorized test requests before designing the final implementation:

1. Which entity types are available for the event's API key and relevant query patterns?
2. Which endpoint and request parameters best support entity search, tag search, cross-category Insights, and location signals?
3. What result fields and affinity/ranking semantics are actually returned?
4. Can the explainability feature be enabled for the selected Insights queries, and what does the response look like when explainability cannot be computed?
5. Which query combinations provide meaningful evidence for the proposed demonstration scenario?
6. What are the current API rate limits, request restrictions, and safe-use instructions?
7. Does the event starter kit have a preferred path for the chosen framework, or is direct server-side API access simpler and safer?

Do not stop after reading docs. Make a minimal live proof-of-concept query and save a sanitized example of the returned shape before writing the complete app.

---

## 18. Repository and documentation deliverables

The public repository should contain at least:

- `README.md` with product overview, screenshots, local setup, required environment variables, demo flow, and limitations;
- the complete app source;
- `.env.example` with placeholders only;
- domain types and validation schemas;
- the Qloo client and documented API mappings;
- the agent controller/state machine;
- scoring/evaluation module with formula versioning;
- test suite and sanitized/mock fixtures;
- `LICENSE` using an OSI-approved license selected by the project owner;
- clear instructions for running tests and the demo;
- submission description and screenshots/video assets as appropriate.

Provide the public demo and repository links on the hackathon submission page. Ensure the demo remains accessible to judges as required by the official rules.

---

## 19. Build brief for Claude / ChatGPT / a coding agent

Copy the prompt below into the coding assistant you use, along with this file and the official hackathon brief/rules.

---

### Prompt begins

You are the lead product engineer and agent-systems architect responsible for building **Cultural Crash-Test**, a competitive entry for the Qloo Agentic Hackathon. Read this entire specification and the supplied official hackathon brief/rules before writing code.

Your goal is to produce a working, polished, deployable application that demonstrates a real, bounded, multi-step agent loop grounded in Qloo's actual API. The product tests a consumer-brand cultural launch concept, diagnoses its weakest-supported cultural component, finds an alternative using Qloo, revises that component, and re-evaluates the package while maintaining an evidence ledger.

#### Operating principles

1. **Verify before assuming.** Read the current official Qloo developer guide, public API docs, event kit documentation, API access/limits, and safe-use guidance. Use the available event credentials only through a secure server-side/local route. Validate a minimal real API call and inspect its actual response shape before building around it.
2. **Make the smallest complete product.** Prioritize one polished end-to-end launch scenario over broad, incomplete functionality. Do not add unrelated features.
3. **Qloo must affect the decision.** A Qloo call that merely decorates an LLM answer is not sufficient. The actual Qloo evidence must influence the evaluator and at least one revision in the demo.
4. **Implement a true agent loop.** Use explicit state, tool calls, evaluation, targeted repair, and stop conditions. Do not implement the whole product as one prompt. Keep scoring, hard constraints, budgets, schemas, and stop conditions deterministic wherever practical.
5. **No fabricated evidence.** The LLM must not invent Qloo results, entities, API fields, locality coverage, source citations, or score improvements. Missing evidence must be represented as missing/partial.
6. **Honest metrics.** Any composite cultural-support score is application-defined, formula-versioned, and based only on available evidence. Never present it as a probability of purchase, sales forecast, or guarantee of success.
7. **Respect limits and keys.** Keep API keys server-side, respect access restrictions/rate limits, bound retry loops, sanitize logs, and never commit secrets.
8. **Build the actual app.** Do not stop at a plan, architecture diagram, or code samples. Implement, run, test, debug, and document the working product in the available environment. If an external credential or deployment permission is missing, implement the real integration boundary and a clearly labeled development fallback without pretending a live Qloo test happened.

#### Expected approach

- First inspect the available repo, runtime, package manager, credentials' presence (never print secret values), and the official Qloo docs.
- Produce a short implementation checklist based on the specification, but do not provide a timeline.
- Validate one minimal Qloo flow and document the verified request/response schema.
- Implement a typed server-side Qloo client, schema validation, agent state machine, evidence ledger, deterministic evaluator, targeted repair policy, bounded loop, and truthful stopping behavior.
- Implement the user flow: launch brief -> agent run/trace -> final before/after result -> evidence and revision history -> exportable report.
- Include a fixed demo brief and automated tests with mock fixtures. Label mocks/cached results accurately; never present them as fresh API results.
- Run formatting, type-checking, linting, unit tests, and available integration/smoke tests. Fix errors instead of merely listing them.
- Add a complete README, `.env.example`, license placeholder or selected open-source license, testing instructions, API/claim limitations, and deployment guidance.
- If multiple implementation choices are reasonable, choose the simplest that best satisfies the judging criteria and document the choice briefly rather than asking non-essential questions.

#### Definition of done

A user can submit a brief, watch a real Qloo-grounded agent investigate it, see a concrete evidence-based weak point, watch the agent attempt a targeted repair, and compare the initial and revised plan with a traceable evidence ledger. The app handles API failure or insufficient data without fabricating success, enforces its iteration/call budget, and can be run by another developer using the repository instructions.

Begin by verifying the Qloo API and the available environment, then implement the project. Do not add a project timeline.

### Prompt ends

---

## 20. Final product principle

**Cultural Crash-Test should be judged by whether it makes a better-supported decision than its own first draft—not by the length of its answer, the number of tools it calls, or the complexity of its agent framework.**
