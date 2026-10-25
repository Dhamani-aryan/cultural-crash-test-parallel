# Cultural Crash-Test — New Chat Handoff

Updated: 25 October 2026 (India)  
Active repository: `G:\Qloo 2.0-parallel`  
GitHub repository: `Dhamani-aryan/cultural-crash-test-parallel`  
Local branch: `experiment/parallel-tracks`, tracking `origin/main`  
Remote `main`: use `git rev-parse origin/main` for the current release instead of a recorded SHA.

Current submission and deployment status is maintained in [`../STATUS.md`](../STATUS.md).

## Read this first

Continue from the existing implementation. Do not redesign the architecture or rerun every evaluation scenario.

Token and API discipline:

1. Inspect existing reports and tests before running anything live.
2. Reproduce only the specific failing pattern.
3. Never rerun the full 15-scenario suite unless the user explicitly requests a final regression.
4. Prefer deterministic unit tests and synthetic Qloo fixtures.
5. Never print, commit, or copy API keys into documentation.
6. Keep commentary concise; the user is deliberately moving chats to reduce usage.

## Product in one paragraph

Cultural Crash-Test accepts a natural-language launch plan and independently constructs three views: the user's stated plan, an LLM-only plan, and a single evidence-first agent plan using Qloo. All plans use the same frozen brief and audience measurement anchors. They are converted into a structured evidence matrix, compared blindly in two presentation orders, improved through bounded complete-plan testing, stress-tested, and turned into a final recommendation. The app shows a simple marketer-facing comparison by default; judge diagnostics, evidence, graph, stability checks, and operational research remain behind **View details**.

## Current architecture

- Run version: `crash:v15+parallel:v7`
- Evidence rubric: `evidence:v7`
- Adjudication: `adjudicate:v2`
- One evidence agent, not a multi-agent system.
- Three independent inputs are compared: User / LLM / Agent.
- Qloo supplies cultural affinity, locality, coherence, entity resolution, and candidate retrieval.
- Deterministic code owns constraints, scoring, hard gates, stopping, budgets, evidence ordering, and operational vetoes.
- Model calls handle structured interpretation, constrained readings, proposal/ranking work, and blind adjudication.
- Rare clarification is used only when the answer could materially change the plan and cannot safely be inferred.

Primary architecture documentation:

- `docs/PARALLEL_ARCHITECTURE.md`
- `docs/PROJECT_ARCHITECTURE_LEARNING_COURSE.md`
- `docs/FINAL_SUBMISSION_RUNBOOK.md`

## Latest completed work

### 1. Marketer-first result hierarchy

Commit: `8f840a2`

- Default result view contains the verdict and User / LLM / Agent / Final comparison.
- Stability prose, metrics, evidence receipts, graph, method, and technical diagnostics are behind **View details**.
- Per-choice reasoning remains behind **Why this won**.
- This follows the user's rule: do not add unsolicited explanatory text to the default UI.

Main file: `src/components/parallel-result.tsx`

### 2. Operational venue verification

Commit: `9ff1cfe`

- Qloo remains the cultural recommendation engine.
- A bounded online stage checks only:
  - the user's original venue;
  - the preliminary winning venue.
- It uses at most two Brave searches and one batched model reading.
- Only an official venue/owner source can create a hard operational veto.
- Permitted vetoes are concrete: wrong establishment type, closure, unsupported event format, or insufficient stated capacity.
- Directory claims, taste judgments, and unclear evidence cannot change the winner.
- Current availability, price, dates, and willingness are never claimed.
- If the preliminary venue fails, code falls back through the already-established evidence order.
- Details and Markdown reports explain:
  - what the cultural comparison recommended;
  - what operational evidence caught;
  - why the final course changed;
  - cited source links.

Main files:

- `src/lib/operational/brave.ts`
- `src/lib/operational/gate.ts`
- `src/lib/operational/types.ts`
- `src/lib/crashtest/parallel-run.ts`
- `src/components/parallel-result.tsx`

The Barbican Conservatory versus For Your Eyes Only failure pattern has targeted regression tests in `tests/operational/`.

### 3. Direct OpenAI API provider

Commit: `f6b00c4`

- The project now supports `LLM_PROVIDER=openai` through the Responses API.
- Local configuration uses `LLM_MODEL=gpt-6-luna` and low reasoning.
- The exact model ID is `gpt-6-luna`; there is no `gpt-6.1-luna`. GPT-6.1 currently refers to Sol.
- A tiny live authentication test succeeded with the configured local key.
- The previous ChatGPT-login provider remains available as an optional fallback.
- `.env.local` is git-ignored and contains the local key. Never display it.

Main files:

- `src/lib/llm/openai.ts`
- `src/lib/llm/index.ts`
- `src/lib/env.ts`
- `.env.example`

## Verification state

At the last handoff:

- Full test suite: **464 tests passed** across 43 files.
- TypeScript: passed.
- ESLint: passed.
- Production Next.js build: passed.
- OpenAI live connection: passed using `gpt-6-luna`.
- Git working tree was clean after pushing `f6b00c4`.
- No development server was running on port 3000.

Do not repeat these checks unless code changes.

## Credentials and missing configuration

- `OPENAI_API_KEY`: configured locally in `.env.local`; not committed.
- `LLM_PROVIDER=openai`: configured locally.
- `LLM_MODEL=gpt-6-luna`: configured locally.
- Qloo key: configured locally.
- `BRAVE_SEARCH_API_KEY`: **not configured**.

Important distinction: the OpenAI key powers model calls. It does not power Brave venue search. Until `BRAVE_SEARCH_API_KEY` is added, the app still runs normally but skips the new operational-source stage and leaves venue feasibility as a human check.

For deployment, every secret must be added separately to Vercel. Local `.env.local` values do not deploy automatically.

The OpenAI key was pasted into a prior chat. Recommend rotating it before final public deployment, without repeatedly interrupting current local development.

## Immediate next step

Do not make another broad backend change.

1. Obtain and add `BRAVE_SEARCH_API_KEY` locally and later in Vercel.
2. Run exactly one fresh Aera London scenario that previously produced:
   - user venue: Barbican Conservatory;
   - agent venue: For Your Eyes Only.
3. Confirm the operational stage:
   - finds official sources;
   - marks For Your Eyes Only as a concrete venue-type conflict;
   - recognizes Barbican Conservatory as operationally plausible for the stated product-launch format/capacity when supported by its official page;
   - changes the final venue only through the deterministic gate;
   - shows the narrative and source links only after **View details**.
4. If that case passes, freeze this backend. Do not rerun the other 14 scenarios.
5. Move to presentation/demo preparation and deployment checks.

If the Aera case fails, fix the smallest failing layer only: search retrieval, official-source classification, structured reading, deterministic gate, or UI projection.

## User's non-negotiable product preferences

- Clean, deliberate, modern UI; avoid generic “AI” visual styling.
- Do not place technical descriptions everywhere.
- Default experience must be useful to a marketer.
- Judge evidence belongs behind a clear Details control.
- Comparison must always preserve User / LLM / Agent / Final.
- Explain every changed choice with recorded evidence.
- Missing evidence is not failure.
- Do not replace a Qloo-unknown user brand when a free-text hard rule cannot be verified; keep and flag it.
- The agent should decide ordinary inferable matters without repeatedly asking the user.
- Ask only when ambiguity is material and genuine.
- Remain inside supported Qloo cities for the demo.
- Accuracy work must be failure-directed, not repeated blind evaluation.
- Use a single agent; do not add multi-agent orchestration merely for appearance.

## Git instructions

- Work in `G:\Qloo 2.0-parallel`, not `G:\Qloo 2.0`.
- Preserve unrelated user changes.
- Run proportionate tests after edits.
- Push completed work with:

```powershell
git push origin HEAD:main
```

- Never add `.env.local`, `.secrets/`, raw Qloo responses, or `eval/out/`.

## Suggested first prompt for the new chat

> Read `handoff/NEW_CHAT_HANDOFF_2026-10-25.md` completely. Continue in `G:\Qloo 2.0-parallel`. Be token-efficient: inspect before acting, do not rerun the 15 scenarios, and do not expose secrets. First report the current git state and whether `BRAVE_SEARCH_API_KEY` is configured. Then follow only the Immediate next step in the handoff.
