/**
 * Evaluation run: LLM-only draft vs Crash-Test agent on fixed briefs.
 *
 *   npm run live eval/run.ts                      # every case
 *   npm run live eval/run.ts -- london-coffee     # some cases by id
 *
 * For each brief: run the agent live. Its first draft (the model alone, no Qloo) is the
 * baseline; its final plan is the treatment. Then:
 * 1. in-run scores: both plans as the agent's own evaluator scored them (by construction the
 *    agent optimises these, so they show the loop works, not that the plan is better);
 * 2. held-out scores: both plans re-scored with a different set of audience anchors the agent
 *    never saw;
 * 3. a blind judge comparing the two plans in both orders.
 *
 * Writes eval/out/results.json (git-ignored: Qloo-derived). docs/EVALUATION.md is built from it
 * by eval/report.ts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createMemoryCache } from "../src/lib/cache/cache";
import { nameKey } from "../src/lib/engine/stats";
import { evaluatePlan } from "../src/lib/crashtest/evaluate";
import { gatherEvidence } from "../src/lib/crashtest/gather";
import { createLedger } from "../src/lib/crashtest/ledger";
import { findInMarket, toRef } from "../src/lib/crashtest/plan";
import { runCrashTest } from "../src/lib/crashtest/run";
import type { CandidateTrial, CulturalPlan, PlanEvaluation, RunState } from "../src/lib/crashtest/types";
import { getQlooEnv } from "../src/lib/env";
import { getLlmEnv } from "../src/lib/env";
import { createChatGptLlm, getLlm } from "../src/lib/llm";
import { createFileStore } from "../src/lib/llm/credential-store";
import type { LlmClient } from "../src/lib/llm/types";
import { marketById, type Market } from "../src/lib/markets";
import { createQlooClient, type QlooClient } from "../src/lib/qloo";
import { withCache } from "../src/lib/qloo/cached";
import { rankingFrom, RUN_VERSION } from "../src/lib/crashtest/version";
import type { EntityRef } from "../src/lib/crashtest/types";
import { loadBaseline, type BaselineCase } from "./baseline";
import { CASES, type EvalCase } from "./cases";
import { judgePlans, judgeWithEvidence, type EvidenceVerdict, type Verdict } from "./judge";

const OUT = "eval/out";
/** FROZEN=<baseline id> starts every brief from its saved plan instead of a fresh draft. */
const FROZEN = process.env.FROZEN;
if (process.argv.includes("--frozen") && !FROZEN) throw new Error("eval:frozen needs FROZEN=<baseline id> (make one with BASELINE_ID=<id> npm run eval:freeze).");
const baseline = FROZEN ? loadBaseline(FROZEN) : null;
const RANKING = rankingFrom();
// EVAL_TAG writes to results-<tag>.json, so a model comparison never overwrites the main run.
const FILE = process.env.EVAL_TAG ? `${OUT}/results-${process.env.EVAL_TAG}.json` : `${OUT}/results.json`;

/**
 * The agent's model comes from LLM_MODEL as usual. JUDGE_MODEL pins the judges to one model, so
 * comparing agent models doesn't also change who judges them.
 */
const agentLlm = getLlm();
const judgeLlm: LlmClient = process.env.JUDGE_MODEL
  ? createChatGptLlm({
      store: createFileStore(getLlmEnv().chatgptAuthFile),
      model: process.env.JUDGE_MODEL,
      reasoningEffort: getLlmEnv().reasoningEffort,
    })
  : agentLlm;

/** Token usage of the agent's model calls, as the provider reports it; unknown stays null. */
export interface Usage {
  model: string;
  calls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Calls whose response carried no usage. */
  unknownCalls: number;
}

function metered(llm: LlmClient) {
  const usage: Usage = { model: llm.model, calls: 0, inputTokens: null, outputTokens: null, unknownCalls: 0 };
  const client: LlmClient = {
    provider: llm.provider,
    model: llm.model,
    async generateText(req) {
      const r = await llm.generateText(req);
      usage.calls++;
      const i = r.usage?.inputTokens ?? null;
      const o = r.usage?.outputTokens ?? null;
      if (i === null && o === null) usage.unknownCalls++;
      if (i !== null) usage.inputTokens = (usage.inputTokens ?? 0) + i;
      if (o !== null) usage.outputTokens = (usage.outputTokens ?? 0) + o;
      return r;
    },
  };
  return { client, usage };
}

export interface Metrics {
  /** Hard rules the final plan breaks. */
  violations: number;
  /** User choices Qloo couldn't verify that the agent replaced anyway. */
  unknownUserChoicesChanged: number;
  /** Re-tested candidates kept / not kept, and choices left for a human (open questions). */
  accepted: number;
  rejected: number;
  abstained: number;
  qlooChecks: number;
  qlooReused: number;
  qlooCacheHits: number | null;
  qlooRequests: number | null;
}

export interface Scored {
  supported: number;
  total: number | null;
  /** Per slot: status. */
  statuses: Record<string, string>;
}

export interface CaseRow {
  id: string;
  split: EvalCase["split"];
  city: string;
  draft: string[];
  final: string[];
  /** Draft choices Qloo couldn't find at all. */
  draftUnresolved: string[];
  inRun: { draft: Scored; final: Scored } | null;
  heldOut: { anchors: string[]; missing: string[]; excluded?: string[]; draft: Scored; final: Scored } | null;
  /** Primary: judges from the held-out Qloo evidence, blind to which plan is the agent's. */
  evidenceJudge: EvidenceVerdict | null;
  /** Reference only: a judge with no evidence, choosing on its own taste. */
  judge: Verdict | null;
  run: Pick<RunState, "stopReason" | "stopDetail" | "currentIteration" | "qlooCallsUsed" | "llmCalls"> & {
    ms: number;
    usage?: Usage;
    changes: { slot: string; before: string; after: string; reverted: boolean; outcome?: string }[];
    /** Every candidate considered, with its views, fused rank, screen result and re-test: the run's candidate provenance. */
    trials?: TrialRow[];
    /** Counted from the finished run; see eval/report.ts for how each is used. */
    metrics?: Metrics;
  };
  error: string | null;
}

export interface TrialRow {
  iteration: number;
  slot: string;
  name: string;
  source: CandidateTrial["source"];
  views?: CandidateTrial["views"];
  fusedRank?: number;
  audienceRank?: number;
  localityResult?: string;
  roleFit?: number;
  briefFit: CandidateTrial["briefFit"];
  screenedOutReason?: string;
  retest?: { accepted: boolean; rejectionCode?: string; slotStatus: string; slotScore: [number | null, number | null]; supported: [number, number] };
}

const trialRow = (t: CandidateTrial): TrialRow => ({
  iteration: t.iteration,
  slot: t.slot,
  name: t.name,
  source: t.source,
  views: t.views,
  fusedRank: t.fusedRank,
  audienceRank: t.audienceRank,
  localityResult: t.localityResult,
  roleFit: t.roleFit,
  briefFit: t.briefFit,
  screenedOutReason: t.screenedOutReason,
  retest: t.retest && {
    accepted: t.retest.accepted,
    rejectionCode: t.retest.rejectionCode,
    slotStatus: `${t.retest.slotStatusBefore} → ${t.retest.slotStatusAfter}`,
    slotScore: [t.retest.slotScoreBefore ?? null, t.retest.slotScoreAfter ?? null],
    supported: [t.retest.supportedBefore, t.retest.supportedAfter],
  },
});

const scored = (e: PlanEvaluation): Scored => ({
  supported: e.supported,
  total: e.totalScore ?? null,
  statuses: Object.fromEntries(e.components.map((c) => [c.slot, c.status])),
});

const labels = (p: CulturalPlan | null) => (p?.components ?? []).map((c) => `${c.slot}: ${c.label}`);

async function heldOutScore(qloo: QlooClient, market: Market, c: EvalCase, state: RunState, frozen?: BaselineCase) {
  // Every entity either plan uses as a choice: none of them may also be a held-out anchor.
  const chosen = [state.initialPlan, state.plan].flatMap((p) => p?.components ?? []);
  const isChoice = (e: { id: string; name: string }) =>
    chosen.some((x) => x.entity?.id === e.id || nameKey(x.label) === nameKey(e.name));
  const names = frozen ? frozen.heldOut.map((h) => h.name) : [...c.heldOutAnchors, ...(c.heldOutSpares ?? [])];
  // Frozen runs use the anchors as resolved when the baseline was made, so both versions match.
  const found: (EntityRef | null)[] = frozen
    ? frozen.heldOut.map((h) => h.ref)
    : (await Promise.all(names.map((n) => findInMarket(qloo, n, ["brand", "artist"], market)))).map((e) => (e ? toRef(e) : null));
  const missing = names.filter((_, i) => !found[i]);
  const excluded = found.flatMap((e) => (e && isChoice(e) ? [e.name] : []));
  const anchors = found.flatMap((e) => (e && !isChoice(e) ? [e] : [])).slice(0, frozen?.heldOutCount ?? c.heldOutAnchors.length);
  if (anchors.length < 2) return { anchors: anchors.map((a) => a.name), missing, excluded, draft: null, final: null };
  const score = async (plan: CulturalPlan) => {
    const ctx = { client: qloo, ledger: createLedger(() => 0), market };
    const p = { ...plan, anchors };
    const evidence = await gatherEvidence(ctx, p);
    return evaluatePlan({ plan: p, evidence, constraints: state.brief.constraints, city: market.label, iteration: 0 });
  };
  return {
    anchors: anchors.map((a) => a.name),
    missing,
    excluded,
    draft: await score(state.initialPlan!),
    final: await score(state.plan!),
  };
}

function metricsOf(state: RunState): Metrics {
  const first = state.evaluations[0];
  const last = state.evaluations.at(-1);
  const unknownUserChoicesChanged = (state.initialPlan?.components ?? []).filter((c) => {
    const before = first?.components.find((x) => x.slot === c.slot);
    const after = state.plan?.components.find((x) => x.slot === c.slot);
    return c.origin === "user_provided" && before?.status === "unresolved" && after && after.label !== c.label;
  }).length;
  const u = state.qlooUsage;
  return {
    violations: last?.hardConstraintViolations.length ?? 0,
    unknownUserChoicesChanged,
    accepted: state.changes.filter((c) => !c.reverted).length,
    rejected: state.changes.filter((c) => c.reverted).length,
    abstained: state.unresolvedQuestions.length,
    qlooChecks: u?.checks ?? state.qlooCallsUsed,
    qlooReused: u?.reused ?? 0,
    qlooCacheHits: u?.cacheHits ?? null,
    qlooRequests: u?.requests ?? null,
  };
}

async function runCase(qloo: QlooClient, c: EvalCase): Promise<CaseRow> {
  const market = marketById(c.brief.marketId)!;
  const frozen = baseline?.cases.find((x) => x.id === c.id);
  if (baseline && !frozen) throw new Error(`baseline ${baseline.id} has no case ${c.id}`);
  const started = Date.now();
  const { client: llm, usage } = metered(agentLlm);
  const state = await runCrashTest(
    { qloo, llm, qlooStats },
    frozen ? frozen.brief : c.brief,
    { runVersion: RUN_VERSION, ranking: RANKING, start: frozen ? { plan: frozen.initialPlan, assumptions: frozen.assumptions } : undefined },
  );
  const ms = Date.now() - started;
  const run = {
    stopReason: state.stopReason,
    stopDetail: state.stopDetail,
    currentIteration: state.currentIteration,
    qlooCallsUsed: state.qlooCallsUsed,
    llmCalls: state.llmCalls,
    usage,
    ms,
    changes: state.changes.map((x) => ({ slot: x.slot, before: x.before, after: x.after, reverted: Boolean(x.reverted), outcome: x.retest ? (x.retest.accepted ? "accepted" : x.retest.rejectionCode) : undefined })),
    metrics: metricsOf(state),
    trials: (state.trials ?? []).map(trialRow),
  };
  const base = {
    id: c.id,
    split: c.split,
    city: market.label,
    draft: labels(state.initialPlan),
    final: labels(state.plan),
    draftUnresolved: (state.initialPlan?.components ?? []).filter((x) => x.resolution !== "resolved").map((x) => x.label),
    run,
  };
  if (!state.initialPlan || !state.plan || !state.evaluations.length) {
    return { ...base, inRun: null, heldOut: null, evidenceJudge: null, judge: null, error: state.stopDetail ?? "no evaluation" };
  }
  const inRun = { draft: scored(state.evaluations[0]), final: scored(state.evaluations.at(-1)!) };
  const held = await heldOutScore(qloo, market, c, state, frozen);
  const judge = await judgePlans(judgeLlm, state.brief, market, state.plan, state.initialPlan).catch(() => null);
  const evidenceJudge =
    held.draft && held.final
      ? await judgeWithEvidence(
          judgeLlm,
          state.brief,
          market,
          held.anchors,
          { plan: state.plan, evaluation: held.final },
          { plan: state.initialPlan, evaluation: held.draft },
        ).catch(() => null)
      : null;
  return {
    ...base,
    inRun,
    heldOut:
      held.draft && held.final
        ? { anchors: held.anchors, missing: held.missing, excluded: held.excluded, draft: scored(held.draft), final: scored(held.final) }
        : null,
    evidenceJudge,
    judge,
    error: held.draft ? null : `held-out anchors not found: ${held.missing.join(", ")}`,
  };
}

const only = process.argv.slice(2).filter((a) => a !== "--" && a !== "--frozen");
// Cache hits and real requests are counted per run (the controller takes the difference).
const qlooStats = { hits: 0, requests: 0 };
const qloo = withCache(
  createQlooClient({ ...getQlooEnv(), timeoutMs: 20_000, maxRetries: 4, onEmpty: () => {} }),
  createMemoryCache(50_000),
  undefined,
  qlooStats,
);
mkdirSync(OUT, { recursive: true });
const previous: CaseRow[] = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")).cases : [];
const rows = new Map(previous.map((r) => [r.id, r]));

for (const c of CASES.filter((x) => only.length === 0 || only.includes(x.id))) {
  process.stdout.write(`${c.id} … `);
  let row: CaseRow;
  try {
    row = await runCase(qloo, c);
  } catch (err) {
    row = {
      id: c.id,
      split: c.split,
      city: c.brief.marketId,
      draft: [],
      final: [],
      draftUnresolved: [],
      inRun: null,
      heldOut: null,
      evidenceJudge: null,
      judge: null,
      run: { stopReason: "error", stopDetail: undefined, currentIteration: 0, qlooCallsUsed: 0, llmCalls: 0, ms: 0, changes: [] },
      error: err instanceof Error ? err.message : String(err),
    };
  }
  rows.set(c.id, row);
  console.log(
    row.error && !row.inRun
      ? `ERROR ${row.error}`
      : `${Math.round(row.run.ms / 1000)} s, ${row.run.changes.length} changes, in-run ${row.inRun?.draft.supported}→${row.inRun?.final.supported}, held-out ${row.heldOut?.draft.supported ?? "-"}→${row.heldOut?.final.supported ?? "-"}, evidence judge ${row.evidenceJudge?.preferred ?? "-"}, blind judge ${row.judge?.preferred ?? "-"}${row.error ? ` (${row.error})` : ""}`,
  );
  const ordered = CASES.flatMap((x) => (rows.has(x.id) ? [rows.get(x.id)!] : []));
  writeFileSync(
    FILE,
    JSON.stringify({ ranAt: new Date().toISOString(), runVersion: RUN_VERSION, ranking: RANKING, frozen: FROZEN ?? null, model: agentLlm.model, judgeModel: judgeLlm.model, cases: ordered }, null, 2),
  );
}
