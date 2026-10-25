# Cultural Crash-Test

> Test the cultural logic of a marketing launch before committing the budget.

**Live app:** [cultural-crash-test-parallel.vercel.app](https://cultural-crash-test-parallel.vercel.app)

**Submission repository:** [Dhamani-aryan/cultural-crash-test-parallel](https://github.com/Dhamani-aryan/cultural-crash-test-parallel)

**License:** [MIT](LICENSE)

Built for the [Qloo Agentic Hackathon 2026](https://qloo.devpost.com/).

## The problem

A marketing team entering an unfamiliar city makes several connected cultural bets: the music act, collaboration partner, venue and creative direction. A general-purpose model can make each choice sound plausible without establishing whether the complete plan fits the intended audience or local context.

Cultural Crash-Test treats those choices as hypotheses. It compares the marketer's plan with an independent LLM plan and an evidence-first agent plan, tests all three through Qloo, stress-tests the winner and explains the final recommendation in marketer-readable language.

## What the product does

1. A marketer describes the brand, objective, audience, proposed choices and practical constraints in ordinary language, or loads the prepared London streetwear example.
2. The intake assistant structures the brief and asks only for materially missing information.
3. Three plans are produced independently:
   - the marketer's stated plan;
   - an LLM-only plan that never sees Qloo evidence;
   - one evidence-first agent that searches and tests a broader Qloo candidate pool.
4. Every finalist receives the same audience, locality, role, coherence and constraint checks.
5. The plans are compared anonymously in both presentation orders.
6. A bounded improvement stage can construct a hybrid, but the complete hybrid must be re-tested before it can compete.
7. The leading plan is stress-tested against its strongest distinct runner-up.
8. When Brave Search is configured, official venue sources can veto a concrete operational conflict. Web search cannot award cultural fit or invent a new recommendation.
9. The result opens with **What changed because of Qloo?**, followed by the finalist comparison and expandable evidence. Stability checks, operational sources, usage details and the decision graph remain behind **View details**.

The three displayed columns are finalists, not the entire search space. The result states how many candidates and complete plan combinations the evidence agent examined.

During a live run, the interface streams meaningful research activity—candidate discovery, complete-plan testing, finalist comparison and stability work—rather than exposing raw API calls or showing a generic spinner.

## Fastest way to evaluate it

1. Open the [live application](https://cultural-crash-test-parallel.vercel.app).
2. Select **Try the London streetwear example**.
3. Review and confirm the populated brief. The scenario includes recognizable audience anchors, a booked venue that must remain fixed, an excluded collaboration brand and plausible starting choices.
4. Run the comparison and follow the live research milestones.
5. Start with **What changed because of Qloo?**, then open **Why this won** for the decisive choice.
6. Use **View details** to inspect the wider candidate search, official-source venue check, stability audit, evidence ledger and decision graph.

The example fills the brief but does not silently start a run. The user remains in control of confirmation and execution.

## Why Qloo is essential

Qloo is the cultural evidence layer, not a decorative lookup. The application uses Qloo Search, Entities and Insights—including tag insights and explainability—to:

- resolve real artists, brands and places before testing them;
- retrieve candidates from audience-affinity, locality and brief-fit views;
- measure audience affinity in the selected city;
- distinguish locally relevant choices from generic defaults;
- test whether each choice coheres with the rest of the plan;
- map a creative direction to Qloo aesthetic and tone tags;
- re-test candidate replacements under the same evidence rules.

Qloo evidence is preserved with its source and confidence so judges can inspect how each recommendation was reached.

## Decision architecture

```text
natural-language brief
        │
        ├── marketer's plan ───────────────┐
        ├── independent LLM plan ──────────┼── shared evidence matrix
        └── evidence agent + Qloo search ──┘            │
                                                        ▼
                                     blind, order-rotated comparison
                                                        │
                                                        ▼
                                  bounded hybrid + complete-plan re-test
                                                        │
                                                        ▼
                                           evidence stress tests
                                                        │
                                                        ▼
                                    bounded official-source venue check
                                                        │
                                                        ▼
                                      plain-language final recommendation
```

The production engine is `crash:v15 + parallel:v7`, with evidence rubric `evidence:v7` and adjudication protocol `adjudicate:v2`. Models generate proposals, constrained evidence readings and blind comparisons. Code enforces schemas, budgets, screens, constraints, scoring, operational vetoes, evidence ordering and stopping conditions.

Direct OpenAI calls use the Responses API's native strict JSON Schema Structured Outputs. Zod still validates the returned data, and non-OpenAI/test clients retain the schema-in-prompt fallback.

## Production behavior

- Next.js App Router with server-sent events and human-readable live research milestones for long-running crash tests.
- OpenAI Responses API with native strict Structured Outputs for bounded model work.
- Qloo remains the source of cultural evidence.
- Brave Search is used only for bounded operational venue verification.
- Vercel Upstash Redis shares 24-hour Qloo caching, 14-day completed-run recordings, clarification sessions and IP-based rate limits across serverless instances.
- Replayed results are explicitly labelled with their recording provenance rather than presented as fresh research.
- Public live runs are limited to three per IP per ten minutes; intake permits thirty turns per IP per ten minutes. Cached replays do not consume the live-run allowance.
- Brief history is stored in each visitor's browser, is private to that browser and keeps up to 30 chats.

Production supports New York, London, Tokyo, São Paulo, Madrid, Mumbai, Mexico City, Toronto, Sydney, Paris and Berlin.

## Run locally

Requirements: Node.js 22+, a Qloo API key and an OpenAI API key. Brave Search is optional but recommended for venue verification.

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Open <http://localhost:3000> and configure `.env.local` with server-side values:

```text
QLOO_API_KEY=
QLOO_BASE_URL=https://hackathon.api.qloo.com
LLM_PROVIDER=openai
LLM_MODEL=gpt-6-luna
LLM_REASONING_EFFORT=low
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
BRAVE_SEARCH_API_KEY=
BRAVE_SEARCH_BASE_URL=https://api.search.brave.com/res/v1/web/search
RECOMMENDATION_ARCHITECTURE=parallel
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

Never expose credentials through `NEXT_PUBLIC_*`. The Vercel Upstash Marketplace integration's `KV_REST_API_URL` and `KV_REST_API_TOKEN` names are also supported automatically.

## Validation

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Public release audit updated on 26 October 2026: **35 test files and 315 tests passed**, followed by TypeScript, ESLint and a production Next.js build. Tests use a synthetic Qloo world and require no API keys.

## Repository map

- `src/lib/intake/` — conversational brief extraction and validation.
- `src/lib/crashtest/` — independent tracks, evidence matrix, agent search, adjudication, stress tests and reports.
- `src/lib/qloo/` — typed Qloo client, caching and normalization.
- `src/lib/llm/` — provider abstraction, OpenAI Responses client, native Structured Outputs and Zod validation.
- `src/lib/operational/` — bounded Brave retrieval, official-source reading and deterministic venue gate.
- `src/lib/cache/` — in-memory and Upstash-compatible shared caching.
- `src/lib/server/` — validated request handlers, SSE streaming, replay and rate limits.
- `src/components/` — chat, prepared example, research progress, marketer-readable comparison and decision graph.
- `tests/` — synthetic unit, component, server and decision-policy coverage.
