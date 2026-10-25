# Cultural Crash-Test: archived product and build plan

> Historical 21 October plan for the earlier sequential build. The live release is documented in
> [`../README.md`](../README.md), [`../STATUS.md`](../STATUS.md) and [`SUBMISSION.md`](SUBMISSION.md).

**Status:** plan, 2026-10-21. Pivot from Transcreate (tagged `transcreate-final`; its plan and evaluation live at that tag).
**Deadline:** Oct 30, 11:45 PM ET. **Current repo:** github.com/Dhamani-aryan/cultural-crash-test-parallel (MIT).
**Spec:** `CULTURAL_CRASH_TEST_PROJECT_SPEC.md` (supplied by the owner). This file is how we build it.

---

## 1. The product in one paragraph

A brand writes a launch brief: the city, the audience it wants, and its first cultural choices (a music act, a collaboration brand, a pop-up venue, a creative direction). Cultural Crash-Test treats each choice as a hypothesis and tests it against Qloo's taste data:
- Does this audience, in this city, actually have affinity for it?
- Is it local, or just famous?
- Does it fit the rest of the plan?

The agent finds the weakest-supported choice, researches a replacement in Qloo, swaps only that choice, and re-tests the package. It stops when the plan passes, when progress stalls, or when the budget runs out, and says which. Every claim traces to a recorded Qloo query.

## 2. What we already have (reused from Transcreate)

| Piece | File | Use in Crash-Test |
|---|---|---|
| Qloo client: 4 in flight, 429 backoff, shared in-flight requests, cache | `src/lib/qloo/*` | All research calls |
| Entity resolution with close-match guard | `src/lib/agent/check.ts` `findByName` | Resolving brief choices and audience anchors |
| Locality gates: control cities, global, origin, release country | `src/lib/engine/equivalents.ts`, `check.ts` | The *local relevance* dimension and repair filtering |
| Role tags and country-neutral kinds | `src/lib/engine/role.ts` | Keeping a replacement in the same role (a grime act for a grime act) |
| Measured city coverage | `data/coverage.json`, `src/lib/markets.ts` | Which cities we support, and per-category confidence |
| ChatGPT LLM adapter with structured output | `src/lib/llm/*` | Planner, repair choice, report writer |
| SSE streaming, rate limit, Upstash cache | `src/lib/server/*` | The live agent console |
| Eval harness: shared checks, blind judge in both orders | `eval/*` | LLM-only baseline vs agent |

The translator UI, extraction and rewrite steps are retired. The engine is the core of the evaluator and the repair step.

## 3. Verified on the live API (2026-10-21, `research/crashtest/`)

1. **Explainability works.** `feature.explainability=true` on `/v2/insights` returns, per result, each seed entity's contribution (`query.explainability["signal.interests.entities"][{entity_id, score}]`), plus `effect_on_top3/5/10_recs` at the top level. This gives us "which audience anchor drives this support".
2. **Audience × city × candidate checks work.** With seeds Stüssy, Palace and Carhartt, Skepta gets affinity 0.962 under London. Under Tokyo he isn't returned at all. `filter.results.entities` scores one named candidate in about 350 ms.
3. **Cross-category output is audience-shaped but not always local.** Seeded London artists: slowthai, Little Simz, Kendrick Lamar, Danny Brown. Kendrick is a global import, so locality must come from our control-city gates, not from affinity alone.
4. **Brands are excellent.** London: PLACES+FACES, END. Clothing, Maharishi, Patta, A-Cold-Wall. Tokyo: Supreme, Undefeated, HUF, Neighborhood.
5. **Venues need category filters, and they're noisy.** Seeded places without a filter return hotels. With `filter.tags=urn:tag:category:place:*` they're usable:
   - London clothing stores: BOXPARK Shoreditch.
   - Tokyo: BAPE Harajuku, Supreme Shibuya.
   - São Paulo: Beco do Batman (attractions), skate parks.
   - Some categories are empty in London, for example skate parks.
6. **Tag search works** (`/v2/tags?filter.query=`): `urn:tag:genre:music:grime`, `urn:tag:genre:brand:fashion:footwear:sneakers`. Style tags for brands are thin ("streetwear" only returns place ambience tags), so creative direction is tested through music and brand genre tags, not a "streetwear" tag.
7. **Demographics move results little** for this audience (age ≤ 24 gives nearly the same artists). We treat age as an optional refinement, never as the main signal.

## 4. How the agent works

### Plan structure
- **Audience anchors:** 2–4 Qloo entities that stand for the audience (brands or artists). They come from the user's choice, or the agent proposes them and Qloo resolves them. This is the audience *signal*. We never infer sensitive traits.
- **Components:** `artist_music`, `brand_collaboration`, `event_place`, `creative_direction` (one or two Qloo genre tags). Each is `user_provided` or `agent_proposed`, and can be **locked** (a hard constraint).

### State machine (deterministic controller, `src/lib/crashtest/run.ts`)
`VALIDATE_BRIEF → PLAN (LLM: anchors + missing components) → RESOLVE (Qloo search; ambiguous → flagged) → GATHER → EVALUATE → CHECK_CONSTRAINTS → ACCEPT? → DIAGNOSE → SELECT_ACTION → BUDGET/PROGRESS CHECK → GATHER …`

- **Budgets** are enforced in code: by default at most 3 repair rounds and 120 Qloo calls (the thorough mode allows 5 rounds and 250 calls).
- **Stop reasons:** `acceptance_criteria_met`, `no_material_improvement` (Δ total < 0.03 for 2 rounds), `iteration_limit`, `api_budget_limit`, `insufficient_data`, `user_cancelled`, `error`.
- The state is one typed object: brief, plan, ledger, evaluations, changes, stop reason. The report is rendered from it, not from chat text.

### Evidence ledger
Every Qloo call that feeds a decision becomes an `EvidenceRecord`:
- purpose;
- sanitized params (never the key);
- returned entities with affinity, rank and popularity, only where returned;
- explainability;
- coverage (`usable / partial / empty / error`);
- timestamp.

A missing score stays missing. It never becomes 0.

### Evaluator, rubric `crash-v1` (deterministic, `src/lib/crashtest/evaluate.ts`)
Per component, in the target city:

| Dimension | Weight | Measured as |
|---|---:|---|
| Audience affinity | 35% | The candidate's affinity under `signal = anchors + city` (via `filter.results.entities`), as a percentile within that query's top 50 for the category. Not returned → *no support found* (coverage partial). |
| Local relevance | 30% | The existing gates: in the city's location-only list, in how many control cities, local origin, global superstar. |
| Package coherence | 25% | Affinity of the candidate under `signal = the other components + city`. Do the choices support each other, not just the audience? |
| Distinctness | 10% | Not a duplicate or near-duplicate of another component (aka/role overlap). App-level heuristic, labelled as such. |

- **Weights renormalise over the dimensions that have evidence.** Coverage is reported separately (`adequate / partial / insufficient`), so a high score built on thin evidence doesn't look solid.
- **Statuses:** **Supported**, **Weak evidence**, **No support found**, **Unresolved**, **Constraint conflict**.
- **Acceptance:** every unlocked component is Supported, there's no hard-constraint conflict, and coverage isn't insufficient.

### Repair policy (`src/lib/crashtest/repair.ts`)
1. Take the weakest unlocked component (lowest score, then lowest coverage).
2. Pick one action:
   - **re-resolve** if the entity was ambiguous;
   - **find alternatives** (`anchors + other components + city`, the same category, filtered by role tags and locality gates; places get a category filter);
   - **re-test** with a different seed set if coverage was the problem.
3. The LLM picks one candidate **from the Qloo list only** and writes the reason, citing evidence IDs. Code validates that the ID is in the ledger.
4. Swap only that component, re-evaluate, and record a `PlanChange` with the expected and the observed effect.

### LLM-only baseline
The same brief goes to the model alone, which writes a plan. The agent's evaluator then scores both plans (the baseline's names are resolved in Qloo, and unresolved names are counted). A blind judge compares the two plans in both orders. This reuses the eval harness.

## 5. Screens
1. **New crash-test:** a guided brief form with example briefs, a privacy note and a run button.
2. **Agent console (live SSE):**
   - the stage and iteration;
   - each Qloo operation with a one-line summary;
   - "Why this step?";
   - a cancel button;
   - an expandable sanitized trace.
3. **Results:**
   - the verdict;
   - the original and final plans side by side;
   - component cards with status and evidence;
   - the revision timeline;
   - the score breakdown with its formula;
   - caveats and next human checks;
   - Markdown/JSON export.

Visual direction: a dark, editorial, restrained look, as the spec asks. Statuses are always text labels, never colour alone.

## 6. Demo scenario (to pre-test)
A fictional London streetwear label, "Northbound Supply", plans an East London pop-up for 18–30 skate and streetwear fans. The audience anchors are Stüssy, Palace and Carhartt. Its first plan:
- **Music:** a US rapper, a plausible LLM default that is global, not local. The crash test should flag it as *Weak evidence: global, not distinctive to London* and repair it to a London act such as Little Simz or slowthai.
- **Collaboration:** a brand.
- **Venue:** a pop-up venue, with "keep the venue" locked.

The story: one weak choice is found, repaired with Qloo evidence and re-tested, and the score moves for a reason the evidence explains.

## 7. Build checklist
1. Domain types and Zod schemas (`src/lib/crashtest/types.ts`)
2. Evidence ledger and sanitized Qloo tool wrappers with call accounting
3. Evaluator `crash-v1` with unit tests (missing-data behaviour, renormalisation, statuses, acceptance)
4. Controller state machine with budgets and stop reasons, plus tests (budget stop at the exact count, no-improvement stop, locked components)
5. Planner, repair and report LLM steps (structured, ledger-validated)
6. API route with SSE, and cancellation
7. UI: brief form, console, results, export
8. Demo brief pre-tested live; recorded replay labelled as recorded
9. Baseline eval on 8–10 fixed briefs → `docs/EVALUATION.md`
10. README, `.env.example`, deploy to Vercel, submission text, video

## 8. Questions for the owner
Answered 2026-10-21: Crash-Test replaces Transcreate; the demo is in London; the 5 measured cities only; a blind LLM judge, no human reviewers. Questions 5 and 6 use their defaults.

1. **One submission or two?** Does Crash-Test replace Transcreate as the entry (alongside Common Ground), or should Transcreate stay deployable? [Crash-Test replaces it; Transcreate is kept at the `transcreate-final` tag.]
2. **Demo city.** [London. It has the deepest streetwear brand and music data. Tokyo is the contrast city.]
3. **Supported cities.** [Only the 5 measured cities: London, Tokyo, São Paulo, Madrid, Mumbai, with per-category confidence from `coverage.json`.]
4. **Human reviewers.** Can 2–3 people (ideally someone who knows London streetwear) rate baseline vs agent plans blind? [No; blind LLM judge plus deterministic checks, labelled as such.]
5. **Local folder name.** [Keep `G:\Qloo 2.0`. Renaming it would break this session's paths.]
6. **Brand-name policy in the demo.** Real brands (Stüssy, Palace) as audience anchors and collaboration candidates, with a fictional launching brand? [Yes, which the spec allows.]
