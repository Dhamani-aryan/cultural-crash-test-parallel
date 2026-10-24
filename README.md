# Cultural Crash-Test

> Find the cultural mismatch before launch. Then fix it.

A launch plan is a stack of cultural bets: the music act, the collaboration brand, the pop-up venue, the creative direction. A language model can make every one of them sound plausible. Cultural Crash-Test is an agent that **treats each choice as a hypothesis and tests it against [Qloo](https://www.qloo.com/)'s taste data** for the audience and city you're launching to. It finds the weakest-supported choice, researches a better-supported alternative in Qloo, swaps only that choice, and tests the whole plan again. Every decision traces to a recorded Qloo query.

Built for the **Qloo Agentic Hackathon 2026**.

**Example (live run, London):** a streetwear label plans an East London pop-up for fans of Stüssy, Palace and Carhartt. The founder's picks were Travis Scott, BOXPARK Shoreditch (locked) and "playful pastel Y2K". The model drafted Vans as the collaborator.
- **Travis Scott:** Qloo returns no affinity for him with this audience in London, so the agent marks him *No support found*. It researches London acts and swaps in **slowthai** (#1 for this audience; strongest link: Palace). It re-tests.
- **Vans → END. Clothing.**
- **"Playful pastel" → "industrial utility in monochrome":** Industrial, Utilitarian and Monochrome rank #2, #6 and #7 for this audience in London. "Playful" is Tokyo's top aesthetic, not London's.
- **Result:** 1 of 4 choices supported → 4 of 4. The locked venue was never touched.

## How it works

```
                                      ┌─► your plan as stated ──────────────┐
conversation ─► frozen brief ─────────┼─► LLM-only plan ───────────────────┼─► shared evidence matrix
                                      └─► evidence agent + Qloo search ────┘             │
                                                                                         ▼
                                  stability-qualified verdict ◄─ finalist stress tests ◄─ blind comparison
```

The three plans are genuinely independent: the LLM-only track never sees Qloo, and the evidence agent never sees the LLM draft. The agent pools candidates from several Qloo retrieval views, screens them against the brief, tests a bounded set of complete plans, and challenges its own weakest supported choice. Every plan is then evaluated by the same evidence rules and compared under anonymous IDs in two presentation orders.

Before a recommendation is called stable, `parallel:v6` stress-tests the winner against its strongest distinct runner-up. It reuses the two blind-order judgments, then removes up to three audience anchors one at a time and re-tests both complete plans through Qloo. The result screen reports how many checks preserved, tied, or reversed the decision. Any reversal turns the headline into **Provisional plan** and creates a targeted human check; missing evidence is never silently converted into failure. v6 also ranks explicit brief contradictions and structured role doubts before affinity, uses the same strict venue-role screen in agent selection and blind comparison, and never reduces a relational free-text rule such as “don’t mix unrelated fashion and music” to “avoid fashion.”

- **Intake** ([`src/lib/intake/`](src/lib/intake/)). A chat, like ChatGPT. You describe the launch in your own words, answer any follow-up questions, or say "figure out the rest" to have the assistant make (and state) the assumptions.
  - The model reads only the facts you state into a "What I understand" brief. Each field is labelled *from you*, *suggested* or *confirmed*, and you can edit it.
  - Code decides what's still missing: product, launch, city, a confirmed audience, and what the brand stands for. It asks at most three questions per turn, in at most four turns.
  - If you don't know the audience, it suggests two or three taste-defined segments, never sensitive traits, and you pick or edit one.
  - Choices can be marked *Booked/fixed*, and an *Explore better-supported alternatives to my choices* switch is off by default.
  - Nothing runs until you confirm the brief, and the server re-checks that before any Qloo call.

- **Independent plans.** The user's choices, an LLM-only draft, and the evidence-first agent's plan are built in parallel from the same frozen brief. The final plan can also be a fully re-tested hybrid when its complete evidence record materially beats the original tracks.
- **Resolve.** Every name is looked up in Qloo. A name Qloo doesn't know is marked *Unresolved*, never tested as if it were real. The creative direction is mapped onto Qloo's own aesthetic and tone tags.
- **Test.** Every choice is scored with the deterministic, versioned rubric `crash-v1` ([`evaluate.ts`](src/lib/crashtest/evaluate.ts)):

  | Dimension | Weight | Qloo evidence |
  |---|---:|---|
  | Audience affinity | 35% | Rank among what the audience (its anchor brands/artists as signal) has affinity for in the city, with explainability naming the strongest anchor |
  | Local relevance | 30% | From here, or distinctive in the city's own list, vs. just as big in 4 other world cities or 4 US cities |
  | Package coherence | 25% | Rank when the plan's *other* choices are the signal: do the choices support each other? |
  | Distinctness | 10% | Not a repeat of another choice (labelled app heuristic) |

  - A dimension without evidence is left out rather than scored zero, and coverage is shown separately.
  - Statuses are written out: *Supported*, *Weak evidence*, *No support found*, *Unresolved*, *Constraint conflict*.
- **Repair.**
  - Only choices the evidence **contradicts** are replaced: no support for this audience here, a hard constraint broken, a global or foreign import, or a creative direction this audience here doesn't lean to. A local choice with thin evidence, or a name Qloo doesn't know, is kept and flagged for a human. Swapping it for a better-scoring but less fitting name would game the score, not improve the plan.
  - The weakest contradicted choice gets one targeted action. Candidates come from two sources:
    - Qloo's list of what the audience *and* the rest of the plan have affinity for in the city;
    - the agent's own suggestions for the job, each looked up and scored in Qloo under the same signal (names Qloo can't find, or shows no affinity for, are dropped).
  - All candidates are screened for locality and role: a partner brand in the same kind of business, a venue that can host the event.
  - The model ranks up to three survivors, and code checks every ID. Each is re-tested in turn; the first that makes the choice *Supported* wins, otherwise the best improvement. If none can do the job, the model says so and it becomes an open question.
  - Only that slot changes. Candidates that don't test better are recorded as tried, not kept.
- **Stop.** Code checks four conditions:
  - acceptance;
  - no material improvement for 2 rounds;
  - the repair-round limit (3 quick, 6 thorough);
  - the Qloo call budget (700 / 1,400), enforced before each call.

  The report says which one stopped the run.
- **Results** ([`run-result.tsx`](src/components/run-result.tsx), [`plan-comparison.tsx`](src/components/plan-comparison.tsx), [`judge-graph-view.tsx`](src/components/judge-graph-view.tsx), [`decision-trace.ts`](src/lib/crashtest/decision-trace.ts)). Results open on a plain introduction, your direction, and a run receipt counted from the recorded run (choices tested, candidates considered, re-tested, accepted and retained; Qloo checks, plus requests actually sent to Qloo when measured; constraints preserved; full-plan re-tests; live or recorded, and the date, from the run's own provenance). A **Table / Decision graph** switch sits above the agent's method in one line. The **table** is the default: You / LLM / Agent per choice, a Why row of plain recorded sentences (the original and who supplied it, what the test returned, the alternative, its evidence, the full-plan re-test), and a **Decision trace →** link into the graph. The **decision graph** (lazy-loaded Three.js through React Three Fiber) has a toolbar above the canvas (Fit graph, Replay decision path / Stop replay) and the legend below it. The overview reads left to right (your brief, the four decisions, the final plan). Edges are routed curves that stop at each shape's edge and clear unrelated nodes, and no line runs behind a label. Labels are placed every frame by priority, inside the canvas, never overlapping. The camera is front-facing, and Fit graph returns to that view. Below the canvas, **Decision details** shows the recorded process for the focused choice: original, what the test returned, every alternative tested with its outcome, why each was rejected, the acceptance checks the kept one passed, the full-plan result, the constraints that applied, and the selected node's Qloo evidence (query, results, context, coverage, recorded or live source). The **Decision trace** lists every step in order; evidence and candidate rows are buttons that select the node, focus the camera and move to Decision details. Replay is an ordered timeline: each line grows from source to target, the node appears as it arrives, and rejected candidates recede after their re-test. Reduced motion shows the final state. The table, the graph and the trace are projections of the same `buildDecisionTrace` output, so they cannot disagree, and nothing on screen is parsed back out of a sentence.
- **Compare plans** ([`compare.ts`](src/lib/crashtest/compare.ts)).
  - Code decides whether the LLM-only plan or the agent's is better supported, choice by choice and overall. The order is: hard constraints, contradicted choices, supported choices, evidence coverage, then the score.
  - The outcome can be the agent, the baseline, mixed, or not enough evidence, and every reason links to its evidence records. No model picks the winner.
- **Report.**
  - The draft and the final plan side by side, with per-choice evidence cards citing ledger IDs, a revision log (why, expected, observed), assumptions and open questions.
  - Markdown and JSON export.
  - The model writes only a 2–3 sentence verdict, from the recorded state.

The model is used for four things only: the draft, mapping a direction onto Qloo tags, choosing among screened candidates, and the verdict. Validation, scoring, constraints, budgets and stopping are all code.

## Evaluation

[`docs/EVALUATION.md`](docs/EVALUATION.md) compares the LLM-only draft with the agent's final plan on 9 fixed briefs across 5 cities. The main measures:
- **Held-out audience anchors.** Both plans are re-scored with brands and artists the agent never saw.
- **An evidence-based judge.** It is blind to which plan is the agent's and runs in both orders. It sees the same held-out Qloo evidence for both plans and must judge from it, not from taste.

Latest run (run 16, agent `crash:v14`):
- **Evidence judge:** prefers the agent's plan in all 9 briefs, including the 6 never used for tuning.
- **Supported choices on held-out anchors:** 4 → 18 of 36. Support rose in every brief. Recent runs measured 17, 13 and 16 (of 32). The LLM drafts differ every run, and [`docs/DECISIONS.md`](docs/DECISIONS.md) explains the spread.
- **A no-evidence "taste" judge** is also reported, as a reference only. It is the same model that wrote the LLM-only plan and sees no evidence, and it prefers that plan in all 9 briefs.

The sample is small and the report states its limits, including the earlier runs the agent lost and why.

## Run locally

Requires Node.js 22+, a Qloo hackathon key, and a ChatGPT sign-in for the model (no OpenAI API key; see `.env.example`).

```bash
npm ci
cp .env.example .env.local   # set QLOO_API_KEY
npm run llm:login            # one-time ChatGPT sign-in, saved to git-ignored .secrets/
npm run dev                  # http://localhost:3000
```

- One run from the terminal, with a trace: `npm run live scripts/crashtest.ts -- london` (also `tokyo`, `sao-paulo`).
- Checks: `npm test`, `npm run typecheck`, `npm run lint`. Tests use a synthetic Qloo world and need no keys.
- Evaluation: `npm run live eval/run.ts`, then `npm run live eval/report.ts`.
- Failure-directed evaluation: `npm run eval:failures -- <scenario-tag>` reads an existing run without model or Qloo calls and prints the smallest representative rerun set covering its observed failure patterns. Stable improving cases are skipped.

## Supported cities

New York, London, Tokyo, São Paulo, Madrid, Mumbai, Mexico City, Toronto, Sydney, Paris and Berlin. These are the cities where we measured Qloo's artist, brand and place data as deep and city-specific enough for Cultural Crash Test ([`data/coverage.json`](data/coverage.json)). New York uses London as its direction contrast so it is never compared with itself.

## Honest limits

- **Scores are this app's own.** They are built from Qloo affinity ranks. They aren't probabilities, sales forecasts or guarantees of campaign performance.
- **Qloo's evidence is aggregate cultural affinity.** The app doesn't identify, profile or predict any individual.
- **Missing data stays missing.**
  - A name Qloo doesn't know is reported as such.
  - A Qloo error becomes an error entry in the ledger.
  - When no local candidate exists, the agent says so and explains why (for example, "of the top 40 for this audience, 38 from another country").
- **Recorded runs are labelled.** The demo replays recorded runs of the example briefs so it's fast and free, and labels them as recorded with their date. "Run it live again" fetches fresh data.
- **Raw Qloo responses are never committed** (Qloo's terms). The test fixtures are synthetic.

## Repository

- [`docs/FINAL_SUBMISSION_RUNBOOK.md`](docs/FINAL_SUBMISSION_RUNBOOK.md): deadline-aware, step-by-step release, deployment, Devpost, judging-period and finalist-preparation checklist for the Qloo Agentic Hackathon 2026.
- [`docs/PROJECT_ARCHITECTURE_LEARNING_COURSE.md`](docs/PROJECT_ARCHITECTURE_LEARNING_COURSE.md): progressive course covering the product, agent architecture, Qloo evidence flow, decision policy, runtime, UI, function map, code-reading labs and judge questions.
- `src/lib/crashtest/`:
  - types and schemas;
  - evidence ledger and budget guard;
  - evidence gathering, evaluator, planner and repair;
  - the controller (`run.ts`) and report.
- `src/lib/qloo/`: typed Qloo client (search, entities, tags, insights including tag results and explainability), with retries, concurrency limits and a server-side cache.
- `src/lib/engine/`, `src/lib/agent/check.ts`: the locality gates and role tags, reused from the earlier Transcreate prototype (tag `transcreate-final`).
- `src/app/api/crashtest/`: server-sent-events endpoint. It is rate-limited, and the Qloo key stays on the server.
- `src/components/`: brief form, agent console and results.
- `eval/`, `research/`, `docs/`: evaluation, API probes (scripts only) and decisions.

## License

[MIT](LICENSE)
