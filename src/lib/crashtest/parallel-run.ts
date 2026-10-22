import { randomUUID } from "node:crypto";
import type { LlmClient } from "@/lib/llm/types";
import { marketById } from "@/lib/markets";
import type { QlooClient, QlooEntity } from "@/lib/qloo";
import { adjudicate } from "./adjudicate";
import { evaluatePlan } from "./evaluate";
import { gatherEvidence, type GatherContext } from "./gather";
import { componentRank, optimize, planProgress, rankBetter, type OptimizeResult } from "./hybrid";
import { BudgetExceeded, budgeted, createLedger, memoized, scopedLedger } from "./ledger";
import { buildEvidenceMatrix, claimsOf, type MatrixContext } from "./matrix";
import { QueryRequestSchema, parseQuery, type QueryRequest } from "./query";
import { repairDirection, repairEntity, type DraftTrial } from "./repair";
import type { RunDeps, RunOptions } from "./run";
import {
  agentAlternatives,
  buildUserTrack,
  freezeBrief,
  generateAgentTrack,
  generateLlmDraft,
  measurementAnchors,
  resolveLlmTrack,
  userChoiceCountries,
  type TrackPlan,
} from "./tracks";
import {
  DEPTHS,
  LaunchBriefSchema,
  RUBRIC_VERSION,
  SLOTS,
  SLOT_LABEL,
  COMPONENT_STATE_LABEL,
  type AdjudicationResult,
  type CandidatePlan,
  type CandidateTrial,
  type ComponentAssessment,
  type CulturalPlan,
  type FinalVerdict,
  type LaunchBriefInput,
  type ParallelResult,
  type PlanEvaluation,
  type PlanTrack,
  type RunState,
  type StopReason,
  type TrackUsage,
  type UsageScope,
} from "./types";
import { ADJUDICATION_VERSION, EVIDENCE_RUBRIC_VERSION, PARALLEL_VERSION, rankingFrom } from "./version";

/**
 * The parallel three-track controller.
 *
 *   FREEZE BRIEF → SHARED ANCHORS → { U | L ∥ A } → EVALUATE ALL → EVIDENCE MATRIX
 *     → BLIND ADJUDICATION (2 orders) → BOUNDED IMPROVEMENT (hybrids, re-tested) → FINAL ADJUDICATION
 *
 * Every transition and budget is code. Tracks L and A run concurrently with separate inputs,
 * counters and ledger scopes; neither receives the other's state. The final plan can be the
 * user's, the LLM's, the agent's or a hybrid; nothing here assumes the agent wins.
 */

/** Improvement rounds: thorough runs get the plan's three, quick runs one. */
export const ROUNDS = { quick: 1, thorough: 3 } as const;
/** Complete agent alternatives evaluated beside its first pick. */
export const ALTERNATIVES = { quick: 1, thorough: 2 } as const;

class Cancelled extends Error {}

export async function runParallelCrashTest(
  deps: RunDeps,
  input: LaunchBriefInput | QueryRequest,
  opts: RunOptions = {},
): Promise<RunState> {
  const emit = opts.emit ?? (() => {});
  const market = marketById(input.marketId);
  if (!market) throw new Error(`Unsupported city: ${input.marketId}`);

  let parseCalls = 0;
  let read: string[] = [];
  let briefInput: LaunchBriefInput;
  let query: string | undefined;
  if ("query" in input) {
    const req = QueryRequestSchema.parse(input);
    query = req.query;
    emit({ type: "stage", stage: "understand", message: "Reading your description into a brief" });
    const counting: LlmClient = {
      provider: deps.llm.provider,
      model: deps.llm.model,
      generateText: (r) => {
        parseCalls++;
        return deps.llm.generateText({ ...r, signal: opts.signal });
      },
    };
    ({ brief: briefInput, read } = await parseQuery(counting, req, market));
  } else {
    briefInput = input;
  }
  const brief = LaunchBriefSchema.parse(briefInput);
  const frozen = freezeBrief(brief);
  const depth = { ...DEPTHS[brief.depth], ...opts.limits };
  const maxRounds = opts.limits?.maxRepairs ?? ROUNDS[brief.depth];

  const state: RunState = {
    runId: opts.runId ?? randomUUID(),
    brief,
    query,
    marketLabel: market.label,
    initialPlan: null,
    plan: null,
    assumptions: [...read],
    currentIteration: 0,
    maxIterations: maxRounds,
    maxQlooCalls: depth.maxQlooCalls,
    qlooCallsUsed: 0,
    llmCalls: parseCalls,
    evidenceLedger: [],
    evaluations: [],
    actions: [],
    changes: [],
    trials: [],
    provenance: { mode: "live", runVersion: opts.runVersion ?? "dev" },
    unresolvedQuestions: [],
    rejected: {},
    architecture: "parallel",
    startedAt: new Date().toISOString(),
  };

  // ---- separate counters per track and stage ----
  const usage = Object.fromEntries(
    (["shared", "user", "llm", "agent", "adjudication", "improvement"] as UsageScope[]).map((s) => [s, { ms: 0, qlooChecks: 0, llmCalls: 0 }]),
  ) as Record<UsageScope, TrackUsage>;
  const llmFor = (scope: UsageScope): LlmClient => ({
    provider: deps.llm.provider,
    model: deps.llm.model,
    generateText: (req) => {
      state.llmCalls++;
      usage[scope].llmCalls++;
      return deps.llm.generateText({ ...req, signal: opts.signal });
    },
  });
  const statsAtStart = deps.qlooStats ? { ...deps.qlooStats } : undefined;
  const counted = budgeted(deps.qloo, state.maxQlooCalls, (used) => {
    state.qlooCallsUsed = used;
    if (used % 10 === 0) emit({ type: "budget", qlooCallsUsed: used, maxQlooCalls: state.maxQlooCalls });
  });
  const memo = memoized(counted.client);
  const clientFor = (scope: UsageScope): QlooClient => {
    const c = memo.client;
    const count =
      <I, O>(fn: (i: I) => Promise<O>) =>
      (i: I) => {
        usage[scope].qlooChecks++;
        return fn(i);
      };
    return {
      searchEntities: count((i) => c.searchEntities(i)),
      getEntities: count((i) => c.getEntities(i)),
      getDemographics: count((i) => c.getDemographics(i)),
      searchTags: count((i) => c.searchTags(i)),
      getInsights: count((i) => c.getInsights(i)),
      compareProfiles: count((i) => c.compareProfiles(i)),
    };
  };
  const ledger = createLedger(
    () => state.currentIteration,
    (record) => emit({ type: "evidence", record }),
  );
  state.evidenceLedger = ledger.records;
  const ranking = rankingFrom(opts.ranking);
  const ctxFor = (scope: UsageScope): GatherContext => ({ client: clientFor(scope), ledger: scopedLedger(ledger, scope), market, ranking });
  const evaluateIn = (scope: UsageScope) => async (plan: CulturalPlan): Promise<PlanEvaluation> =>
    evaluatePlan({ plan, evidence: await gatherEvidence(ctxFor(scope), plan), constraints: brief.constraints, city: market.label, iteration: state.currentIteration });
  const timed = async <T>(scope: UsageScope, fn: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      usage[scope].ms += Date.now() - t;
    }
  };
  const stage = (s: string, message: string) => {
    if (opts.signal?.aborted) throw new Cancelled();
    emit({ type: "stage", stage: s, message });
  };
  const usedBlind = new Set<string>();
  const blindId = () => {
    for (let n = usedBlind.size; ; n++) {
      const id = opts.blindId ? opts.blindId(n) : `P-${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
      if (!usedBlind.has(id)) {
        usedBlind.add(id);
        return id;
      }
    }
  };
  const snapshot = (scope: UsageScope, started: number) => ({
    model: deps.llm.model,
    qlooCalls: usage[scope].qlooChecks,
    llmCalls: usage[scope].llmCalls,
    ms: Date.now() - started,
    generatedAt: new Date().toISOString(),
  });
  const candidate = (track: PlanTrack, candidateId: string, t: TrackPlan, evaluation: PlanEvaluation | null, provenance: CandidatePlan["provenance"], parent?: string): CandidatePlan => ({
    candidateId,
    track,
    blindId: blindId(),
    briefFingerprint: frozen.fingerprint,
    // Each candidate owns its plan: nothing mutable is shared between tracks.
    plan: structuredClone(t.plan),
    open: t.open,
    sources: t.sources,
    evaluation,
    assumptions: t.assumptions,
    parent,
    provenance,
  });

  // Full Qloo records for the logical rules, fetched once per entity.
  const facts = new Map<string, QlooEntity>();
  const ensureFacts = async (plans: CulturalPlan[]) => {
    const ids = [...new Set(plans.flatMap((p) => p.components.flatMap((c) => (c.entity && !facts.has(c.entity.id) ? [c.entity.id] : []))))];
    if (!ids.length) return;
    for (const e of await clientFor("shared").getEntities(ids)) facts.set(e.id, e);
  };
  let anchorSource: ParallelResult["anchorSource"] = "none";
  let anchorNotes: string[] = [];
  const mctx = (): MatrixContext => ({
    brief,
    city: market.label,
    facts,
    anchorSource,
    resolutionEvidence: (id) =>
      ledger.records
        .filter((r) => (r.queryKind === "search" || r.queryKind === "locality") && r.qlooEntityIds.includes(id) && !r.purpose.startsWith("The model judged"))
        .map((r) => r.evidenceId),
  });
  const matrixOf = (cands: CandidatePlan[]) => buildEvidenceMatrix(cands, mctx());

  const candidates: CandidatePlan[] = [];
  let contenders: CandidatePlan[] = [];
  let initial: AdjudicationResult | null = null;
  let final: AdjudicationResult | null = null;
  let improvement: OptimizeResult | null = null;
  const alternatives: CandidatePlan[] = [];
  let budgetHit = false;

  try {
    stage("validate", `Brief for ${market.label} checked and frozen (${frozen.fingerprint})`);
    for (const c of brief.constraints.filter((c) => c.kind === "hard" && !c.lockSlot && !c.excludeNames?.length))
      state.assumptions.push(`Hard constraint "${c.description}" isn't machine-checkable; it is shown to the model but not enforced in code.`);

    stage("anchors", "Choosing the audience every plan will be measured against");
    const anchored = await timed("shared", () => measurementAnchors({ llm: llmFor("shared"), ctx: ctxFor("shared"), brief }));
    anchorSource = anchored.source;
    anchorNotes = anchored.notes;
    state.assumptions.push(...anchored.notes);
    if (!anchored.anchors.length) {
      state.stopReason = "insufficient_data";
      state.stopDetail = "None of the audience anchors could be found in Qloo, so audience affinity can't be measured.";
      throw new Cancelled();
    }
    const anchors = anchored.anchors;

    stage("tracks", "Building three plans independently: yours as given, the LLM's alone, and the evidence-first agent's");
    const t0 = Date.now();
    // The user's named acts and brands get the same namesake protection as any name: their
    // countries come from the brief alone, once, shared by every track that keeps them.
    const userP = timed("shared", () => userChoiceCountries(llmFor("shared"), brief, market)).then((countries) =>
      timed("user", () => buildUserTrack({ llm: llmFor("user"), ctx: ctxFor("user"), brief, anchors, countries })),
    );
    const llmP = timed("llm", async () => {
      const draft = await generateLlmDraft(llmFor("llm"), frozen, market);
      return resolveLlmTrack({ llm: llmFor("llm"), ctx: ctxFor("llm"), brief, draft, anchors });
    });
    // The agent starts from the user's own resolved choices (a deep copy), never from the LLM's plan.
    const agentP = userP.then((u) =>
      timed("agent", () => generateAgentTrack({ llm: llmFor("agent"), ctx: ctxFor("agent"), brief, anchors, user: structuredClone(u.plan.components) })),
    );
    const [u, l, a] = await Promise.all([userP, llmP, agentP]);

    stage("evaluate", "Testing all three plans with the same Qloo checks");
    const [ue, le] = await Promise.all([timed("user", () => evaluateIn("user")(u.plan)), timed("llm", () => evaluateIn("llm")(l.plan))]);
    const U = candidate("user", "user", u, ue, snapshot("user", t0));
    const L = candidate("llm", "llm", l, le, snapshot("llm", t0));
    // The agent's first pick and its complete alternatives are each evaluated; the strongest is Track A.
    const altPlans = agentAlternatives(a, ALTERNATIVES[brief.depth]);
    const agentEvals = await timed("agent", async () => {
      const out: PlanEvaluation[] = [];
      for (const p of [a.plan, ...altPlans]) out.push(await evaluateIn("agent")(p));
      return out;
    });
    const agentPlans = [a.plan, ...altPlans];
    let bestAt = 0;
    agentEvals.forEach((e, i) => {
      if (i && planProgress(agentEvals[bestAt], e).material) bestAt = i;
    });
    const A = candidate("agent", "agent", { ...a, plan: agentPlans[bestAt] }, agentEvals[bestAt], snapshot("agent", t0));
    agentPlans.forEach((p, i) => {
      if (i === bestAt) return;
      alternatives.push(candidate("agent", `agent-alt-${alternatives.length + 1}`, { ...a, plan: p }, agentEvals[i], snapshot("agent", t0), "agent"));
    });
    state.trials!.push(...a.trials.map((t): CandidateTrial => ({ ...t, iteration: 0 })));
    candidates.push(U, L, A, ...alternatives);
    contenders = [U, L, A];
    state.initialPlan = L.plan;
    await ensureFacts(candidates.map((c) => c.plan));

    stage("adjudicate", "Blind comparison of the three plans, in two orders");
    initial = await timed("adjudication", () =>
      adjudicate({ llm: llmFor("adjudication"), stage: "initial", candidates: contenders, matrix: matrixOf(contenders), brief, market, ledger: scopedLedger(ledger, "adjudication") }),
    );

    stage("improve", "Challenging the leading plan and re-testing hybrids as complete plans");
    const leader = initial.winnerCandidateId ?? initial.evidenceOrder[0];
    let hybridN = 0;
    improvement = await timed("improvement", () =>
      optimize(
        { brief, contenders, incumbentId: leader, maxRounds, flagged: initial!.flagged },
        {
          evaluate: async (plan) => {
            await ensureFacts([plan]);
            return evaluateIn("improvement")(plan);
          },
          search: async (slot, inc) => {
            state.currentIteration++;
            const comp = inc.plan.components.find((c) => c.slot === slot);
            const assessment: ComponentAssessment = inc.evaluation?.components.find((c) => c.slot === slot) ?? {
              slot,
              label: comp?.label ?? "",
              status: "unresolved",
              coverage: "insufficient",
              dimensions: [],
              finding: "Open slot: nothing chosen yet.",
              contradicted: false,
            };
            const plan = comp ? inc.plan : { ...inc.plan, components: SLOTS.flatMap((s) => (s === slot ? [{ slot, label: "", origin: "agent_proposed" as const, locked: false, resolution: "not_found" as const, entity: null, tags: [], placeCategory: null }] : inc.plan.components.filter((c) => c.slot === s))) };
            const upgrade = !!comp && !assessment.contradicted;
            if (slot === "creative_direction") {
              const p = await repairDirection({ llm: llmFor("improvement"), ctx: ctxFor("improvement"), brief, plan, assessment, upgrade, initial: !comp });
              const trials: DraftTrial[] = p ? [{ slot, name: p.after.label, source: "llm_proposal", evidenceIds: p.evidenceIds, briefFit: "unknown" }] : [];
              return { proposals: p ? [p] : [], trials };
            }
            const r = await repairEntity({
              llm: llmFor("improvement"),
              ctx: ctxFor("improvement"),
              brief,
              plan,
              slot,
              assessment,
              rejected: [...candidates, ...alternatives].flatMap((c) => c.plan.components.filter((x) => x.slot === slot && x.label !== comp?.label).map((x) => x.label)),
              upgrade,
              initial: !comp,
            });
            await ensureFacts(r.proposals.map((p) => ({ anchors: [], components: [p.after] })));
            return r;
          },
          matrix: matrixOf,
          newIds: () => ({ candidateId: `hybrid-${++hybridN}`, blindId: blindId() }),
        },
      ),
    );
    if (improvement.stop === "budget") budgetHit = true;
    state.trials!.push(...improvement.trials.map((t): CandidateTrial => ({ ...t, iteration: state.currentIteration })));
    candidates.push(...improvement.hybrids);
    if (improvement.incumbent.track === "hybrid") contenders = [...contenders, improvement.incumbent];

    stage("final", "Final blind comparison, in two orders");
    final = await timed("adjudication", () =>
      adjudicate({ llm: llmFor("adjudication"), stage: "final", candidates: contenders, matrix: matrixOf(contenders), brief, market, ledger: scopedLedger(ledger, "adjudication") }),
    );
  } catch (err) {
    if (err instanceof BudgetExceeded) budgetHit = true;
    else if (err instanceof Cancelled || opts.signal?.aborted) {
      if (!state.stopReason) state.stopReason = "user_cancelled";
    } else {
      state.stopReason = "error";
      state.stopDetail = err instanceof Error ? err.message : String(err);
    }
  }

  // ---- the final verdict, from recorded facts ----
  const matrix = matrixOf(candidates);
  const empty: AdjudicationResult = {
    stage: "final",
    candidateIds: contenders.map((c) => c.candidateId),
    eliminated: {},
    merged: {},
    winnerCandidateId: null,
    verdict: "insufficient_evidence",
    dimensionWinners: {},
    rationale: "The run stopped before the plans could be compared.",
    decisiveClaimIds: [],
    counterevidenceClaimIds: [],
    orderResults: [],
    flagged: [],
    evidenceOrder: contenders.map((c) => c.candidateId),
  };
  const fin = final ?? empty;
  let chosenId: string | null = null;
  let decidedBy: FinalVerdict["decidedBy"] = "none";
  if (fin.verdict === "winner" && fin.winnerCandidateId) {
    chosenId = fin.winnerCandidateId;
    decidedBy = "adjudication";
  } else if ((fin.verdict === "tie" || fin.verdict === "unstable") && fin.evidenceOrder.length) {
    chosenId = fin.evidenceOrder.find((id) => !fin.eliminated[id]) ?? null;
    decidedBy = chosenId ? "evidence_order" : "none";
  }
  const chosen = candidates.find((c) => c.candidateId === chosenId) ?? null;
  let finalEval: PlanEvaluation | null = chosen?.evaluation ?? null;
  if (chosen && !state.stopReason) {
    // The final complete plan is re-tested once more; its evidence is already in the run's memory.
    try {
      finalEval = await evaluateIn("improvement")(chosen.plan);
    } catch (err) {
      if (!(err instanceof BudgetExceeded)) throw err;
      budgetHit = true;
    }
  }
  const verdict = finalVerdict({ chosen, finalEval, fin, decidedBy, candidates, contenders, alternatives, improvement, matrix, anchorNotes, anchorSource });

  state.plan = chosen?.plan ?? null;
  state.evaluations = [contenders.find((c) => c.candidateId === "llm")?.evaluation, finalEval].filter((e): e is PlanEvaluation => !!e);
  state.unresolvedQuestions = verdict.humanChecks;
  state.currentIteration = improvement?.rounds.length ?? 0;
  if (!state.stopReason) {
    const stop: StopReason = budgetHit ? "api_budget_limit" : improvement?.stop === "round_limit" ? "iteration_limit" : "no_material_improvement";
    state.stopReason = stop;
    state.stopDetail =
      stop === "api_budget_limit"
        ? `${counted.used()} Qloo calls used.`
        : stop === "iteration_limit"
          ? `${maxRounds} improvement round(s) used.`
          : "The last improvement round accepted no hybrid.";
  }
  state.qlooCallsUsed = counted.used();
  state.qlooUsage = {
    checks: counted.used() + memo.reused(),
    reused: memo.reused(),
    ...(deps.qlooStats && statsAtStart ? { cacheHits: deps.qlooStats.hits - statsAtStart.hits, requests: deps.qlooStats.requests - statsAtStart.requests } : {}),
  };
  if (initial || candidates.length)
    state.parallel = {
      architectureVersion: PARALLEL_VERSION,
      baseRubricVersion: RUBRIC_VERSION,
      evidenceRubricVersion: EVIDENCE_RUBRIC_VERSION,
      adjudicationVersion: ADJUDICATION_VERSION,
      briefFingerprint: frozen.fingerprint,
      anchorSource,
      anchorNotes,
      candidates,
      matrix,
      initial: initial ?? { ...empty, stage: "initial" },
      rounds: improvement?.rounds ?? [],
      final: fin,
      verdict,
      usage,
    };
  state.finishedAt = new Date().toISOString();
  emit({ type: "done", state });
  return state;
}

function finalVerdict(x: {
  chosen: CandidatePlan | null;
  finalEval: PlanEvaluation | null;
  fin: AdjudicationResult;
  decidedBy: FinalVerdict["decidedBy"];
  candidates: CandidatePlan[];
  contenders: CandidatePlan[];
  alternatives: CandidatePlan[];
  improvement: OptimizeResult | null;
  matrix: ReturnType<typeof buildEvidenceMatrix>;
  anchorNotes: string[];
  anchorSource: ParallelResult["anchorSource"];
}): FinalVerdict {
  const { chosen, fin, matrix } = x;
  const humanChecks: string[] = [];
  if (fin.verdict === "unstable")
    humanChecks.push(`The blind judge's verdict changed with the order the plans were shown in. ${chosen ? `The plan shown leads on the recorded evidence, but a person should choose.` : "A person should choose."}`);
  if (fin.verdict === "tie") humanChecks.push("The blind judge found the plans level on the evidence; a person should choose between them.");
  if (fin.verdict === "insufficient_evidence") humanChecks.push(`No plan can be recommended: ${fin.rationale}`);
  if (x.anchorSource === "model_hypothesis") humanChecks.push(x.anchorNotes[0]);
  const states = chosen ? (matrix.componentStates[chosen.candidateId] ?? {}) : {};
  for (const slot of SLOTS) {
    const st = states[slot];
    const comp = chosen?.plan.components.find((c) => c.slot === slot);
    const open = chosen?.open.find((o) => o.slot === slot);
    if (open) humanChecks.push(`${SLOT_LABEL[slot]}: ${open.state === "not_specified" ? "not specified" : "left open"}. ${open.reason}`);
    else if (comp && st && st !== "supported")
      humanChecks.push(`${SLOT_LABEL[slot]} "${comp.label}": ${COMPONENT_STATE_LABEL[st].toLowerCase()}. ${x.finalEval?.components.find((c) => c.slot === slot)?.finding ?? ""}`.trim());
    if (comp && slot === "event_place") humanChecks.push(`Confirm that ${comp.label} can host the launch: capacity, dates and willingness are not in Qloo.`);
  }
  for (const c of chosen ? claimsOf(matrix, chosen.candidateId).filter((c) => c.ruleId === "R-unverifiable-rule") : []) humanChecks.push(`${c.claim} Please confirm it by hand.`);

  // The best-tested component per slot across every evaluated plan, wherever it came from.
  const best: FinalVerdict["bestSupportedComponents"] = [];
  for (const slot of SLOTS) {
    let top: { c: CandidatePlan; a: ComponentAssessment } | null = null;
    for (const c of x.candidates) {
      const a = c.evaluation?.components.find((y) => y.slot === slot);
      if (!a) continue;
      if (!top || rankBetter(componentRank(a), componentRank(top.a))) top = { c, a };
    }
    if (top) best.push({ slot, label: top.a.label, candidateId: top.c.candidateId, status: top.a.status });
  }

  const userChoices = x.contenders.find((c) => c.candidateId === "user");
  const rejected: FinalVerdict["rejectedAlternatives"] = [];
  for (const c of x.contenders) {
    if (c.candidateId === chosen?.candidateId) continue;
    const merged = fin.merged[c.candidateId];
    rejected.push({
      candidateId: c.candidateId,
      reason: fin.eliminated[c.candidateId]
        ? `Breaks the brief: ${fin.eliminated[c.candidateId].join("; ")}`
        : merged
          ? `Same choices as ${merged}.`
          : c.plan.components.length < SLOTS.length && chosen && chosen.plan.components.length > c.plan.components.length
            ? "Leaves choices open."
            : fin.verdict === "winner"
              ? "The blind adjudication preferred another plan on the cited evidence."
              : "Ranked lower on the recorded evidence.",
    });
  }
  for (const c of x.alternatives) rejected.push({ candidateId: c.candidateId, reason: "A complete alternative the agent evaluated; its first choice tested at least as well." });
  for (const r of x.improvement?.rounds ?? []) for (const a of r.attempts) if (!a.accepted) rejected.push({ candidateId: a.candidateId, reason: a.reason });

  const limitations = new Set<string>(["Qloo affinity is cultural evidence. It does not show sales, attendance, availability, budget fit or causation."]);
  if (chosen) for (const c of claimsOf(matrix, chosen.candidateId)) for (const l of c.limitations) limitations.add(l);

  return {
    candidateId: chosen?.candidateId ?? null,
    track: chosen?.track ?? null,
    verdict: fin.verdict,
    stable: fin.verdict === "winner" && x.decidedBy === "adjudication",
    decidedBy: x.decidedBy,
    plan: chosen?.plan ?? null,
    open: chosen?.open ?? [],
    evaluation: x.finalEval,
    sources: chosen?.sources ?? {},
    bestSupportedComponents: best,
    userChoicesPreserved: (userChoices?.plan.components ?? []).map((u) => {
      const f = chosen?.plan.components.find((c) => c.slot === u.slot);
      return { slot: u.slot, label: u.label, locked: u.locked, preserved: !!f && f.origin === "user_provided" && f.label === u.label };
    }),
    // A plan inherits the assumptions of every track it takes a component from.
    assumptionsIntroduced: [
      ...new Set([
        ...(x.anchorSource === "model_hypothesis" ? x.anchorNotes.slice(0, 1) : []),
        ...(chosen?.assumptions ?? []),
        ...[...new Set(Object.values(chosen?.sources ?? {}))].flatMap((s) => x.contenders.find((c) => c.track === s)?.assumptions ?? []),
      ]),
    ],
    evidenceLimitations: [...limitations],
    rejectedAlternatives: rejected,
    humanChecks: [...new Set(humanChecks)],
  };
}

/** Which candidates a merged winner stands for: itself and any identical plan. */
export function mergedWith(r: AdjudicationResult, id: string): string[] {
  return [id, ...Object.entries(r.merged).filter(([, k]) => k === id).map(([d]) => d)];
}
