import { randomUUID } from "node:crypto";
import type { LlmClient } from "@/lib/llm/types";
import { marketById } from "@/lib/markets";
import type { QlooClient, QlooEntity } from "@/lib/qloo";
import { adjudicate } from "./adjudicate";
import { evaluatePlan } from "./evaluate";
import { gatherEvidence, type GatherContext } from "./gather";
import { createHash } from "node:crypto";
import { CHALLENGE_ROUNDS, BEAM_WIDTH, ROLE_SYSTEM, checkRemainingRoles, neighborhoodCentroid, planFingerprint, runEvidenceAgent } from "./agent";
import { JUDGE_SYSTEM } from "./adjudicate";
import { componentRank, optimize, rankBetter, type OptimizeResult } from "./hybrid";
import { CONTRACT_VERSION, compileIntent, type IntentContract } from "./intent";
import { BudgetExceeded, budgeted, createLedger, memoized, scopedLedger } from "./ledger";
import { buildEvidenceMatrix, claimsOf, type MatrixContext } from "./matrix";
import { QueryRequestSchema, parseQuery, type QueryRequest } from "./query";
import type { RunDeps, RunOptions } from "./run";
import { SCREENS_VERSION, type Centroid, type RoleCheck } from "./screens";
import {
  ANCHOR_HYPOTHESIS_SYSTEM,
  CHOICE_COUNTRIES_SYSTEM,
  buildUserTrack,
  freezeBrief,
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
  type AgentRecord,
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
  // The agent's own challenge rounds; across tracks, one bounded round of tested hybrids follows.
  const maxRounds = opts.limits?.maxRepairs ?? CHALLENGE_ROUNDS[brief.depth];
  const beamWidth = opts.limits?.beamWidth ?? BEAM_WIDTH;

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
  let contract: IntentContract | null = null;
  let neighborhood: Centroid | null = null;
  let agentRecord: AgentRecord | undefined;
  // Structured role readings, shared so every track's components are screened alike.
  const roleChecks = new Map<string, RoleCheck>();
  const mctx = (): MatrixContext => ({
    brief,
    city: market.label,
    facts,
    anchorSource,
    contract: contract ?? undefined,
    roleChecks,
    neighborhood,
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
    const anchored = opts.anchors
      ? {
          anchors: opts.anchors.anchors,
          source: opts.anchors.source,
          notes: [
            `Audience anchors frozen from ${opts.anchors.from}: ${opts.anchors.anchors.map((a) => a.name).join(", ")}${opts.anchors.source === "model_hypothesis" ? " (model-suggested there; a person should confirm them)" : ""}.`,
          ],
        }
      : await timed("shared", () => measurementAnchors({ llm: llmFor("shared"), ctx: ctxFor("shared"), brief }));
    anchorSource = anchored.source;
    anchorNotes = anchored.notes;
    state.assumptions.push(...anchored.notes);
    if (!anchored.anchors.length) {
      state.stopReason = "insufficient_data";
      state.stopDetail = "None of the audience anchors could be found in Qloo, so audience affinity can't be measured.";
      throw new Cancelled();
    }
    const anchors = anchored.anchors;

    // The brief-intent contract and the named neighbourhood: shared inputs to every screen and explanation.
    contract = compileIntent(brief, market, { names: anchors.map((a) => a.name), source: anchored.source });
    neighborhood = contract.neighborhoods.length ? await timed("shared", () => neighborhoodCentroid(ctxFor("shared"), contract!).catch((err) => {
      if (err instanceof BudgetExceeded) throw err;
      return null;
    })) : null;
    // The user's named acts and brands get the same namesake protection as any name, once, shared.
    const countries = await timed("shared", () => userChoiceCountries(llmFor("shared"), brief, market));

    stage("tracks", "Building three plans independently: yours as given, the LLM's alone, and the evidence agent's");
    const t0 = Date.now();
    const userP = timed("user", () => buildUserTrack({ llm: llmFor("user"), ctx: ctxFor("user"), brief, anchors, countries }));
    const llmP = timed("llm", async () => {
      const draft = await generateLlmDraft(llmFor("llm"), frozen, market);
      return resolveLlmTrack({ llm: llmFor("llm"), ctx: ctxFor("llm"), brief, draft, anchors, countries });
    });
    // The single evidence agent: the frozen brief, the anchors, the contract and the locks. Not the
    // user's plan (an unlocked user choice is only a candidate), and never the LLM's.
    let agentN = 0;
    const agentP = timed("agent", () =>
      runEvidenceAgent({
        llm: llmFor("agent"),
        ctx: ctxFor("agent"),
        brief,
        contract: contract!,
        anchors,
        countries,
        neighborhood,
        roleChecks,
        facts,
        evaluate: async (plan) => {
          await ensureFacts([plan]);
          return evaluateIn("agent")(plan);
        },
        matrix: matrixOf,
        newIds: () => ({ candidateId: `agent-b${++agentN}`, blindId: blindId() }),
        briefFingerprint: frozen.fingerprint,
        rounds: maxRounds,
        beamWidth,
      }),
    );
    const [u, l, a] = await Promise.all([userP, llmP, agentP]);
    agentRecord = a.record;

    stage("evaluate", "Testing all three plans with the same Qloo checks and the same screens");
    const [ue, le] = await Promise.all([timed("user", () => evaluateIn("user")(u.plan)), timed("llm", () => evaluateIn("llm")(l.plan))]);
    await ensureFacts([u.plan, l.plan]);
    // Every plan gets the same structured role reading the agent's candidates got.
    await timed("shared", () => checkRemainingRoles(llmFor("shared"), ctxFor("shared"), brief, contract!, [u.plan, l.plan], roleChecks, facts));
    const U = candidate("user", "user", u, ue, snapshot("user", t0));
    const L = candidate("llm", "llm", l, le, snapshot("llm", t0));
    const A = candidate("agent", "agent", { plan: a.plan, open: a.open, sources: a.sources, assumptions: a.assumptions }, a.evaluation, snapshot("agent", t0));
    const chosen = planFingerprint(a.plan);
    for (const t of a.tested)
      if (planFingerprint(t.plan) !== chosen) alternatives.push({ ...t, candidateId: `agent-alt-${alternatives.length + 1}`, parent: "agent" });
    state.trials!.push(...a.trials.map((t): CandidateTrial => ({ ...t, iteration: 0 })));
    candidates.push(U, L, A, ...alternatives);
    contenders = [U, L, A];
    state.initialPlan = L.plan;
    await ensureFacts(candidates.map((c) => c.plan));

    stage("adjudicate", "Blind comparison of the three plans, in two orders");
    initial = await timed("adjudication", () =>
      adjudicate({ llm: llmFor("adjudication"), stage: "initial", candidates: contenders, matrix: matrixOf(contenders), brief, market, ledger: scopedLedger(ledger, "adjudication") }),
    );

    // The agent challenged its own plan already; across tracks, one bounded round of tested
    // hybrids (the strongest component per slot, and single swaps), each re-tested whole.
    stage("improve", "Testing hybrids of the three plans as complete plans");
    const leader = initial.winnerCandidateId ?? initial.evidenceOrder[0];
    let hybridN = 0;
    improvement = await timed("improvement", () =>
      optimize(
        { brief, contenders, incumbentId: leader, maxRounds: 1, flagged: initial!.flagged },
        {
          evaluate: async (plan) => {
            await ensureFacts([plan]);
            return evaluateIn("improvement")(plan);
          },
          search: async () => ({ proposals: [], trials: [] }),
          matrix: matrixOf,
          newIds: () => ({ candidateId: `hybrid-${++hybridN}`, blindId: blindId() }),
        },
      ),
    );
    if (improvement.stop === "budget") budgetHit = true;
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
  state.currentIteration = agentRecord?.rounds.length ?? 0;
  if (!state.stopReason) {
    const stop: StopReason = budgetHit || agentRecord?.stop === "budget" ? "api_budget_limit" : agentRecord?.stop === "round_limit" ? "iteration_limit" : "no_material_improvement";
    state.stopReason = stop;
    state.stopDetail =
      stop === "api_budget_limit"
        ? `${counted.used()} Qloo calls used.`
        : stop === "iteration_limit"
          ? `The agent used its ${maxRounds} challenge round(s).`
          : `The agent stopped challenging its plan: ${AGENT_STOP[agentRecord?.stop ?? "no_improvement"]}`;
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
      agent: agentRecord,
      config: {
        model: deps.llm.model,
        ranking,
        contractVersion: CONTRACT_VERSION,
        screensVersion: SCREENS_VERSION,
        beamWidth,
        challengeRounds: maxRounds,
        maxQlooCalls: state.maxQlooCalls,
        promptsFingerprint: createHash("sha256")
          .update([JUDGE_SYSTEM, ROLE_SYSTEM, ANCHOR_HYPOTHESIS_SYSTEM, CHOICE_COUNTRIES_SYSTEM].join("\n---\n"))
          .digest("hex")
          .slice(0, 16),
        sampling: "provider default (no temperature or seed is set); outputs are not deterministic",
        anchorsFrozenFrom: opts.anchors?.from,
      },
    };
  state.finishedAt = new Date().toISOString();
  emit({ type: "done", state });
  return state;
}

const AGENT_STOP: Record<AgentRecord["stop"], string> = {
  no_weakness: "no choice had a recorded weakness.",
  no_improvement: "the last substitution didn't materially improve the whole plan.",
  no_alternative: "no untried candidate was left for its weakest choice.",
  repeated_plan: "the substitution led back to a plan already tested.",
  round_limit: "it used every round.",
  budget: "the Qloo budget ran out.",
};

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
  for (const c of x.alternatives) rejected.push({ candidateId: c.candidateId, reason: "A complete plan the agent tested; the plan it kept ranked higher on the evidence order." });
  for (const r of x.improvement?.rounds ?? []) for (const a of r.attempts) if (!a.accepted) rejected.push({ candidateId: a.candidateId, reason: a.reason });

  const limitations = new Set<string>(["Qloo affinity is cultural evidence. It does not show sales, attendance, availability, budget fit or causation."]);
  if (chosen) for (const c of claimsOf(matrix, chosen.candidateId)) for (const l of c.limitations) limitations.add(l);

  return {
    candidateId: chosen?.candidateId ?? null,
    track: chosen?.track ?? null,
    verdict: fin.verdict,
    stable: fin.verdict === "winner" && x.decidedBy === "adjudication",
    decidedBy: x.decidedBy,
    provisional: !!chosen && x.decidedBy === "evidence_order",
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
