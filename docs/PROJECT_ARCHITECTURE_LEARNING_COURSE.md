# Cultural Crash-Test: architecture and codebase learning course

This course teaches the current Cultural Crash-Test implementation from the outside in. It starts with the product idea, builds a correct mental model of the architecture, follows one run through the code, and finishes with code-reading exercises and judge-style questions.

The goal is not to memorize every file. The goal is to understand:

1. what problem the product solves;
2. why it is agentic;
3. where the LLM, Qloo, and deterministic code each contribute;
4. how a recommendation is produced, challenged, compared, and explained;
5. what the system deliberately does not claim;
6. where to look in the code when someone asks a technical question.

All links in this document point to the current repository. When a function is named, search for that function inside the linked file.

---

## How to use this course

Read it in four passes:

- **Pass 1 — Product understanding:** Lessons 1–3. You should be able to explain the project in ordinary language.
- **Pass 2 — Architecture:** Lessons 4–8. You should understand a complete run and the evidence agent.
- **Pass 3 — Implementation:** Lessons 9–14. Open the linked code while reading.
- **Pass 4 — Presentation:** Lessons 15–18. Practise the questions aloud without looking at the answers.

Suggested pace:

| Session | Read | Practical exercise |
|---|---|---|
| 1 | Lessons 1–3 | Explain the product in 30 seconds and two minutes |
| 2 | Lessons 4–6 | Draw the run pipeline from memory |
| 3 | Lessons 7–9 | Trace one component from Qloo evidence to its final state |
| 4 | Lessons 10–12 | Trace one HTTP request from the browser to the final result |
| 5 | Lessons 13–14 | Run tests and inspect one recorded result |
| 6 | Lessons 15–18 | Rehearse the technical and judge questions |

---

# Part I — The product mental model

## Lesson 1 — What Cultural Crash-Test does

A brand planning a launch makes several cultural choices at once:

- a music act;
- a collaboration brand;
- a venue;
- a creative direction.

A general LLM can produce a fluent, plausible plan, but it does not have to verify that the choices are supported for the intended audience in the intended city. Cultural Crash-Test compares three directions built from the same confirmed brief:

1. **The user's direction** — the choices the user actually supplied, with unspecified slots left open.
2. **The plain LLM direction** — a plan produced without Qloo evidence.
3. **The evidence-first agent direction** — a plan assembled from candidates retrieved, screened, and tested with Qloo.

All three are evaluated using the same evidence process. The system then performs a blind comparison, tests bounded improvements, runs stability checks, and presents a final recommendation with an evidence trail.

### The product's four decision slots

The canonical slot list is defined by `SLOTS` in [`src/lib/crashtest/types.ts`](../src/lib/crashtest/types.ts):

| Internal name | UI name | Representation |
|---|---|---|
| `artist_music` | Music act | Qloo artist entity |
| `brand_collaboration` | Collaboration brand | Qloo brand entity |
| `event_place` | Pop-up venue | Qloo place entity |
| `creative_direction` | Creative direction | Qloo tags rather than one entity |

The system compares complete plans, not isolated recommendations. A culturally strong artist is not automatically the correct answer if it conflicts with the venue, brand identity, user constraints, or the rest of the package.

### The shortest accurate pitch

> Cultural Crash-Test compares what a user planned, what an LLM would recommend alone, and what an evidence-first agent recommends after testing cultural choices with Qloo. It then shows what changed, why it changed, and how stable the decision is.

### The important non-claim

The system evaluates cultural support. It does **not** predict sales, attendance, revenue, virality, or commercial success.

Code enforcing this boundary:

- `COMMERCIAL_CLAIM` and `stripCommercialClaims()` in [`src/lib/crashtest/adjudicate.ts`](../src/lib/crashtest/adjudicate.ts)
- evidence limitations in `FinalVerdict` in [`src/lib/crashtest/types.ts`](../src/lib/crashtest/types.ts)

---

## Lesson 2 — Is this a multi-agent system?

No. The current architecture deliberately uses **one evidence-first recommendation agent**.

Several model-assisted roles exist, but they are not all autonomous agents:

| Role | What it does | Autonomous agent? |
|---|---|---|
| Conversational intake | Extracts facts and suggests missing audience hypotheses | No; bounded structured generation |
| Plain LLM track | Produces the baseline plan without Qloo | No; one isolated planner role |
| Evidence-first recommendation agent | Retrieves candidates, screens them, composes plans, challenges weak choices, and re-tests | **Yes; this is the agent** |
| Blind adjudicator | Compares anonymous plans using supplied evidence claims | No; bounded judge call with validated output |
| Clarification model | Helps identify a material ambiguity | No; bounded clarification role |
| Hybrid optimizer | Combines tested components and accepts only verified improvement | No; deterministic code |

The architecture avoids a multi-agent swarm because the task does not require agents with independent goals, memories, or tool permissions. More agents would add cost, latency, coordination errors, and a harder-to-explain result without automatically improving the recommendation.

The agent itself is implemented primarily in [`src/lib/crashtest/agent.ts`](../src/lib/crashtest/agent.ts).

### A useful answer for a judge

> We use one evidence-first agent because the task is one bounded optimization problem. Other LLM calls have narrow roles—intake, baseline planning, entity-role reading, and blind adjudication—but they do not operate as autonomous agents. The controller, budgets, evidence policy, and acceptance gates remain deterministic code.

---

## Lesson 3 — The three authorities in the system

The architecture separates three different kinds of authority.

### 1. The user supplies intent

The user owns:

- brand context;
- launch goal;
- audience description;
- city;
- existing choices;
- hard and soft constraints;
- whether a choice is fixed or merely preferred.

The confirmed source text is preserved so structured extraction cannot erase nuance. See `LaunchBriefSchema` in [`src/lib/crashtest/types.ts`](../src/lib/crashtest/types.ts).

### 2. Qloo supplies cultural evidence

Qloo contributes:

- entity identity and metadata;
- audience affinity;
- city and origin context;
- cross-domain affinity;
- tag affinity for creative direction;
- explainability signals;
- comparable candidate lists.

The app does not treat Qloo as an oracle for venue capacity, commercial availability, or business success.

### 3. Application code supplies policy and control

Code decides:

- which checks run;
- request budgets;
- which constraints are machine-verifiable;
- whether evidence is missing, supportive, or contradictory;
- candidate screens;
- acceptance and regression gates;
- stop conditions;
- whether a verdict is stable or provisional;
- what the UI is allowed to claim.

The LLM never receives unrestricted authority over these controls.

---

# Part II — Architecture from high level to execution

## Lesson 4 — The system in one diagram

```text
Natural-language conversation
          │
          ▼
Structured intake state ── optional material clarification
          │
          ▼
Confirmed LaunchBrief
          │
          ▼
Freeze brief + choose shared audience anchors + compile intent contract
          │
          ├──────────────┬──────────────────┐
          ▼              ▼                  ▼
      User track     Plain LLM track    Evidence agent track
          │              │                  │
          └──────────────┴──────────────────┘
                         │
                         ▼
              Same Qloo evidence checks
                         │
                         ▼
                  Evidence matrix
                         │
                         ▼
        Hard gates → blind comparison in two orders
                         │
                         ▼
           Bounded hybrid/improvement re-tests
                         │
                         ▼
               Final blind comparison
                         │
                         ▼
      Full-plan re-test + recommendation stability audit
                         │
                         ▼
             Final verdict stored in RunState
                         │
                  ┌──────┴──────┐
                  ▼             ▼
          Comparison table   Decision graph
```

The main controller is `runParallelCrashTest()` in [`src/lib/crashtest/parallel-run.ts`](../src/lib/crashtest/parallel-run.ts).

The complete history is stored in `RunState`, defined in [`src/lib/crashtest/types.ts`](../src/lib/crashtest/types.ts). The UI renders that state; it does not reconstruct decisions from a fresh model explanation.

---

## Lesson 5 — Intake and clarification

### Conversational intake

The user does not need to fill a rigid form. Each message is processed as one turn:

1. `extractFacts()` extracts only facts actually stated by the user.
2. `mergeFacts()` merges those facts into the current brief.
3. `refresh()` deterministically recomputes missing fields and readiness.
4. `questionsFor()` selects only the next necessary questions.
5. `respond()` produces the next conversational response.
6. `toLaunchBrief()` converts the confirmed intake into the domain model.

Read these files in order:

- [`src/lib/intake/types.ts`](../src/lib/intake/types.ts) — intake schemas and limits
- [`src/lib/intake/extract.ts`](../src/lib/intake/extract.ts) — fact extraction and audience hypotheses
- [`src/lib/intake/validate.ts`](../src/lib/intake/validate.ts) — deterministic completeness checks
- [`src/lib/intake/state.ts`](../src/lib/intake/state.ts) — conversation state machine
- [`src/lib/server/handlers.ts`](../src/lib/server/handlers.ts) — `handleIntake()` HTTP boundary

### Why intake and the recommendation agent are separate

Intake understands what the user means. The agent researches and tests the plan. Keeping them separate prevents the recommendation stage from silently rewriting the brief.

### Optional clarification gate

Clarification is meant for ambiguity that could materially change the recommendation, not for asking the user to repeat information already present.

The server supports clarification sessions through:

- `handleClarificationStart()`;
- `handleClarificationAnswer()`;
- `clarifyThenRun()`;
- `attachClarification()`.

The session remains server-side and has a two-hour TTL. Delegated answers and unresolved questions are attached to the final run so the result can be marked provisional when necessary.

Clarification orchestration lives in [`src/lib/server/handlers.ts`](../src/lib/server/handlers.ts), with its domain implementation under [`src/lib/clarify/`](../src/lib/clarify/).

---

## Lesson 6 — Freezing the problem before generating answers

Before tracks run, the system freezes a validated brief with `freezeBrief()` in [`src/lib/crashtest/tracks.ts`](../src/lib/crashtest/tracks.ts).

Freezing provides:

- an immutable copy of the brief;
- a stable fingerprint;
- evidence that every plan began from the same input;
- protection against one track modifying shared state;
- reproducibility for recordings and evaluations.

The system next chooses **shared measurement anchors** using `measurementAnchors()`. Audience anchors are real Qloo entities—usually brands or artists representing the target audience. Every candidate plan is evaluated against the same anchors.

If the user supplied anchors, those are used. If not, model-suggested anchors are treated as hypotheses and labelled accordingly. A model-suggested anchor is not silently treated as a user fact.

The system also compiles an `IntentContract` with `compileIntent()` in [`src/lib/crashtest/intent.ts`](../src/lib/crashtest/intent.ts). This converts the confirmed brief into cited, structured intent such as:

- fixed, preferred, or considered choices;
- requested event format;
- neighbourhood requirements;
- distinctiveness preferences;
- qualities the brief asks to avoid;
- brand attributes.

The contract is not a second brief. Every contract field cites where it came from in the actual brief.

---

## Lesson 7 — The three parallel tracks

The three tracks are started together in `runParallelCrashTest()` with `Promise.allSettled()`.

### Track U — User plan

Implemented by `buildUserTrack()` in [`src/lib/crashtest/tracks.ts`](../src/lib/crashtest/tracks.ts).

- Includes only choices the user actually named.
- Leaves unspecified slots open.
- Resolves named choices to Qloo entities or tags.
- Preserves fixed choices.
- Does not let the LLM complete the user's plan and then call that completion “the user plan.”

### Track L — Plain LLM plan

Implemented by:

- `generateLlmDraft()`;
- `resolveLlmTrack()`;
- supporting resolution functions in [`src/lib/crashtest/plan.ts`](../src/lib/crashtest/plan.ts).

The LLM sees the frozen brief but no Qloo evidence. It creates the honest baseline: what a capable LLM might recommend from language knowledge alone.

The generated names are then resolved to Qloo entities so the baseline can be tested fairly. Resolution is not evidence-informed planning; it is identity matching needed for measurement.

### Track A — Evidence-first agent

Implemented by `runEvidenceAgent()` in [`src/lib/crashtest/agent.ts`](../src/lib/crashtest/agent.ts).

The agent receives:

- the frozen brief;
- shared audience anchors;
- the intent contract;
- fixed choices;
- Qloo tools;
- deterministic screens;
- evaluation and matrix functions;
- strict iteration, beam-width, and Qloo-call budgets.

It does **not** receive the plain LLM plan. It does not merely repair the LLM's answer. It builds its own plan independently.

An unlocked user choice can enter the agent's candidate pool, but it is not automatically forced into the agent's plan. A locked choice is mandatory.

### Failure isolation

The controller waits for all three promises to settle before reporting a track failure. This prevents one rejected promise from returning while other tracks continue spending budget or emitting events.

---

## Lesson 8 — Inside the evidence-first agent

This is the most important lesson if someone asks why the project is agentic.

### Step 1: Resolve user choices independently

The agent resolves the user's named choices itself. Artists and brands receive namesake protection. Creative direction is mapped to Qloo tags through `mapDirection()`.

Related functions:

- `resolveEntityComponent()` in [`src/lib/crashtest/plan.ts`](../src/lib/crashtest/plan.ts)
- `namesake()` in the same file
- `directionVocabulary()` and `mapDirection()` in the same file

### Step 2: Build candidate pools

For entity slots, `entityPool()` retrieves multiple candidate views rather than trusting one ranked list. Candidates can come from audience affinity, locality, and brief-fit lanes.

Important constants in [`src/lib/crashtest/agent.ts`](../src/lib/crashtest/agent.ts):

- `VIEW_SIZE = 25`;
- `POOL_SIZE = 6`;
- `RESERVE_SIZE = 12`;
- `BEAM_WIDTH = 6`;
- `ROLE_CHECK_SIZE = 10`.

The agent keeps a small active pool for plan composition and a reserve for later challenge rounds.

### Step 3: Screen candidates

`screenEntity()` combines deterministic and structured screens. The screens ask questions such as:

- Is the entity the correct type for the slot?
- Can this kind of venue host the requested format?
- Is it in the launch market?
- Does it fit a named neighbourhood?
- Does it conflict with a machine-verifiable hard rule?
- Does Qloo's description match a quality the brief explicitly avoids?
- Is it an extreme global default when distinctiveness was requested?
- Could a headline act or arena-scale room make the product secondary?
- Does the entity credibly perform the role required by the brief?

The lower-level screens are in [`src/lib/crashtest/screens.ts`](../src/lib/crashtest/screens.ts) and [`src/lib/crashtest/repair.ts`](../src/lib/crashtest/repair.ts).

Important screen functions:

- `preferredCategories()`;
- `hostTier()` and `selectionHostTier()`;
- `brandRole()`;
- `neighborhoodFit()`;
- `mainstreamFlag()`;
- `centralityFlag()`;
- `avoidedMatch()`;
- `venueFormat()`;
- `roleFits()`;
- `fitsBrief()`.

`checkRoles()` uses the model only to read supplied Qloo facts against a structured role question. The result is stored as a screen, not mislabelled as Qloo evidence.

### Step 4: Compose complete plans with bounded beam search

`beamSearch()` combines the slot pools into a bounded number of promising complete bundles. It does not enumerate every mathematical combination.

`bundleVector()` provides an inexpensive proxy ordering before expensive complete-plan Qloo evaluation. The beam keeps the search broad enough to compare coherent packages while respecting the call budget.

### Step 5: Evaluate complete bundles

Every retained bundle is run through the same full evidence pipeline. The agent does not choose a plan merely because its individual components looked promising during retrieval.

The initial incumbent is selected by:

- `evidenceVector()` from the evidence matrix;
- additional agent screen flags from `selectionFlags()`;
- the combined lexicographic key from `agentKey()`.

### Step 6: Challenge the incumbent

The agent does not stop after its first plan.

`weakestSlot()` identifies the weakest adjustable component from recorded evidence claims. Screen-level mismatches—wrong role, outside a named neighbourhood, generic default—are challenged before weaker numerical evidence.

The agent chooses one untried alternative from the active pool or reserve, substitutes it, and re-evaluates the entire plan.

### Step 7: Accept only a verified improvement

The candidate plan must:

- preserve hard rules;
- avoid losing brief or role fit;
- avoid introducing a generic bundle problem;
- rank materially better under the versioned selection order;
- pass a complete-plan re-test.

If the alternative fails, it is recorded and rejected. The agent stops for a declared reason such as `no_weakness`, `no_improvement`, `no_alternative`, `round_limit`, or `budget`.

### Agent-loop pseudocode

```text
resolve locked and preferred user choices
retrieve multi-view candidates for each open/unlocked slot
screen candidates for role, locality, brief fit, and distinctiveness
keep a pool and reserve per slot
compose a bounded beam of complete plans
evaluate each complete plan with Qloo
choose the best evidence-backed incumbent

for each allowed challenge round:
    identify the weakest adjustable slot
    select the strongest untried alternative
    substitute it into the whole plan
    re-test the whole plan
    accept only if all guards pass and the plan materially improves
    otherwise record rejection and stop or try the next bounded round

return incumbent + tested alternatives + evidence + stop reason
```

---

# Part III — Evidence, evaluation, and decision policy

## Lesson 9 — How Qloo is called

The typed Qloo boundary is defined by `QlooClient` in [`src/lib/qloo/types.ts`](../src/lib/qloo/types.ts).

The client supports:

- `searchEntities()`;
- `getEntities()`;
- `getDemographics()`;
- `searchTags()`;
- `getInsights()`;
- `compareProfiles()`.

Implementation layers:

| File | Responsibility |
|---|---|
| [`src/lib/qloo/http.ts`](../src/lib/qloo/http.ts) | HTTP calls, query encoding, concurrency, retry/backoff |
| [`src/lib/qloo/client.ts`](../src/lib/qloo/client.ts) | Typed Qloo methods and request parameters |
| [`src/lib/qloo/normalize.ts`](../src/lib/qloo/normalize.ts) | Converts varying API responses into stable internal entities |
| [`src/lib/qloo/cached.ts`](../src/lib/qloo/cached.ts) | Server-side response caching and request statistics |
| [`src/lib/qloo/server.ts`](../src/lib/qloo/server.ts) | Environment-backed server client |
| [`src/lib/qloo/errors.ts`](../src/lib/qloo/errors.ts) | Structured error categories |

### Evidence collection

`gatherEvidence()` in [`src/lib/crashtest/gather.ts`](../src/lib/crashtest/gather.ts) runs the same major checks for every plan component:

1. **Audience:** Does the shared audience, in this city, show affinity for the choice?
2. **Local:** Is the choice locally relevant, from the market, or a generic/global default?
3. **Coherence:** Does the choice show affinity with the plan's other components?
4. **Creative direction:** Do its mapped tags appear for the audience and package in the city?

When an audience anchor is also used as a plan choice, the system leaves that anchor out of its own signal. This avoids the circular test “does X have affinity for X?”

### Why Qloo data is not used raw

An affinity rank alone cannot answer whether a place can host an event, whether a brand is the right type of partner, whether a fixed choice must remain, or whether evidence is missing. Qloo evidence is combined with explicit logical rules, while the UI preserves the source distinction.

---

## Lesson 10 — The evidence ledger

Every evidence-producing action creates an `EvidenceRecord` in the run's ledger. The ledger is implemented in [`src/lib/crashtest/ledger.ts`](../src/lib/crashtest/ledger.ts).

Each record stores:

- a stable evidence ID such as `E17`;
- the purpose of the query;
- query kind;
- track or stage scope;
- sanitized request parameters;
- Qloo entity IDs;
- compact top results;
- total result count;
- coverage status;
- warnings;
- iteration and timestamp.

The ledger never stores the secret API key.

Important functions:

- `createLedger()` — creates ordered evidence records;
- `scopedLedger()` — marks which track or stage collected evidence;
- `sanitizeInsights()` — preserves reproducible parameters without secrets;
- `itemsFrom()` — keeps compact, display-safe results;
- `budgeted()` — enforces the Qloo-call ceiling before a request;
- `memoized()` — reuses identical successful requests inside one run.

### Budget versus cache

The run budget counts work requested by the algorithm, even if a response is served from cache. Memoization still prevents repeated outbound calls and reduces latency.

### Why the ledger matters

The ledger makes the recommendation inspectable. The table, graph, report, and explanation nodes can point to the exact recorded evidence rather than asking an LLM to invent a rationale after the decision.

---

## Lesson 11 — Component evaluation

The first evaluation layer is implemented in [`src/lib/crashtest/evaluate.ts`](../src/lib/crashtest/evaluate.ts).

`assessComponent()` scores four dimensions when evidence exists:

| Dimension | Weight | Source |
|---|---:|---|
| Audience affinity | 0.35 | Qloo |
| Local relevance | 0.30 | Qloo data plus explicit locality logic |
| Package coherence | 0.25 | Qloo |
| Distinctness | 0.10 | Application heuristic for duplication |

Important rule: a missing dimension is excluded from the weighted denominator. It is **not converted to zero**.

A component is `supported` only when:

- total score is at least `0.60`;
- audience score is at least `0.60`;
- local score is at least `0.60`;
- every creative-direction tag is in the audience list;
- it is not a duplicate.

The base component statuses are:

- `supported`;
- `weak`;
- `no_support`;
- `unresolved`;
- `constraint_conflict`.

`evaluatePlan()` aggregates component assessments, counts supported and contradicted choices, checks hard violations, records the weakest adjustable slots, and determines whether the plan is acceptable.

### A subtle but important distinction

“No support returned” does not always mean “contradicted.” A famous local entity may be missing from a city-filtered affinity result. The evaluator records thin evidence separately from affirmative evidence against a choice.

---

## Lesson 12 — The evidence matrix

The parallel architecture needs a richer comparison than a single weighted score. `buildEvidenceMatrix()` in [`src/lib/crashtest/matrix.ts`](../src/lib/crashtest/matrix.ts) converts every evaluated candidate into structured claims.

Each `EvidenceClaim` contains:

- candidate ID;
- optional slot;
- evidence dimension;
- human-readable claim;
- stance: `supports`, `contradicts`, or `unknown`;
- source;
- evidence IDs;
- optional declared rule ID;
- strength;
- limitations.

The matrix keeps these concepts separate:

- **quality:** what the evidence says;
- **coverage:** how much the system could measure;
- **completeness:** how many plan slots are filled;
- **hard failures:** deterministic vetoes;
- **component state:** what a person should infer.

### Component states in the parallel UI

- `supported`;
- `plausible_thin`;
- `conflicting`;
- `unverified`;
- `needs_human`;
- `rejected`.

### The evidence decision vector

`evidenceVector()` creates a lexicographic policy. “Lexicographic” means earlier positions are more important; many lower-priority positives cannot cancel one higher-priority failure.

Current priority order:

1. fewer hard failures;
2. explicit locks preserved;
3. plan completeness;
4. fewer explicit brief-fit contradictions;
5. fewer structured role doubts;
6. positive role and brief fit, including weighted user preferences;
7. audience support across choices;
8. city locality;
9. cross-component coherence;
10. distinctiveness, only when requested by the brief;
11. evidence coverage, used as confidence rather than quality.

This ordering prevents several unrelated affinity wins from hiding one material contradiction, such as the wrong venue format or a choice outside a named neighbourhood.

The rules are declared in `RULES` in the same file. Logical claims must cite a declared rule; Qloo claims cite ledger evidence.

---

## Lesson 13 — Blind adjudication

`adjudicate()` in [`src/lib/crashtest/adjudicate.ts`](../src/lib/crashtest/adjudicate.ts) compares complete plans.

### Before the model sees anything

Code:

1. removes candidates with hard failures;
2. merges candidates with identical choices;
3. checks whether coverage is sufficient to compare;
4. assigns random blind IDs;
5. replaces internal claim IDs with per-prompt aliases;
6. removes track identity.

The judge sees “Plan P-AB12,” not “agent plan.”

### Two-order comparison

`rotatedOrders()` produces two orders in which every plan changes position. `judgeOnce()` runs the same bounded judge prompt for each order.

The returned structure is validated:

- winner ID must be one of the blind IDs shown;
- cited claim IDs must exist;
- at least one decisive claim must belong to the winner;
- output must match the schema;
- commercial claims are removed.

If the two orders disagree, the result is `unstable`. The system does not average the answers into a fake certainty.

### Why use an LLM judge at all?

The evidence contains heterogeneous claims: intent, constraints, role fit, affinity, locality, coherence, and limitations. A bounded judge can synthesize these into a readable comparison. But deterministic hard gates, source claims, ID validation, order rotation, and the evidence ordering constrain that synthesis.

The final plan is not required to be the agent plan. It may be the user's plan, the plain LLM plan, the agent plan, or a tested hybrid.

---

## Lesson 14 — Hybrid improvement and stability

### Hybrid improvement

After initial adjudication, `optimize()` in [`src/lib/crashtest/hybrid.ts`](../src/lib/crashtest/hybrid.ts) can create bounded hybrid candidates.

It may try:

- the strongest tested component for each slot across contenders;
- a single stronger component from another plan;
- a targeted search result when enabled by the caller.

Every hybrid is evaluated as a complete plan. `judgeHybrid()` rejects a hybrid if it:

- introduces a hard failure;
- increases constraint violations;
- loses brief or role fit;
- loses a supported choice without removing a contradiction;
- fails to produce material plan-level improvement.

Only the best passing hybrid in the round is accepted.

In the current parallel controller, cross-track optimization is deliberately limited to one bounded round, and targeted search is disabled there because the evidence agent already performed its own candidate search and challenge loop.

### Stability audit

`auditRecommendationStability()` in [`src/lib/crashtest/stability.ts`](../src/lib/crashtest/stability.ts) asks whether the recommendation survives controlled changes.

It checks:

1. the recorded blind-order judgments;
2. leave-one-audience-anchor-out re-tests for up to three anchors.

Outcomes are:

- `preserved`;
- `tied`;
- `reversed`;
- `unavailable`.

This is not a probability of success. It is a sensitivity audit: did the recommendation survive the tested perturbation?

If a verdict is unstable, evidence is insufficient, an explicit contradiction remains, or a clarification remains unresolved, the UI presents the leading plan as provisional.

---

# Part IV — Control plane, model responsibilities, and runtime

## Lesson 15 — What the LLM does and does not do

### Model-assisted responsibilities

The model may:

- extract structured facts from a user message;
- suggest audience hypotheses when the user delegates that choice;
- draft the plain LLM baseline;
- infer likely countries for user-named entities to protect against namesakes;
- map creative language to Qloo tags;
- read supplied entity facts for a structured role screen;
- perform blind evidence adjudication;
- write limited natural-language summaries from recorded state.

### Code-enforced responsibilities

Code controls:

- schema validation;
- supported markets;
- brief freezing and fingerprints;
- track isolation;
- budgets and concurrency;
- Qloo calls and caching;
- evidence recording;
- scoring and status thresholds;
- hard constraints and locks;
- candidate screens;
- candidate IDs and claim IDs;
- improvement acceptance;
- stop conditions;
- blind-order agreement;
- stability status;
- provisional labels;
- what the UI and report render.

### Structured model output

`generateStructured()` in [`src/lib/llm/structured.ts`](../src/lib/llm/structured.ts):

1. asks for JSON matching a Zod schema;
2. extracts the JSON payload;
3. validates it;
4. can retry after validation errors;
5. returns typed data and usage.

The model cannot introduce arbitrary fields into the typed control state.

---

## Lesson 16 — API, streaming, caching, and recordings

### HTTP routes

- [`src/app/api/intake/route.ts`](../src/app/api/intake/route.ts) handles conversational intake.
- [`src/app/api/crashtest/route.ts`](../src/app/api/crashtest/route.ts) handles the crash test and streams events.

Both delegate to [`src/lib/server/handlers.ts`](../src/lib/server/handlers.ts).

### Server-sent events

`eventStream()` converts callback emissions from the run controller into an async stream. `sseResponse()` in [`src/lib/server/sse.ts`](../src/lib/server/sse.ts) serializes that stream to the browser.

The client can receive events such as:

- stage changes;
- evidence records;
- plans;
- evaluations;
- actions;
- accepted or rejected changes;
- budget updates;
- final state;
- errors.

### Recordings

`runKey()` includes behavior and rubric versions so a recording produced by old logic cannot silently masquerade as a current run.

`record()` stores a completed non-error run. `replay()` streams it with short pauses and changes provenance to `recorded`, including its date. A recording is never labelled live.

### Rate limiting

[`src/lib/server/rate-limit.ts`](../src/lib/server/rate-limit.ts) provides memory and Redis limiters. Replays do not consume a live-run allowance.

### Credentials

The LLM client is behind the `LlmClient` interface in [`src/lib/llm/types.ts`](../src/lib/llm/types.ts).

Current implementation files:

- [`src/lib/llm/chatgpt.ts`](../src/lib/llm/chatgpt.ts) — streaming Responses-style client;
- [`src/lib/llm/chatgpt-auth.ts`](../src/lib/llm/chatgpt-auth.ts) — device-code login and token refresh;
- [`src/lib/llm/credential-store.ts`](../src/lib/llm/credential-store.ts) — local file or Upstash credential storage;
- [`src/lib/llm/index.ts`](../src/lib/llm/index.ts) — environment-backed construction.

Secrets stay on the server. `.env.local` and `.secrets/` are git-ignored.

---

# Part V — User interface and explainability

## Lesson 17 — How the result is projected for a person

The UI does not receive a free-form “chain of thought.” It receives recorded state and converts it into inspectable views.

### Parallel result projection

`parallelView()` in [`src/lib/crashtest/parallel-view.ts`](../src/lib/crashtest/parallel-view.ts) produces:

- the recommendation headline;
- stable versus provisional status;
- coverage and component counts;
- one comparison row per slot;
- supporting, counter, and unknown claims;
- alternatives;
- a decision path;
- initial and final adjudication summaries.

`toParallelMarkdown()` creates the downloadable report from the same projection.

### Comparison table

[`src/components/parallel-result.tsx`](../src/components/parallel-result.tsx) renders:

- user, LLM, agent, and final columns;
- decision receipt;
- recorded status per choice;
- progressively disclosed “Why this won” sections;
- stability checks;
- human checks;
- assumptions, limitations, and rejected alternatives;
- method and usage details.

### Decision graph

The current parallel graph is created by `buildParallelJudgeGraph()` in [`src/lib/crashtest/parallel-judge-graph.ts`](../src/lib/crashtest/parallel-judge-graph.ts).

Rendering pipeline:

1. graph data: [`src/lib/crashtest/judge-graph.ts`](../src/lib/crashtest/judge-graph.ts);
2. deterministic positions and routed edges: [`src/lib/crashtest/judge-layout.ts`](../src/lib/crashtest/judge-layout.ts);
3. replay timeline: [`src/lib/crashtest/judge-replay.ts`](../src/lib/crashtest/judge-replay.ts);
4. collision-aware label placement: [`src/lib/crashtest/judge-labels.ts`](../src/lib/crashtest/judge-labels.ts);
5. Three.js scene: [`src/components/judge-graph-scene.tsx`](../src/components/judge-graph-scene.tsx);
6. tabs, evidence inspection, text fallback, and controls: [`src/components/judge-graph-view.tsx`](../src/components/judge-graph-view.tsx).

The graph has two levels:

- **Overview:** brief → final choices → final plan.
- **Focused choice:** user/LLM/agent alternatives → evidence groups → blind comparison → stability checks → final choice.

Selecting an evidence node shows the recorded query, returned entities, coverage, source, and sanitized request.

The graph includes a text decision trace so the result remains inspectable without WebGL or motion.

---

# Part VI — Architecture approaches in the repository

## Lesson 18 — Sequential control versus parallel architecture

Both architectures remain in the repository.

### Sequential architecture

Controller: `runCrashTest()` in [`src/lib/crashtest/run.ts`](../src/lib/crashtest/run.ts).

```text
Brief → LLM draft → resolve → Qloo evaluation → diagnose weakest choice
      → retrieve alternatives → full-plan re-test → accept/reject → repeat
```

This was the original control. It is useful because it shows whether the newer parallel architecture actually improves on a simpler baseline.

Main sequential repair functions are in [`src/lib/crashtest/repair.ts`](../src/lib/crashtest/repair.ts):

- `fuseRanks()`;
- `screen()`;
- `repairEntity()`;
- `repairDirection()`;
- `applyRepair()`.

### Parallel architecture

Controller: `runParallelCrashTest()` in [`src/lib/crashtest/parallel-run.ts`](../src/lib/crashtest/parallel-run.ts).

```text
Same frozen brief
  ├─ user track
  ├─ LLM-only track
  └─ evidence-agent track
        ↓
same evaluation → evidence matrix → blind adjudication → bounded hybrid → stability
```

This is the standalone application's current default through `appArchitecture()` in [`src/lib/server/handlers.ts`](../src/lib/server/handlers.ts), even though the generic library-level `DEFAULT_ARCHITECTURE` remains sequential for control compatibility.

### Why parallel is the product architecture

- It provides a fair LLM-alone baseline.
- The agent does not inherit the LLM's choices.
- It exposes whether the user's original direction was already strongest.
- It can choose a hybrid when evidence supports components from different plans.
- It does not hard-code the agent as winner.
- It produces a clearer judge-facing comparison.

---

# Part VII — Evaluation and testing

## Lesson 19 — How the system is evaluated

The evaluation code lives under [`eval/`](../eval/).

Important files:

| File | Purpose |
|---|---|
| [`eval/cases.ts`](../eval/cases.ts) | Core evaluation cases |
| [`eval/scenario-cases.ts`](../eval/scenario-cases.ts) | Conversational scenario set |
| [`eval/run.ts`](../eval/run.ts) | Runs and meters evaluation cases |
| [`eval/judge.ts`](../eval/judge.ts) | Plan-level and evidence-based evaluation judges |
| [`eval/summary.ts`](../eval/summary.ts) | Aggregates metrics and promotion gates |
| [`eval/compare.ts`](../eval/compare.ts) | Compares two evaluation tags |
| [`eval/frozen.ts`](../eval/frozen.ts) | Protects frozen baselines |
| [`eval/plausibility.ts`](../eval/plausibility.ts) | Human plausibility-review structure |
| [`eval/failure-patterns-lib.ts`](../eval/failure-patterns-lib.ts) | Classifies failures and selects minimal representative reruns |

### Why frozen baselines matter

If the inputs, audience anchors, or baseline plan change while comparing agent versions, the comparison becomes ambiguous. Frozen evaluation assets make before/after comparisons meaningful.

### Why blind review matters

Reviewers should not know which plan came from the agent before scoring it. Blinding tests output quality rather than architecture branding.

### Failure-directed evaluation

`failurePatterns()` classifies observed problems. `selectPatternRepresentatives()` chooses the smallest group of scenarios covering those patterns. This avoids rerunning stable scenarios and wasting model/Qloo budget.

### Test suite

The automated tests under [`tests/`](../tests/) cover:

- intake and clarification;
- entity resolution and namesakes;
- evidence gathering and scoring;
- constraints and repair acceptance;
- agent pools and beam search;
- evidence matrix and adjudication;
- hybrid improvement and stability;
- caching, handlers, rate limiting, and SSE;
- table and graph projections;
- label collision, graph fitting, and replay timelines.

Current verification commands:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

---

# Part VIII — What exists and what does not

## Lesson 20 — Implemented today

- Natural-language conversational intake
- Structured and validated launch brief
- Rare material-ambiguity clarification flow
- Supported-city gating
- User, LLM, and evidence-agent tracks
- One evidence-first agent with bounded search and self-challenge
- Entity and namesake resolution
- Creative-direction tag mapping
- Shared audience anchors
- Qloo affinity, locality, coherence, and explainability evidence
- Evidence ledger with sanitized requests
- Hard constraints and fixed choices
- Venue, brand-role, neighbourhood, distinctiveness, and centrality screens
- Complete-plan evaluation
- Structured evidence matrix
- Two-order blind adjudication
- Bounded hybrid improvement
- Full-plan re-tests
- Leave-one-anchor-out stability checks
- Provisional results when evidence or verdicts are unstable
- Recorded-run cache and clearly labelled replay
- Streaming progress
- Rate limits and Qloo-call budgets
- User/LLM/agent/final comparison table
- Interactive decision graph and evidence inspection
- Markdown report export
- Frozen evaluation and failure-directed rerun selection

## Lesson 21 — Deliberately not implemented

- A multi-agent swarm
- Unbounded autonomous loops
- Autonomous purchasing, booking, contacting, or publishing
- Personal profiling or individual-level prediction
- A commercial-success probability
- Sales, attendance, revenue, or virality forecasts
- Automatic claims about venue capacity, availability, or willingness to collaborate
- Treating missing Qloo data as negative evidence
- A requirement that the agent must win
- Silent replacement of fixed choices
- Persistent learning from all users or model fine-tuning
- General web crawling as part of the core recommendation loop
- Exhaustive search over every possible cultural combination

These omissions are not accidental. They keep the system bounded, honest, inspectable, and demonstrable.

---

# Part IX — Guided code-reading labs

## Lab 1 — Learn the domain model

Open [`src/lib/crashtest/types.ts`](../src/lib/crashtest/types.ts).

Read in this order:

1. `SLOTS` and `SLOT_TYPE`;
2. `LaunchBriefSchema`;
3. `Component` and `CulturalPlan`;
4. `EvidenceRecord`;
5. `ComponentAssessment` and `PlanEvaluation`;
6. `RunState`;
7. `CandidatePlan`;
8. `EvidenceClaim` and `EvidenceMatrix`;
9. `AdjudicationResult`;
10. `StabilityAudit`;
11. `FinalVerdict` and `ParallelResult`.

Exercise: explain the difference between `ComponentStatus`, `ComponentState`, and `ClaimStance`.

Answer:

- `ComponentStatus` is the base evaluator's status.
- `ComponentState` is the person-facing interpretation in the parallel evidence matrix.
- `ClaimStance` belongs to one evidence claim and can support, contradict, or remain unknown.

## Lab 2 — Trace the controller

Open [`src/lib/crashtest/parallel-run.ts`](../src/lib/crashtest/parallel-run.ts) and follow `runParallelCrashTest()`.

Write down where it:

1. parses and freezes the brief;
2. creates counters and scoped clients;
3. chooses anchors;
4. compiles the intent contract;
5. starts three tracks;
6. evaluates them;
7. builds candidates;
8. adjudicates;
9. optimizes;
10. re-adjudicates;
11. audits stability;
12. constructs `FinalVerdict`;
13. emits the finished state.

Exercise: find every place where a budget or cancellation can stop the run.

## Lab 3 — Follow one Qloo check

Start with `gatherEvidence()` in [`src/lib/crashtest/gather.ts`](../src/lib/crashtest/gather.ts).

Follow an artist choice through:

1. `entityHit()`;
2. `QlooClient.getInsights()`;
3. the ledger record;
4. `listDimension()` in [`src/lib/crashtest/evaluate.ts`](../src/lib/crashtest/evaluate.ts);
5. `assessComponent()`;
6. `claimsFor()` in [`src/lib/crashtest/matrix.ts`](../src/lib/crashtest/matrix.ts);
7. `parallelView()` in [`src/lib/crashtest/parallel-view.ts`](../src/lib/crashtest/parallel-view.ts);
8. `ClaimList` in [`src/components/parallel-result.tsx`](../src/components/parallel-result.tsx).

Exercise: identify exactly where “missing evidence is not failure” is enforced.

## Lab 4 — Understand the agent

Open [`src/lib/crashtest/agent.ts`](../src/lib/crashtest/agent.ts).

Read:

1. `Proxy` and `PoolCandidate`;
2. `bundleVector()`;
3. `beamSearch()`;
4. `checkRoles()`;
5. `screenEntity()`;
6. `entityPool()`;
7. `selectionFlags()` and `agentKey()`;
8. `runEvidenceAgent()`;
9. `weakestSlot()`;
10. `neighborhoodCentroid()`.

Exercise: explain why the agent needs both a pool and a reserve.

Answer: the pool supplies components for initial beam-search bundles; the reserve preserves credible alternatives for challenge rounds without exploding the initial combination count.

## Lab 5 — Understand blind comparison

Open [`src/lib/crashtest/adjudicate.ts`](../src/lib/crashtest/adjudicate.ts).

Read:

1. `mergeIdentical()`;
2. `judgePrompt()`;
3. `judgeOnce()`;
4. `rotatedOrders()`;
5. `adjudicate()`;
6. `stripCommercialClaims()`.

Exercise: list every piece of information hidden from the judge model.

Answer: original track identity, internal candidate IDs, and semantic meaning of display position. It sees random blind IDs and aliased evidence claims.

## Lab 6 — Understand the graph

Open these in order:

1. [`src/lib/crashtest/parallel-judge-graph.ts`](../src/lib/crashtest/parallel-judge-graph.ts);
2. [`src/lib/crashtest/judge-layout.ts`](../src/lib/crashtest/judge-layout.ts);
3. [`src/lib/crashtest/judge-replay.ts`](../src/lib/crashtest/judge-replay.ts);
4. [`src/components/judge-graph-scene.tsx`](../src/components/judge-graph-scene.tsx);
5. [`src/components/judge-graph-view.tsx`](../src/components/judge-graph-view.tsx).

Exercise: explain why the graph is evidence visualization rather than a visualization of hidden model chain-of-thought.

Answer: every graph node and edge is projected from structured run state, evidence claims, recorded candidates, adjudication, and stability checks. The UI never requests or displays private chain-of-thought.

## Lab 7 — Understand production behavior

Open [`src/lib/server/handlers.ts`](../src/lib/server/handlers.ts).

Trace:

1. request validation;
2. intake revalidation;
3. clarification session handling;
4. recording lookup;
5. live-run limiter;
6. dependency construction;
7. SSE streaming;
8. recording persistence;
9. replay provenance.

Exercise: explain why the server does not trust `readyToRun` sent by the browser.

Answer: client state can be stale or modified. The server calls `refresh()` and validates the resulting `LaunchBrief` before starting an expensive run.

---

# Part X — Function reference map

Use this table when someone asks “where is that implemented?”

| Concern | Primary functions | File |
|---|---|---|
| Intake extraction | `extractFacts()`, `mergeFacts()` | [`src/lib/intake/extract.ts`](../src/lib/intake/extract.ts) |
| Intake state machine | `newIntake()`, `questionsFor()`, `respond()`, `applyIntake()` | [`src/lib/intake/state.ts`](../src/lib/intake/state.ts) |
| Intake validation | `missingFields()`, `refresh()`, `toLaunchBrief()` | [`src/lib/intake/validate.ts`](../src/lib/intake/validate.ts) |
| Architecture selection | `architectureFrom()`, `runVersionFor()` | [`src/lib/crashtest/version.ts`](../src/lib/crashtest/version.ts) |
| Sequential controller | `runCrashTest()` | [`src/lib/crashtest/run.ts`](../src/lib/crashtest/run.ts) |
| Parallel controller | `runParallelCrashTest()`, `finalVerdict()` | [`src/lib/crashtest/parallel-run.ts`](../src/lib/crashtest/parallel-run.ts) |
| Frozen brief | `freezeBrief()` | [`src/lib/crashtest/tracks.ts`](../src/lib/crashtest/tracks.ts) |
| Audience measurement | `measurementAnchors()` | [`src/lib/crashtest/tracks.ts`](../src/lib/crashtest/tracks.ts) |
| User track | `buildUserTrack()` | [`src/lib/crashtest/tracks.ts`](../src/lib/crashtest/tracks.ts) |
| LLM track | `generateLlmDraft()`, `resolveLlmTrack()` | [`src/lib/crashtest/tracks.ts`](../src/lib/crashtest/tracks.ts) |
| Entity resolution | `findInMarket()`, `namesake()`, `resolveEntityComponent()` | [`src/lib/crashtest/plan.ts`](../src/lib/crashtest/plan.ts) |
| Direction mapping | `directionVocabulary()`, `mapDirection()` | [`src/lib/crashtest/plan.ts`](../src/lib/crashtest/plan.ts) |
| Intent contract | `compileIntent()` | [`src/lib/crashtest/intent.ts`](../src/lib/crashtest/intent.ts) |
| Agent candidate search | `entityPool()`, `directionPool()` | [`src/lib/crashtest/agent.ts`](../src/lib/crashtest/agent.ts) |
| Agent composition | `beamSearch()`, `bundleVector()` | [`src/lib/crashtest/agent.ts`](../src/lib/crashtest/agent.ts) |
| Evidence agent | `runEvidenceAgent()` | [`src/lib/crashtest/agent.ts`](../src/lib/crashtest/agent.ts) |
| Agent self-challenge | `weakestSlot()` | [`src/lib/crashtest/agent.ts`](../src/lib/crashtest/agent.ts) |
| Candidate screens | `neighborhoodFit()`, `centralityFlag()`, `avoidedMatch()` | [`src/lib/crashtest/screens.ts`](../src/lib/crashtest/screens.ts) |
| Qloo evidence | `gatherEvidence()`, `tagList()` | [`src/lib/crashtest/gather.ts`](../src/lib/crashtest/gather.ts) |
| Component scoring | `assessComponent()` | [`src/lib/crashtest/evaluate.ts`](../src/lib/crashtest/evaluate.ts) |
| Plan evaluation | `evaluatePlan()` | [`src/lib/crashtest/evaluate.ts`](../src/lib/crashtest/evaluate.ts) |
| Evidence ledger | `createLedger()`, `budgeted()`, `memoized()` | [`src/lib/crashtest/ledger.ts`](../src/lib/crashtest/ledger.ts) |
| Evidence matrix | `buildEvidenceMatrix()`, `evidenceVector()` | [`src/lib/crashtest/matrix.ts`](../src/lib/crashtest/matrix.ts) |
| Blind judge | `judgeOnce()`, `adjudicate()` | [`src/lib/crashtest/adjudicate.ts`](../src/lib/crashtest/adjudicate.ts) |
| Hybrid improvement | `challenge()`, `strongestComponents()`, `optimize()` | [`src/lib/crashtest/hybrid.ts`](../src/lib/crashtest/hybrid.ts) |
| Stability audit | `auditRecommendationStability()` | [`src/lib/crashtest/stability.ts`](../src/lib/crashtest/stability.ts) |
| Result projection | `parallelView()` | [`src/lib/crashtest/parallel-view.ts`](../src/lib/crashtest/parallel-view.ts) |
| Parallel graph data | `buildParallelJudgeGraph()` | [`src/lib/crashtest/parallel-judge-graph.ts`](../src/lib/crashtest/parallel-judge-graph.ts) |
| Graph layout | `layoutGraph()`, `fitCamera()` | [`src/lib/crashtest/judge-layout.ts`](../src/lib/crashtest/judge-layout.ts) |
| Graph replay | `buildReplay()` | [`src/lib/crashtest/judge-replay.ts`](../src/lib/crashtest/judge-replay.ts) |
| HTTP orchestration | `handleCrashTest()`, `runEvents()` | [`src/lib/server/handlers.ts`](../src/lib/server/handlers.ts) |
| Comparison UI | `ParallelRunResult` | [`src/components/parallel-result.tsx`](../src/components/parallel-result.tsx) |
| Graph UI | `JudgeGraphView` | [`src/components/judge-graph-view.tsx`](../src/components/judge-graph-view.tsx) |

---

# Part XI — Judge and technical interview questions

## 1. What makes this agentic instead of a prompt wrapper?

The agent owns a bounded observe–decide–act–re-evaluate loop. It retrieves candidates from multiple Qloo views, screens them, composes complete plans, evaluates those plans, identifies its weakest choice, substitutes an alternative, and re-tests the complete package. Code controls budgets, evidence, acceptance, and stopping. A single prompt cannot skip directly to an unverified final answer.

## 2. What does Qloo add that the LLM does not?

Qloo supplies cross-domain cultural affinity, locality, entity identity, city context, tag affinity, and explainability signals. The plain LLM track is generated without those signals and then tested by the same process, making Qloo's contribution visible rather than decorative.

## 3. Does the agent merely repair the LLM's answer?

No. In the current parallel architecture, the LLM and evidence agent start from the same frozen brief and run independently. The agent never receives the LLM plan. They meet only after both plans have been constructed and evaluated.

## 4. Why retain the sequential architecture?

It is a simpler control and a record of the earlier approach. Keeping it makes architecture comparison possible and prevents the project from assuming that complexity is automatically better.

## 5. Can the user plan win?

Yes. The final plan can be the user's, LLM's, agent's, or a tested hybrid. The blind adjudicator does not see track identity.

## 6. How do you prevent the agent from always winning?

The plans use random blind IDs, are shown in two different orders, and are judged from structured claims. Hard failures are applied in code. If the orders disagree, the result becomes unstable. No rule awards points for being the agent track.

## 7. What happens when Qloo does not know a brand?

The choice becomes unverified or needs human confirmation. Missing data is not converted to zero and is not automatically treated as a reason to replace the choice. Fixed choices remain fixed.

## 8. How do you handle free-text constraints?

Machine-checkable locks and excluded names are enforced in code. A free-text rule that code cannot fully verify is preserved as an explicit limitation or human check. The system does not pretend it has proved compliance.

## 9. Why use beam search?

Selecting the best component independently for every slot can produce an incoherent package. Exhaustive plan search is too expensive. A bounded beam evaluates several promising complete bundles while respecting the Qloo-call budget.

## 10. Why re-test the entire plan after changing one choice?

A replacement can improve its own audience score while damaging coherence, constraints, or another previously supported component. Complete-plan re-testing catches those regressions.

## 11. What is the evidence matrix?

It is the normalized comparison layer. It converts evaluations and explicit rules into source-labelled claims with one of three stances: support, contradiction, or unknown. It keeps quality, coverage, completeness, and hard failures separate.

## 12. What does “stable” mean?

It means the recommendation survived the recorded order checks and, when available, leave-one-audience-anchor-out re-tests. It does not mean guaranteed commercial success.

## 13. Why ask two blind-order judgments?

If the same evidence yields different results when display order changes, the judgment is position-sensitive. The system reports that instability instead of hiding it.

## 14. Why not use more agents?

The task has one objective and one shared evidence environment. Multiple autonomous agents would duplicate retrieval and introduce coordination noise. We use narrowly bounded model roles where language judgment is useful and deterministic code where reproducibility matters.

## 15. How do you control cost?

The run has hard Qloo-call and iteration budgets, limited concurrency, bounded pools, bounded beam width, in-run request memoization, server caching, recordings, and failure-directed evaluation that reruns only representative failing patterns.

## 16. How does the graph prove the process?

The graph is built from `RunState`, not generated prose. Its nodes correspond to recorded alternatives, evidence groups, blind comparison, stability checks, and the final choice. Evidence nodes link back to ledger records and sanitized Qloo requests.

## 17. What would require a human?

Examples include an unresolved namesake, a free-text rule code cannot verify, venue capacity or availability, willingness of a partner to collaborate, and a materially unstable recommendation.

## 18. What is the main technical design principle?

Use models for language and bounded comparison; use code for state, policy, evidence provenance, budgets, validation, and claims.

---

# Part XII — Glossary

| Term | Meaning in this project |
|---|---|
| Agent | The single evidence-first planner with a bounded search and re-test loop |
| Anchor | A Qloo entity representing the target audience's cultural taste |
| Brief | The validated user intent and constraints for one launch |
| Candidate plan | A complete or explicitly open plan produced by one track or hybrid |
| Claim | One structured statement supporting, contradicting, or remaining unknown about a candidate |
| Coherence | Qloo affinity between one choice and the plan's other choices |
| Component | One choice occupying a plan slot |
| Constraint | A hard or soft user rule; only structured forms are machine-enforced |
| Coverage | The share of measurable checks that returned evidence |
| Evidence ledger | Append-only records of what was queried and what came back |
| Evidence matrix | Normalized claims and decision metadata for all candidate plans |
| Fingerprint | Stable hash proving which frozen brief or plan configuration was used |
| Hybrid | A fully re-tested plan composed from components of existing contenders |
| Intent contract | Structured, cited interpretation of relevant brief intent |
| Local relevance | Evidence that a choice belongs to or is distinctive in the launch market |
| Namesake protection | Rejecting a same-name Qloo entity that is not the intended real-world choice |
| Provisional | The leading plan is visible but requires human review because evidence or stability is insufficient |
| Qloo check | One typed request made through the budgeted Qloo client |
| Role screen | Structured check that an entity can perform the job required by the brief |
| Stability audit | Controlled tests of whether a recommendation changes under order or anchor perturbations |
| Track | One isolated plan-generation route: user, LLM, agent, or hybrid |

---

# Part XIII — Versions and configuration to remember

Current behavior versions are defined in [`src/lib/crashtest/version.ts`](../src/lib/crashtest/version.ts):

- base run: `crash:v15`;
- parallel engine: `parallel:v7`;
- evidence rubric: `evidence:v7`;
- adjudication: `adjudicate:v2`;
- screens: `screens:v6` in [`src/lib/crashtest/screens.ts`](../src/lib/crashtest/screens.ts);
- intent contract: `contract:v1` in [`src/lib/crashtest/intent.ts`](../src/lib/crashtest/intent.ts).

Important environment variables are documented in [`.env.example`](../.env.example):

- `QLOO_API_KEY`;
- `QLOO_BASE_URL`;
- `CHATGPT_AUTH_FILE`;
- `CHATGPT_AUTH_STORE`;
- Upstash variables when using Redis;
- `RECOMMENDATION_ARCHITECTURE`;
- `RECOMMENDATION_RANKING` where applicable.

Useful commands:

```bash
npm run dev
npm test
npm run typecheck
npm run lint
npm run build
# Only when using the optional LLM_PROVIDER=chatgpt fallback:
npm run llm:login
```

Do not run live evaluation casually. Use the failure-pattern selector on an existing run first so stable cases are not repeated.

---

# Final self-test

You understand the project when you can answer all of these without reading:

1. What are the three parallel tracks?
2. Which one is the actual agent?
3. What information is shared between tracks?
4. What information is deliberately isolated?
5. How are audience anchors chosen?
6. What are the four plan slots?
7. Which evidence dimensions come from Qloo?
8. What happens when Qloo returns nothing?
9. What is the difference between coverage and quality?
10. Why is the evidence policy lexicographic rather than one blended score?
11. What hard gates run before blind adjudication?
12. Why are two display orders used?
13. How can a hybrid win?
14. Why is every accepted substitution re-tested as a complete plan?
15. What makes a result provisional?
16. Why is the graph not chain-of-thought?
17. What is stored in the evidence ledger?
18. How are cost and loops bounded?
19. Why does the project use one agent instead of a swarm?
20. What can the product honestly claim—and what can it not claim?

If you can explain those twenty answers clearly, you can defend the architecture in front of a technical judge.
