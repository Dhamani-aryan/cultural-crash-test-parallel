# Claude new-chat transfer — Cultural Crash Test

**Date:** 23 October 2026 (India)

## Paste this instruction into the new chat

> Continue the interrupted single-agent v3 implementation in `G:\Qloo 2.0-parallel`. Read this transfer document and `handoff/SINGLE_AGENT_V3_IMPROVEMENT_AND_EVAL_PLAN.md` completely before editing. Preserve every current uncommitted file; this is valuable mid-implementation work, not disposable output. Do not reset, clean, checkout, overwrite frozen evaluation artifacts, add a multi-agent architecture, or start live/paid scenario runs yet. First finish the implementation, repair and extend the synthetic tests, bump the architecture version to `parallel:v3`, and make test/typecheck/lint/build/diff-check pass. Then run only the five sentinel scenarios and report them honestly against the frozen v2 baseline. Do not run all 15 or merge automatically until the sentinel gate is reviewed.

## User-approved product direction

The product compares three genuinely distinct approaches:

1. **U — User plan:** exactly what the user supplied; unspecified slots stay open.
2. **L — Plain LLM plan:** produced from the frozen brief without Qloo results.
3. **A — One Qloo-grounded recommendation agent:** independently retrieves candidates, constructs multiple complete plans, evaluates them, challenges weak choices and iterates.

There is deliberately **one recommendation agent**, not an orchestrator with sub-agents. Music, brand, venue and audience work may use parallel API/tool calls, but they are not separate agents. A separate blind evaluator compares U, L and A afterward; that evaluator is not part of the recommendation agent.

The intended product claim is:

> One recommendation agent independently retrieves culturally relevant candidates from Qloo, constructs and tests multiple complete launch plans, challenges its weakest choices, and returns the strongest evidence-backed plan. The app then compares it with the user's direction and an ungrounded LLM baseline using the same frozen evidence rules.

Do not optimize for making A win. Optimize for the best defensible recommendation; U or L may win, and the system may abstain or return a visibly provisional result.

## Repository and worktree state

### Do all implementation work here

- Worktree: `G:\Qloo 2.0-parallel`
- Branch: `experiment/parallel-tracks`
- HEAD: `40aa69d`
- Tag at HEAD: `parallel-v2-baseline`
- HEAD run version: `crash:v15+parallel:v2`

### Do not implement in the main checkout

- Checkout: `G:\Qloo 2.0`
- Branch: `main`
- HEAD/tag: `e217f3f` / `sequential-v15-baseline`
- Main also contains four older untracked handoff/report documents. Do not delete, move or overwrite them.

### Current parallel worktree is intentionally dirty

Modified tracked files:

- `eval/scenario-run.ts`
- `src/lib/crashtest/hybrid.ts`
- `src/lib/crashtest/matrix.ts`
- `src/lib/crashtest/parallel-run.ts`
- `src/lib/crashtest/repair.ts`
- `src/lib/crashtest/types.ts`
- `src/lib/crashtest/version.ts`

New untracked files/directories:

- `eval/fingerprint.ts`
- `eval/frozen.ts`
- `eval/frozen/`
- `eval/output-guard.ts`
- `handoff/SINGLE_AGENT_V3_IMPROVEMENT_AND_EVAL_PLAN.md`
- `src/lib/crashtest/agent.ts`
- `src/lib/crashtest/intent.ts`
- `src/lib/crashtest/screens.ts`
- `tests/crashtest/intent.test.ts`
- this transfer document

Never use `git reset --hard`, `git clean`, `git checkout --`, or another operation that discards these changes.

## What was completed before the interruption

### Sequential control

The existing sequential architecture is preserved at `e217f3f` (`crash:v15`) with a frozen 15-scenario baseline under:

- `eval/out/scenario-runs/`
- `eval/out/scenario-summary.json`
- `eval/out/scenario-intake.json`

### Parallel v1/v2, committed

Commits on `experiment/parallel-tracks`:

- `caa8405` — parallel U/L/A architecture behind `RECOMMENDATION_ARCHITECTURE=parallel`
- `919bf7e` — five-column comparison UI and decision path
- `1e43b5f` — scenario comparison, evidence/brief-fit fixes
- `40aa69d` — namesake/country protection for user-named acts and brands; tagged `parallel-v2-baseline`

Before the current v3 edits, the committed branch passed 289 tests, typecheck, lint, production build and `git diff --check`.

The parallel architecture remains behind a feature flag; sequential is still the default. Do not switch the product default until evaluation and human review support the change.

### Frozen v2 evaluation

The 15-scenario v2 run is complete and frozen:

- Full states: `eval/out/scenario-runs-parallel-v2/`
- Summary: `eval/out/scenario-summary-parallel-v2.json`
- Fingerprint manifest: `eval/frozen/parallel-v2.json`
- Commit: `40aa69d`
- Run version: `crash:v15+parallel:v2`

V2 exact totals:

- 15 runs, 0 errors
- 45 of 60 final choices supported under each run's own anchors
- 0 hard-constraint violations
- 13 of 15 final adjudications stable
- winners: A 14, L 1, U 0, hybrid 0
- 2,948 budgeted Qloo checks
- 170 model calls
- mean runtime 72.2 seconds
- serious failure: `accessories-mumbai` ended unstable with the LLM track and 0 of 4 supported choices

The earlier v1-versus-sequential comparison found that parallel had slightly better Qloo support but the blind plan-quality judge preferred sequential 10 times, parallel 3 times, with 2 ties. This is the main reason for v3: Qloo affinity alone was producing plans that were measurable but sometimes less plausible or less faithful to the brief.

Recurring qualitative failures from that comparison:

- Kith/Terminal 5 instead of an independent Lower East Side streetwear/art context
- Liberty London instead of an intimate gallery/craft context
- BAR PIANO instead of a design-led Omotesando showroom venue
- ZARA as a Mumbai venue and a mainstream brand where the brief asked for distinctiveness
- Ochoymedio/Hawkers losing Madrid skate and local-design specificity
- Balmoral/Vance Joy losing the requested Bondi sunrise/surf context
- generic/global prestige choices displacing local, independent or product-central choices

The diagnosis is: the agent often maximized affinity while losing role fit, named-neighborhood relevance, distinctiveness, product centrality and complete-plan coherence.

## V3 plan that was approved

The complete specification is:

- `handoff/SINGLE_AGENT_V3_IMPROVEMENT_AND_EVAL_PLAN.md`

Its P0 changes are:

1. Make Track A independent from every non-locked user component.
2. Compile a deterministic, cited brief-intent contract.
3. Retrieve diverse top-K pools per slot from existing Qloo views.
4. Strengthen entity, role, market, neighborhood, brief-fit, distinctiveness and product-centrality screens.
5. Use bounded complete-plan beam search instead of greedy slot-by-slot selection.
6. Let the same single agent run a bounded challenge/substitution loop and re-test the whole plan.
7. Show unstable outcomes as provisional rather than ordinary winners.
8. Freeze/version every baseline and prevent accidental overwrites.
9. Compare v2 and v3 on the same 15 frozen scenarios and rubric.

## Partial v3 implementation already present

The interrupted work contains substantial implementation. Continue it; do not recreate it.

### `src/lib/crashtest/intent.ts`

- `contract:v1`
- cited brief fields and phrases
- event-format extraction
- named neighborhood, positive/negative qualities and distinctiveness intent
- user choices classified by strength

### `src/lib/crashtest/screens.ts`

- `screens:v1`
- preferred venue categories and host tiers
- neighborhood distance/fit
- conditional mainstream penalty
- product-centrality flag
- matching Qloo descriptions against qualities the brief asks to avoid
- structured candidate role-check schema

### `src/lib/crashtest/agent.ts`

- a single evidence agent, not sub-agents
- constants for view, pool, reserve, role-check and beam sizes
- diversified candidate pools and provenance records
- bounded beam search for complete bundles
- structured role checks
- complete-plan evaluation hooks
- weakest-slot failure hypothesis
- bounded challenge rounds
- plan fingerprint/repetition guard
- neighborhood-centroid helper

### Evidence and controller wiring

- `parallel-run.ts` now compiles the contract, resolves neighborhood context, invokes `runEvidenceAgent`, and screens U/L with the same role-reading mechanism.
- `matrix.ts` is partially upgraded to `evidence:v2` with claims/rules for user-considered choices, host tier, neighborhood, requested distinctiveness, product centrality, avoided qualities and role checks.
- `types.ts` adds pool records, agent records, run configuration and challenge metadata.
- `hybrid.ts` and `repair.ts` have small compatibility changes.

### Evaluation preservation

- `eval/frozen.ts` registers sequential and parallel-v2 frozen artifacts.
- `eval/frozen/*.json` records SHA-256 fingerprints.
- `eval/output-guard.ts` refuses writes into frozen paths and refuses mixing run versions in one output directory.
- `eval/scenario-run.ts` invokes the guard before writing.
- `eval/fingerprint.ts` is intended to create/check manifests.

## Exact verification state at handoff

Commands were run from `G:\Qloo 2.0-parallel` on 23 October 2026.

- `npm run typecheck` — **passes**
- `git diff --check` — **passes**
- `npm test` — **fails: 31 failed, 264 passed, 295 total across 29 files**
- current lint/build — not yet rerun after these edits
- no v3 live scenario evaluation has been run

The dominant test failure is not yet evidence that the architecture is fundamentally broken. The fake test LLM stops with:

> `no scripted reply for: You screen candidates for one job in a product lau...`

That error prevents `state.parallel` from being produced and causes most of the other failures to cascade. The first repair should be to teach `tests/crashtest/world.ts` (and any other fake LLM fixtures) to recognize `ROLE_SYSTEM` and return valid structured role-check results. Do not merely suppress the exception; make the fixtures express both fitting and wrong/doubtful candidates so the new behavior is tested.

There is also one server-handler failure caused by the same incomplete parallel run path. Re-evaluate it after the fake role response is in place.

## Important incomplete/versioning issues

1. `EVIDENCE_RUBRIC_VERSION` is already `evidence:v2`, but `PARALLEL_VERSION` still says `parallel:v2`. After the implementation and tests are coherent, bump it to `parallel:v3` before any new recording/live run.
2. Existing tests still encode v2 behavior in places. Update them only where the approved v3 specification intentionally changes behavior. Do not weaken unrelated safety assertions.
3. Track A must not inherit non-locked U components. Explicit locks must survive every candidate, bundle, challenge and final plan.
4. A Qloo-unknown user choice remains unknown, never automatically contradicted. Track U must keep it and flag it.
5. A model role check is a transparent logical/model screen, not Qloo evidence. Keep source and limitation labels honest.
6. If the evidence rubric changes further, bump its version and apply the same version when re-scoring both v2 and v3. Never compare systems under silently different rubrics.
7. The UI/report must display unstable fallback results as provisional. Do not call them stable winners.

## Immediate continuation sequence

1. Read the full v3 plan and inspect every current diff/untracked file.
2. Add scripted `ROLE_SYSTEM` behavior to the test LLM and make the current tests execute the new path.
3. Fix genuine failures exposed after the cascade is removed.
4. Add focused tests required by the v3 plan:
   - fully specified but unlocked U can differ from A;
   - locks survive all bundles/challenges;
   - unknown user choice stays unknown;
   - wrong-role high-affinity venue loses;
   - mainstream default loses only when the brief asks for distinctiveness;
   - neighborhood fit is applied only with defensible location evidence;
   - beam search can prefer a stronger complete bundle over top individual candidates;
   - affinity gain with brief-fit loss is rejected;
   - repeated fingerprint stops iteration;
   - budget returns the best fully evaluated plan;
   - unstable verdict is visibly provisional;
   - frozen/versioned outputs cannot be overwritten.
5. Finish evaluation fingerprint/check commands and package scripts if missing.
6. Bump architecture to `parallel:v3`; keep evidence at `evidence:v2` unless its rules change again.
7. Run and pass:
   - `npm test`
   - `npm run typecheck`
   - `npm run lint`
   - `npm run build`
   - `git diff --check`
8. Commit the implementation only after reviewing the diff and confirming frozen artifacts are unchanged.
9. Run the five sentinel scenarios into a new non-frozen tag/directory:
   - `streetwear-new-york`
   - `luxury-handbags-london`
   - `accessories-mumbai`
   - `sneakers-madrid`
   - `sun-care-sydney`
10. Report exact results and compare the specific qualitative failures. Do not tune names or scenarios after seeing them.
11. Wait for user review before running all 15.

## Evaluation and promotion gates

Across all 15, v3 must satisfy:

- 0 failed runs
- 0 hard-constraint violations
- 100% explicit-lock preservation
- no 0-supported final plan unless it explicitly abstains
- at least 14 of 15 stable final adjudications; unstable output must be provisional
- at least the v2 support baseline of 45/60 under comparable anchors/rubric
- more blind v3-over-v2 wins than losses
- no regression in the five sentinel failure categories
- latency and external Qloo request increase reported; over 25% requires a demonstrated quality/preference gain
- separate blind human review before any superiority claim

These are honest promotion gates, not outputs to tune toward. If v3 fails, report it and retain v2/control.

## UI and product requirements that remain in force

- Initial UI should remain clean and uncluttered.
- Comparison must clearly show User / LLM / Agent / Final per choice.
- Reasons and detailed evidence should appear progressively when the user asks to compare or expands a choice.
- Do not add generic explanatory microcopy the user did not request.
- The Obsidian-like interactive 3D graph is intentionally later. Stabilize the parallel trace/table first.
- Graph labels and edges must not overlap when the graph work resumes.
- Every changed choice needs a plain-language explanation of why the agent moved away from U/L and toward the final choice.
- Unknown evidence is not failure. Qloo affinity is cultural evidence, not proof of commercial success.

## Secret/API-key instruction

Do not add, commit, paste or request the user's Qloo/API key. The user plans to add subscription credentials close to final submission. Use existing local configuration only when explicitly authorized to run live evaluation, and keep all secrets out of source and artifacts.

## Useful commands

Run from `G:\Qloo 2.0-parallel`:

```powershell
git status --short
git diff --check
npm test
npm run typecheck
npm run lint
npm run build
```

When local verification passes and the user authorizes sentinel live runs, use a new explicit scenario tag so frozen paths cannot be touched. Confirm the exact package-script/environment syntax in the repository before running it.

## Definition of done for the next chat

The next chat is complete only when:

1. the interrupted v3 implementation is finished without discarding current work;
2. every synthetic/unit/component/server test passes;
3. typecheck, lint, build and diff-check pass;
4. versions and frozen-output protection are correct;
5. the five sentinel runs have been saved separately and compared honestly with v2;
6. the user receives a concise results table, failures/regressions, cost/latency changes and a recommendation on whether to proceed to all 15.

