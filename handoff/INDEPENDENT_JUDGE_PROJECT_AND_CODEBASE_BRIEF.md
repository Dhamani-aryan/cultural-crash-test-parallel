# Cultural Crash-Test — independent judge project and codebase brief

## Purpose

This is a neutral description of Cultural Crash-Test and its implementation. Give it to a new reviewer together with the complete repository. It is not a scorecard, critique, improvement plan, or claim that the project deserves a particular result. The reviewer should inspect the code and judge it independently.

## Hackathon criteria and rules

The marked repository reference for the challenge, judging criteria, submission rules, product requirements, and acceptance criteria is:

**`handoff/CULTURAL_CRASH_TEST_PROJECT_SPEC.md`**

Relevant sections are:

- Section 2 — Hackathon fit and submission constraints
- Section 13 — Acceptance criteria
- Section 18 — Repository and documentation deliverables
- Section 20 — Final product principle

The equally weighted criteria recorded there are:

1. Technological implementation
2. Design
3. Potential impact
4. Quality of the idea

The same specification records the submission requirements: a working Qloo-integrated application, functional demo link, public source repository and setup instructions, open-source license, and English submission description.

## Product description

**Name:** Cultural Crash-Test

**Tagline:** Find the cultural mismatch before launch. Then fix it.

**Product type:** Conversational agentic web application

**Intended user:** A consumer-brand founder or creative/marketing team planning a launch in a supported city

Cultural Crash-Test accepts a natural-language launch brief describing a brand, product, target city, audience, proposed music act, collaboration, venue, creative direction, and constraints. It constructs and compares three independent directions:

1. the user's stated direction;
2. a normal LLM-only plan with no Qloo access;
3. an evidence-first recommendation agent that researches and tests choices with Qloo.

The system can also construct a hybrid from evaluated components, but only after the complete hybrid plan is re-tested. The final result may come from the user, LLM, agent, or tested hybrid. The architecture does not assume that the agent must win.

The result interface explains each choice side by side, shows the evidence and alternatives behind the final selection, and exposes the decision path as an interactive graph.

## User journey

### Conversational intake

The home page behaves like a chat. A user describes the launch in ordinary language. The intake layer preserves the original text and extracts a typed brief containing:

- brand/project name;
- product category;
- launch goal;
- target city;
- audience description and optional audience anchors;
- brand attributes;
- existing music, collaboration, venue and creative-direction choices;
- constraints and locked choices;
- research depth.

The application can ask a small number of structured clarification questions when a remaining ambiguity could materially change the plan. Questions support options and free-text answers, and users can delegate an answer. The server revalidates the confirmed brief before the run.

### Parallel comparison

One frozen brief is given to three isolated tracks:

- **User track:** represents supplied choices and leaves unspecified slots open.
- **LLM track:** creates a complete plan without Qloo or access to the agent plan.
- **Evidence-agent track:** resolves entities, retrieves candidates, applies brief and role screens, tests complete bundles with Qloo, and challenges its weakest consequential choice.

The LLM and evidence-agent tracks run concurrently and do not receive each other's initial results.

Every candidate plan then passes through the same structured evidence matrix. Plans are compared under random anonymous identifiers in two different display orders. A bounded improvement stage can create and re-test hybrid candidates before a final blind comparison.

### Results

The completed-run interface contains:

- a run summary and stability status;
- a **You / LLM / Evidence-first agent / Final verdict** table;
- music, collaboration brand, venue and creative-direction rows;
- expandable reasons for every retained or changed choice;
- support, counterevidence and uncertainty;
- rejected alternatives and their recorded outcomes;
- assumptions and human checks;
- Qloo/model usage counts;
- Markdown/JSON-compatible recorded state;
- a Table / Decision graph switch.

The Three.js decision graph displays the brief, tracks, evidence, candidates, re-tests, rejected alternatives, adjudication and final plan. Replay animates the path in order. Selecting a node or trace entry opens its structured decision details.

## Supported markets

The UI exposes markets selected from measured Qloo coverage stored in `data/coverage.json`:

- New York
- Tokyo
- London
- Mumbai
- São Paulo
- Madrid
- Mexico City
- Toronto
- Sydney
- Paris
- Berlin

`src/lib/markets.ts` defines Qloo location strings, countries, languages, neighborhood aliases, comparison cities, and per-domain coverage grading.

## Technology stack

- Next.js 16 App Router
- React 19
- TypeScript
- Tailwind CSS 4
- Zod runtime schemas
- Three.js with `@react-three/fiber` and `@react-three/drei`
- Vitest
- Server-Sent Events
- Qloo hackathon API
- OpenAI model access through a ChatGPT subscription credential
- Optional Upstash Redis for server-side caching, sessions and recorded runs
- MIT license

## Versioned behavior

Runs record the policy versions that produced them:

- controller: `crash:v15`
- parallel architecture: `parallel:v6`
- evidence policy: `evidence:v6`
- candidate screens: `screens:v6`
- blind adjudication: `adjudicate:v2`
- component rubric: `crash-v1`

Versions participate in cache keys and provenance so recordings made under different behavior are not silently mixed.

## System architecture

```text
Natural-language conversation
        │
        ▼
Typed, confirmed, frozen launch brief
        │
        ├────────► User plan
        ├────────► LLM-only plan
        └────────► Evidence agent + Qloo
                       ├─ entity and tag resolution
                       ├─ multi-view candidate retrieval
                       ├─ brief, role and locality screens
                       ├─ bounded complete-plan search
                       └─ weakest-choice challenge
        │
        ▼
Shared evidence matrix
        │
        ▼
Blind comparison in two orders
        │
        ▼
Bounded hybrid improvement and complete-plan re-test
        │
        ▼
Final blind comparison and stability audit
        │
        ▼
Comparison table, evidence trace and interactive graph
```

## Model-assisted and deterministic responsibilities

### Model-assisted stages

- natural-language intake extraction;
- optional broad, non-sensitive audience hypotheses;
- LLM-only plan drafting;
- candidate and creative-direction proposals;
- mapping creative language to Qloo tags;
- structured role reading from supplied facts;
- schema-validated blind adjudication;
- concise evidence-bound explanation.

### Code-enforced stages

- request and state validation;
- supported-city validation;
- Qloo entity-ID and namesake verification;
- hard locks and constraints;
- call budgets, beam widths and repair limits;
- retries, timeouts, cancellation and rate limiting;
- Qloo response normalization;
- missing-data and coverage behavior;
- component evaluation and plan ordering;
- candidate screens;
- hard-failure and completeness gates;
- stopping logic;
- blind-ID and evidence-ID validation;
- identical-plan merging;
- stability calculations;
- provenance and recorded/live labels;
- deterministic table, explanation and graph projections.

## Qloo integration

The typed Qloo client is under `src/lib/qloo/`. It supports:

- entity search;
- entity detail retrieval;
- demographic retrieval where used;
- tag search;
- Insights requests;
- profile comparison;
- normalization of entities, tags, ranks, affinities, explainability, warnings and geocodes;
- bounded retries and typed errors;
- memoization and optional persistent caching.

The application uses Qloo for four principal evidence dimensions:

1. **Audience support:** relationship between a choice, the audience anchors and target city.
2. **Local relevance:** origin or city-specific relevance compared with control markets.
3. **Package coherence:** relationship between a choice and the plan's other choices.
4. **Creative direction:** audience and package relationships for Qloo aesthetic and emotional-tone tags.

Consequential requests are written to an evidence ledger containing purpose, query type, sanitized parameters, returned entities, coverage status, warnings and time. Secrets and request credentials are excluded.

## Entity resolution and screens

Names are resolved to typed Qloo entities before downstream testing. Ambiguous matches and wrong namesakes are handled explicitly. A Qloo-unknown choice remains unknown rather than receiving a fabricated score.

The agent applies screens for:

- entity role;
- collaboration product-brand suitability;
- venue-format suitability;
- country and city locality;
- named-neighborhood distance;
- requested distinctiveness;
- product centrality;
- directly verifiable avoided qualities;
- global-prestige/default bundles.

Relational free-text instructions are not reduced to lexical bans when code cannot verify their meaning. Locked choices cannot be replaced. User choices with missing or thin Qloo evidence remain visible and are flagged rather than automatically failed.

## Evidence matrix and plan ordering

`src/lib/crashtest/matrix.ts` converts each plan into structured claims. Each claim records the candidate, component slot, rule, evidence dimension, supported/contradicted/unknown stance, strength, explanation, ledger references, source and limitations.

The current lexicographic policy considers:

1. hard failures;
2. locks preserved;
3. completeness;
4. explicit brief contradictions;
5. structured role doubts;
6. positive role and brief fit;
7. audience support by component;
8. city locality;
9. cross-component coherence;
10. requested distinctiveness;
11. evidence coverage.

Missing evidence stays unknown. It is not converted into a low affinity, failure, or commercial prediction.

## Component rubric

`src/lib/crashtest/evaluate.ts` implements `crash-v1`:

| Dimension | Weight | Meaning |
|---|---:|---|
| Audience | 35% | Choice relationship to the audience and city |
| Local | 30% | Local or city-distinctive relevance |
| Coherence | 25% | Relationship to the rest of the plan |
| Distinctness | 10% | Non-duplication within the plan; an app heuristic |

Coverage is reported separately. Application scores are labelled as the application's rubric, not Qloo probabilities or forecasts.

## Evidence-first recommendation agent

`src/lib/crashtest/agent.ts` implements one bounded recommendation agent rather than an agent swarm.

It retrieves candidates from several Qloo views, normalizes and rank-fuses them, applies screens, retains reserves, and constructs a bounded beam of complete plans. It selects an incumbent under the shared evidence policy, identifies the weakest eligible decision, tests an alternative, and accepts a revision only when the complete re-tested plan improves. Tested bundles, challenges, rejections and the stop reason remain in structured state.

## Blind adjudication and hybrid improvement

`src/lib/crashtest/adjudicate.ts` compares anonymous plans. Random identifiers replace track names. The judge receives the frozen brief, plan choices and aliased evidence claims, not the identities of the user, LLM or agent tracks.

The comparison runs in two orders. Returned plan IDs and evidence IDs are validated. Disagreement is stored as instability rather than collapsed into a winner.

`src/lib/crashtest/hybrid.ts` can combine components from evaluated plans after the first comparison. The complete hybrid must pass constraints and a full re-test; it is not accepted from component scores alone.

## Stability audit

`src/lib/crashtest/stability.ts` tests the final recommendation against its strongest distinct runner-up. It reuses both blind-order judgments and can perform leave-one-audience-anchor-out re-tests for up to three anchors.

Checks record preserved, tied, reversed or unavailable outcomes. The result is provisional when order, anchor removal, an explicit brief contradiction, or insufficient Qloo support prevents a fully stable conclusion.

## Conversational clarification

`src/lib/clarify/` implements the optional pre-run clarification session:

- deterministic ambiguity detection;
- constrained model-assisted question generation;
- Qloo identity preflight;
- option and free-text answers;
- delegated answers;
- session fingerprints;
- duplicate-answer protection;
- server-side session expiry;
- propagation of assumptions and open checks into the result.

The intake layer builds the brief; the clarification layer addresses only material ambiguity before the comparison is frozen.

## Frontend code

### Conversation

- `src/app/page.tsx` renders `ChatApp`.
- `chat-app.tsx` owns the product shell.
- `chat-store.ts` stores client conversation state.
- `use-intake.ts` communicates with the intake endpoint.
- `use-crash-test.ts` consumes the streamed agent run.
- `clarification.tsx` renders structured questions.

### Results

- `run-result.tsx` selects the completed-run experience.
- `parallel-result.tsx` renders the summary and view switch.
- `plan-comparison.tsx` renders the comparison table and explanations.
- `judge-graph-view.tsx` renders graph controls, decision details and trace navigation.
- `judge-graph-scene.tsx` renders nodes, edges, camera, labels and replay.
- `status.tsx` renders live progress.

### Shared structured presentation

- `decision-trace.ts` builds one decision record per slot.
- `explain.ts` creates table explanations from those records.
- `judge-graph.ts` creates graph data from the same records.
- `judge-layout.ts` positions nodes and routes edges.
- `judge-labels.ts` places labels in screen space.
- `judge-replay.ts` creates the animation timeline.
- `parallel-view.ts` projects saved run state into the UI model.

The table and graph therefore read the same structured decision history.

## Backend routes

### `POST /api/intake`

Processes one intake turn. It calls the model but not Qloo. Requests and returned state use Zod schemas.

### `POST /api/crashtest`

Accepts a validated brief, confirmed intake, or clarification answers. It can replay a cached run or execute a live run and stream Server-Sent Events.

The handler revalidates client state, rejects unsupported cities, applies rate limits, creates Qloo/model dependencies server-side, forwards cancellation, records successful runs, labels replays, and prevents duplicate clarification submissions from creating duplicate runs.

## Caching, recordings and deployment

The cache abstraction supports local use and Upstash Redis deployment. It stores Qloo responses, clarification sessions and completed-run recordings.

Recordings are keyed by the brief, architecture, behavior version, evidence version, adjudication version and ranking policy. Replays are labelled with their recording date.

The Qloo key remains server-side. Local ChatGPT credentials are stored in `.secrets/`, which is git-ignored; deployment uses the configured credential store.

## Evaluation framework

The `eval/` directory supports:

- fixed scenarios;
- conversational-intake evaluation;
- sequential and parallel runs;
- frozen starting plans and audience anchors;
- run fingerprints and output guards;
- summaries and architecture comparisons;
- blinded, order-swapped judging;
- plausibility and human-review sheets;
- sentinel comparisons;
- Markdown/JSON final reports;
- a separate key for blinded review;
- offline failure-pattern classification and representative-test selection.

Primary files:

- `scenario-cases.ts` — scenario prompts
- `scenario-intake.ts` — intake processing
- `scenario-run.ts` — execution
- `scenario-compare.ts` — architecture comparison
- `freeze-anchors.ts` — anchor freezing
- `final-report.ts` — reports and blinded review sheet
- `failure-patterns.ts` — read-only failure-directed selector

Output guards prevent multiple behavior versions from being mixed in one evaluation directory.

## Automated tests

The Vitest suite covers Qloo requests and normalization, entity roles and namesakes, intake, clarification, evaluation, ranking, constraints, parallel/sequential controllers, candidate screens, hybrid improvement, blind adjudication, stability, decision traces, graph layout/replay, result rendering, route handlers, streams, model structured output, credential storage and evaluation utilities.

At the time this brief was generated, the repository passed:

- 455 automated tests;
- TypeScript checking;
- ESLint;
- the optimized Next.js production build.

## Codebase map

```text
src/
  app/                  Pages and API routes
  components/           Chat, comparison and 3D graph UI
  lib/
    intake/             Brief extraction and confirmation
    clarify/            Pre-run material clarification
    crashtest/          Agent, evidence, evaluation and presentation
    qloo/               Typed Qloo integration
    llm/                ChatGPT credential and structured client
    engine/             Shared entity/locality utilities
    cache/              Memory/Redis cache abstraction
    server/             Handlers, SSE, dependencies and limits
eval/                   Scenarios, frozen baselines and reports
tests/                  Unit, integration, rendering and regressions
data/                   Measured market coverage
docs/                   Architecture, evaluation and submission material
handoff/                Product specifications and handoff documents
scripts/                Authentication and developer utilities
research/               Qloo research/probe scripts
```

## Local setup

Requirements: Node.js 22+, Qloo hackathon key and ChatGPT sign-in.

```bash
npm ci
cp .env.example .env.local
# Set QLOO_API_KEY in .env.local
npm run llm:login
npm run dev
```

Default URL: `http://localhost:3000`

Validation:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

The standalone repository defaults the application to the parallel engine. `RECOMMENDATION_ARCHITECTURE=sequential` runs the control.

## Files to inspect first

1. `handoff/CULTURAL_CRASH_TEST_PROJECT_SPEC.md` — challenge, criteria, rules and requirements
2. `README.md` — public product and setup overview
3. `src/lib/crashtest/parallel-run.ts` — controller
4. `src/lib/crashtest/agent.ts` — evidence-first agent
5. `src/lib/crashtest/matrix.ts` — evidence policy
6. `src/lib/crashtest/adjudicate.ts` — blind comparison
7. `src/lib/crashtest/stability.ts` — stability audit
8. `src/lib/crashtest/types.ts` — run-state and domain types
9. `src/lib/qloo/client.ts` and `normalize.ts` — Qloo integration
10. `src/components/parallel-result.tsx` and `judge-graph-scene.tsx` — results UI
11. `eval/` — evaluation harness
12. `tests/` — executable behavior specification

## Copy-paste instruction for the independent reviewer

> Read `handoff/CULTURAL_CRASH_TEST_PROJECT_SPEC.md` for the hackathon challenge, judging criteria and rules. Then read `handoff/INDEPENDENT_JUDGE_PROJECT_AND_CODEBASE_BRIEF.md` and inspect the complete repository. Run the tests and application where possible. Judge Cultural Crash-Test independently against each official criterion. Do not inherit earlier provisional scores or assume product claims are correct without checking the implementation. Explain the evidence for each score and distinguish required submission work from optional enhancements.
