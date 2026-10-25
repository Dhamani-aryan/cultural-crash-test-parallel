# Parallel three-track architecture

**Status:** the standalone repository defaults to the parallel engine. Set `RECOMMENDATION_ARCHITECTURE=sequential` only to run the `crash:v15` control.

**Versions:** run `crash:v15+parallel:v7` · base rubric `crash-v1` · evidence rubric `evidence:v7` · adjudication `adjudicate:v2`. Recordings key on all of these plus the ranking. Sequential keys are unchanged, so existing recordings stay valid.

## What it does

```text
                         â”Œâ”€ U: your plan, exactly as given (open slots stay "not specified")
Frozen brief + shared â”€â”€â”€â”¼â”€ L: the LLM alone, from the brief only (no Qloo client passed in)
measurement anchors      â””â”€ A: evidence-first: screened Qloo candidates only (never sees L)
                                   â†“  the same deterministic Qloo checks for all three
                         Evidence matrix (claims: supports / contradicts / unknown)
                                   â†“  hard gates first; identical plans merged
                         Blind adjudication, two rotated orders â†’ winner Â· tie Â· unstable Â· insufficient
                                   â†“
                         Bounded improvement: union and swap hybrids, targeted Qloo search,
                         each re-tested as a complete plan (quick 1 round, thorough 3)
                                   â†“
                         Final blind adjudication (two orders) → final plan re-tested
                                   ↓
                         bounded operational venue check → deterministic feasibility veto
```

The final plan can be the user's, the LLM's, the agent's or a hybrid. Tests show each can win (`tests/crashtest/parallel.test.ts`, 13â€“16).

| Module | Role |
|---|---|
| `src/lib/crashtest/tracks.ts` | Frozen brief and fingerprint, shared anchors, Track U, Track L (`generateLlmDraft(llm, frozen, market)`), Track A, agent alternatives |
| `src/lib/crashtest/matrix.ts` | Evidence claims with rule IDs (`RULES`), coverage, completeness, hard failures, component states, the decision-policy vector |
| `src/lib/crashtest/adjudicate.ts` | Hard gates, merging identical plans, blind prompts with aliased claim IDs, rotated orders, instability, commercial-claim stripping |
| `src/lib/crashtest/hybrid.ts` | Deterministic challenger, hybrids, acceptance guard, bounded rounds |
| `src/lib/crashtest/parallel-run.ts` | The controller: concurrency, per-track counters, budgets, final verdict |
| `src/lib/operational/` | Optional search of the original and leading venue, official-source reading, deterministic feasibility veto |
| `src/lib/crashtest/parallel-view.ts` | Pure view model, decision path and Markdown report |
| `src/components/parallel-result.tsx` | Choice Â· You Â· LLM Â· Evidence-first agent Â· Final verdict |
| `eval/scenario-run.ts`, `eval/scenario-compare.ts` | The 15-scenario runs and the architecture comparison |

## Independence

- **Track L** receives the frozen brief and the market, and no Qloo client. It is resolved afterwards by the same entity resolution as every track, against the shared anchors. Its own reading of the audience is recorded as an assumption, not used for measurement.
- **Track A** starts from a deep copy of Track U's resolved choices and never receives Track L. Open slots are filled by `repairEntity`/`repairDirection` in an `initial` mode. In that mode the model proposes no names, and candidates come only from Qloo lists after the deterministic screens (constraints, identity, city and country, venue format, locality, role and brief fit, duplicates). The model only chooses among screened candidates. A slot nothing passes for is left open (abstained), not forced.
- L and A run concurrently. Each track has its own model-call and Qloo-check counters, timing and ledger scope (`EvidenceRecord.scope`). Every candidate owns a cloned plan.

## Decisions and conflicts with the specification

1. **Claim stance is three-way.** The specification's `supports: boolean` can't express "unknown", which it also requires to stay distinct. `EvidenceClaim.stance` is `supports | contradicts | unknown`.
2. **One shared measurement audience.** All plans are scored against the same anchors (the user's, or model-suggested hypotheses from the brief alone, shown for confirmation). Track A also retrieves under those anchors, so its in-run evidence is favoured by construction. The 15-scenario comparison therefore re-scores both architectures' final plans under both architectures' anchor sets.
3. **Track A keeps the user's choices** (from Track U, never from L) and fills only open slots. If the user specifies every slot, U, L and A are the same plan. Identical plans are merged before judging and keep the most direct owner's identity (user, then LLM, agent, hybrid). So "your plan wins" means every track arrived at it.
4. **Hard vetoes are the brief's rules plus verified operational impossibility**: excluded names, locks, phrases a hard rule rules out, the launching brand as its own collaborator, a venue outside the city's country, or a concrete venue conflict stated by the venue/owner's official source. Cultural taste never becomes an operational veto. A user's own choice that trips a ruled-out phrase is flagged for a person, not vetoed.
5. **Decision policy as a vector** (`evidenceVector`): hard failures â†’ user intent kept â†’ completeness â†’ audience and role fit â†’ locality and coherence â†’ feasibility and entity â†’ distinctiveness. Coverage (confidence) is deliberately left out of the ranking. The deterministic order is shown beside the judge's verdict and is used only when the verdict is a tie or unstable; it is then flagged for a person.
6. **The improvement guard puts the brief before Qloo.** A hybrid is rejected if it breaks a hard rule, adds a violation, loses brief or role fit the incumbent had, or costs a supported choice without removing a contradiction. It is also rejected unless the complete-plan re-test shows a material improvement. The brief-fit guard was added after a live run showed a targeted search trading a brand attribute for better Qloo scores.
7. **Brief fit for an open brand slot.** The inherited rule requires a partner's Qloo description to share a product or attribute term. For a brief whose only terms are generic ("streetwear") no brand can pass. In the agent's initial mode the rule applies only when the brief has testable terms. The sequential engine is unchanged.
8. **Attribute matching uses word stems** (as `fitsBrief` does), so "minimalism" carries "minimalist". This was a defect found in the first live run: the judge was citing an exact-word miss.
9. **No verdict-writing model call** in parallel runs. The headline and every reason are deterministic projections of the recorded state.

## Later work

- **Further robustness.** Coverage, missingness, model-suggested-anchor warnings, complete-plan swaps, blind-order checks and leave-one-anchor-out stability are implemented. Prompt-wording sensitivity and cross-view agreement remain evaluation work because each multiplies calls and needs a frozen baseline.
- **Model-based challenger.** The challenger is deterministic, reading the matrix and the commercial-claim filter. That is cheaper and testable, and avoids open-ended debate.
- **General web research remains out of scope.** `official_source` is used only by the bounded venue feasibility gate. `human` evidence is still not collected inside a run.

## Known limitations

- The blind judge is the same model family as the drafting model; self-preference bias may remain.
- A partial user plan rarely wins, because completeness ranks before cultural evidence. This is intended: the user asked for a complete launch plan.
- Qloo results drift and the model is not deterministic. The sequential baseline was recorded earlier the same day; one run per scenario per architecture is a small sample.

## Reproduce

```powershell
npm run scenario:intake                                   # only if eval/out/scenario-intake.json is missing
npm run scenario:run                                      # sequential control â†’ eval/out/scenario-runs
$env:RECOMMENDATION_ARCHITECTURE='parallel'; npm run scenario:run; Remove-Item Env:RECOMMENDATION_ARCHITECTURE
npm run scenario:compare                                  # â†’ eval/out/scenario-architecture-comparison.md
```

Blind human review: fill in `eval/out/scenario-architecture-human-review.json` (X/Y labels; the key is in `â€¦-human-review-key.json`), then run `npm run scenario:compare` again.
