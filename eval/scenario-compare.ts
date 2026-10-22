/**
 * Compare the sequential control and the parallel architecture on the 15 scenarios.
 *
 *   npm run scenario:run                                          # sequential (the control)
 *   RECOMMENDATION_ARCHITECTURE=parallel npm run scenario:run     # parallel
 *   npm run scenario:compare
 *
 * Reads eval/out/scenario-runs/<id>.json and eval/out/scenario-runs-parallel/<id>.json and
 * writes eval/out/scenario-architecture-comparison.{md,json} (git-ignored: Qloo-derived).
 *
 * Neither architecture is scored only on its own terms: each scores its final plan against its
 * own audience anchors, which favours the plan built for them. So both final plans are also
 * re-scored under BOTH anchor sets with the same deterministic rubric. A blind LLM judge compares
 * the two final plans in both orders (a preference counts only when both orders agree). Human
 * preference is collected separately in eval/out/scenario-architecture-human-review.json, with
 * the plan labels' key in a separate file, and is never mixed into the Qloo measures.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import { createMemoryCache } from "../src/lib/cache/cache";
import { evaluatePlan } from "../src/lib/crashtest/evaluate";
import { gatherEvidence } from "../src/lib/crashtest/gather";
import { createLedger } from "../src/lib/crashtest/ledger";
import { SLOTS, type CulturalPlan, type EntityRef, type PlanEvaluation, type RunState } from "../src/lib/crashtest/types";
import { getQlooEnv } from "../src/lib/env";
import { getLlm } from "../src/lib/llm";
import { marketById } from "../src/lib/markets";
import { createQlooClient } from "../src/lib/qloo";
import { withCache } from "../src/lib/qloo/cached";
import { judgePlans } from "./judge";

const OUT = "eval/out";
/** PARALLEL_TAG=<tag> compares eval/out/scenario-runs-<tag> (default "parallel"); outputs carry the tag. */
const TAG = process.env.PARALLEL_TAG ?? "parallel";
const PAR_DIR = `scenario-runs-${TAG}`;
const SUFFIX = TAG === "parallel" ? "" : `-${TAG}`;
const intake = JSON.parse(readFileSync(`${OUT}/scenario-intake.json`, "utf8")) as { rows: { id: string; title: string }[] };
const load = (dir: string, id: string): RunState | null => (existsSync(`${OUT}/${dir}/${id}.json`) ? (JSON.parse(readFileSync(`${OUT}/${dir}/${id}.json`, "utf8")) as RunState) : null);
const qloo = withCache(createQlooClient({ ...getQlooEnv(), timeoutMs: 20_000, maxRetries: 4, onEmpty: () => {} }), createMemoryCache(50_000));
const llm = getLlm();

/** Re-score a plan under a given audience with the same deterministic rubric. */
async function score(state: RunState, plan: CulturalPlan, anchors: EntityRef[]): Promise<PlanEvaluation> {
  const market = marketById(state.brief.marketId)!;
  const ctx = { client: qloo, ledger: createLedger(() => 0), market };
  const p = { ...plan, anchors };
  return evaluatePlan({ plan: p, evidence: await gatherEvidence(ctx, p), constraints: state.brief.constraints, city: market.label, iteration: 0 });
}

const coverage = (e: PlanEvaluation | null | undefined) => {
  if (!e?.components.length) return 0;
  const measured = e.components.flatMap((c) => c.dimensions.filter((d) => d.key !== "distinct" && d.score !== undefined)).length;
  return measured / (e.components.length * 3);
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};
const ms = (s: RunState) => (s.finishedAt ? Date.parse(s.finishedAt) - Date.parse(s.startedAt) : 0);
const popularity = (p: CulturalPlan | null) => (p?.components ?? []).flatMap((c) => (c.entity?.popularity != null ? [c.entity.popularity] : []));
const labels = (p: CulturalPlan | null) => SLOTS.map((s) => p?.components.find((c) => c.slot === s)?.label ?? "(open)");

interface Row {
  id: string;
  title: string;
  error?: string;
  same: boolean;
  seq: Side;
  par: Side & { winnerTrack: string | null; verdict: string; stable: boolean; initialVerdict: string; openSlots: number };
  /** Final plans re-scored: supported under the sequential run's anchors and under the parallel run's. */
  cross: { seqUnderSeq: number; seqUnderPar: number; parUnderSeq: number; parUnderPar: number; sameAnchors: boolean };
  judge: { preferred: "parallel" | "sequential" | "tie"; consistent: boolean; reason: string } | null;
}
interface Side {
  final: string[];
  draftSupported: number | null;
  finalSupported: number | null;
  violations: number;
  unresolved: number;
  coverage: number;
  accepted: number;
  rejected: number;
  humanChecks: number;
  meanPopularity: number | null;
  mainstream: number;
  ms: number;
  qlooChecks: number;
  qlooRequests: number | null;
  modelCalls: number;
  stopReason: string | undefined;
  failed: boolean;
}

function side(s: RunState, final: CulturalPlan | null, finalEval: PlanEvaluation | null, draftEval: PlanEvaluation | null | undefined, accepted: number, rejected: number): Side {
  const pop = popularity(final);
  return {
    final: labels(final),
    draftSupported: draftEval?.supported ?? null,
    finalSupported: finalEval?.supported ?? null,
    violations: finalEval?.hardConstraintViolations.length ?? 0,
    unresolved: (final?.components ?? []).filter((c) => c.resolution !== "resolved").length,
    coverage: coverage(finalEval),
    accepted,
    rejected,
    humanChecks: s.unresolvedQuestions.length,
    meanPopularity: pop.length ? pop.reduce((a, b) => a + b, 0) / pop.length : null,
    mainstream: pop.filter((x) => x >= 0.995).length,
    ms: ms(s),
    qlooChecks: s.qlooUsage?.checks ?? s.qlooCallsUsed,
    qlooRequests: s.qlooUsage?.requests ?? null,
    modelCalls: s.llmCalls,
    stopReason: s.stopReason,
    failed: s.stopReason === "error" || !final,
  };
}

const rows: Row[] = [];
/** The versions the parallel runs recorded, as they recorded them. */
const parVersions = new Set<string>();
for (const { id, title } of intake.rows) {
  const seq = load("scenario-runs", id);
  const par = load(PAR_DIR, id);
  process.stdout.write(`${id} … `);
  if (!seq || !par?.parallel) {
    console.log(`skipped (${!seq ? "no sequential run" : "no parallel run"})`);
    continue;
  }
  const p = par.parallel;
  if (par.provenance?.runVersion) parVersions.add(par.provenance.runVersion);
  const seqFinal = seq.plan;
  const parFinal = p.verdict.plan;
  const attempts = p.rounds.flatMap((r) => r.attempts.filter((a) => a.rejectionCode !== "duplicate"));
  const seqAnchors = seq.plan?.anchors ?? [];
  const parAnchors = par.plan?.anchors ?? p.candidates[0]?.plan.anchors ?? [];
  const sameAnchors = seqAnchors.map((a) => a.id).sort().join() === parAnchors.map((a) => a.id).sort().join();
  const supported = async (plan: CulturalPlan | null, anchors: EntityRef[]) => (plan && anchors.length ? (await score(seq, plan, anchors)).supported : 0);
  const cross = {
    seqUnderSeq: await supported(seqFinal, seqAnchors),
    seqUnderPar: sameAnchors ? -1 : await supported(seqFinal, parAnchors),
    parUnderSeq: sameAnchors ? -1 : await supported(parFinal, seqAnchors),
    parUnderPar: await supported(parFinal, parAnchors),
    sameAnchors,
  };
  if (sameAnchors) {
    cross.seqUnderPar = cross.seqUnderSeq;
    cross.parUnderSeq = cross.parUnderPar;
  }
  const same = labels(seqFinal).join("|") === labels(parFinal).join("|");
  let judge: Row["judge"] = null;
  if (!same && seqFinal && parFinal) {
    const v = await judgePlans(llm, seq.brief, marketById(seq.brief.marketId)!, parFinal, seqFinal).catch(() => null);
    if (v) judge = { preferred: v.preferred === "agent" ? "parallel" : v.preferred === "draft" ? "sequential" : "tie", consistent: v.consistent, reason: v.reason };
  }
  const llmCand = p.candidates.find((c) => c.candidateId === "llm");
  rows.push({
    id,
    title,
    same,
    seq: side(seq, seqFinal, seq.evaluations.at(-1) ?? null, seq.evaluations[0], seq.changes.filter((c) => !c.reverted).length, seq.changes.filter((c) => c.reverted).length),
    par: {
      ...side(par, parFinal, p.verdict.evaluation, llmCand?.evaluation, attempts.filter((a) => a.accepted).length, attempts.filter((a) => !a.accepted).length),
      winnerTrack: p.verdict.track,
      verdict: p.verdict.verdict,
      stable: p.verdict.stable,
      initialVerdict: p.initial.verdict,
      openSlots: p.verdict.open.length,
    },
    cross,
    judge,
  });
  console.log(`seq ${cross.seqUnderSeq}/${cross.seqUnderPar}, par ${cross.parUnderSeq}/${cross.parUnderPar}, final ${p.verdict.track} (${p.verdict.verdict}), judge ${judge ? `${judge.preferred}${judge.consistent ? "" : " (orders disagreed)"}` : same ? "same plan" : "-"}`);
}

// ---------- blinded human review: created once, never overwritten ----------
const reviewFile = `${OUT}/scenario-architecture-human-review${SUFFIX}.json`;
const keyFile = `${OUT}/scenario-architecture-human-review-key${SUFFIX}.json`;
if (!existsSync(reviewFile)) {
  const key: Record<string, { X: string; Y: string }> = {};
  const review = rows.map((r) => {
    const parFirst = randomInt(2) === 0;
    key[r.id] = parFirst ? { X: "parallel", Y: "sequential" } : { X: "sequential", Y: "parallel" };
    const [x, y] = parFirst ? [r.par.final, r.seq.final] : [r.seq.final, r.par.final];
    return { id: r.id, title: r.title, X: x, Y: y, preferred: null as "X" | "Y" | "tie" | null, reason: null as string | null, reviewer: null as string | null };
  });
  writeFileSync(reviewFile, JSON.stringify({ instructions: "For each scenario, set preferred to X, Y or tie, with a one-sentence reason and your name. Don't open the key file until you are done.", rows: review }, null, 2));
  writeFileSync(keyFile, JSON.stringify(key, null, 2));
}
const humanRows = (JSON.parse(readFileSync(reviewFile, "utf8")) as { rows: { id: string; preferred: string | null; reviewer: string | null }[] }).rows;
const humanKey = existsSync(keyFile) ? (JSON.parse(readFileSync(keyFile, "utf8")) as Record<string, { X: string; Y: string }>) : {};
const reviewed = humanRows.filter((h) => h.preferred && h.reviewer?.trim());
const human = {
  reviewed: reviewed.length,
  parallel: reviewed.filter((h) => h.preferred !== "tie" && humanKey[h.id]?.[h.preferred as "X" | "Y"] === "parallel").length,
  sequential: reviewed.filter((h) => h.preferred !== "tie" && humanKey[h.id]?.[h.preferred as "X" | "Y"] === "sequential").length,
  tie: reviewed.filter((h) => h.preferred === "tie").length,
};

// ---------- totals and report ----------
const sum = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0);
const n = rows.length;
const slots = sum((r) => (r.seq.final.length ? SLOTS.length : 0));
const totals = {
  scenarios: n,
  sequential: {
    draftSupported: sum((r) => r.seq.draftSupported ?? 0),
    ownAnchors: sum((r) => r.cross.seqUnderSeq),
    otherAnchors: sum((r) => r.cross.seqUnderPar),
    violations: sum((r) => r.seq.violations),
    unresolved: sum((r) => r.seq.unresolved),
    coverage: n ? sum((r) => r.seq.coverage) / n : 0,
    accepted: sum((r) => r.seq.accepted),
    rejected: sum((r) => r.seq.rejected),
    humanChecks: sum((r) => r.seq.humanChecks),
    mainstream: sum((r) => r.seq.mainstream),
    failures: rows.filter((r) => r.seq.failed).length,
    medianSeconds: median(rows.map((r) => r.seq.ms / 1000)),
    slowestSeconds: Math.max(0, ...rows.map((r) => r.seq.ms / 1000)),
    qlooChecks: sum((r) => r.seq.qlooChecks),
    qlooRequests: rows.every((r) => r.seq.qlooRequests !== null) ? sum((r) => r.seq.qlooRequests ?? 0) : null,
    modelCalls: sum((r) => r.seq.modelCalls),
  },
  parallel: {
    llmTrackSupported: sum((r) => r.par.draftSupported ?? 0),
    ownAnchors: sum((r) => r.cross.parUnderPar),
    otherAnchors: sum((r) => r.cross.parUnderSeq),
    violations: sum((r) => r.par.violations),
    unresolved: sum((r) => r.par.unresolved),
    openSlots: sum((r) => r.par.openSlots),
    coverage: n ? sum((r) => r.par.coverage) / n : 0,
    accepted: sum((r) => r.par.accepted),
    rejected: sum((r) => r.par.rejected),
    humanChecks: sum((r) => r.par.humanChecks),
    mainstream: sum((r) => r.par.mainstream),
    failures: rows.filter((r) => r.par.failed).length,
    medianSeconds: median(rows.map((r) => r.par.ms / 1000)),
    slowestSeconds: Math.max(0, ...rows.map((r) => r.par.ms / 1000)),
    qlooChecks: sum((r) => r.par.qlooChecks),
    qlooRequests: rows.every((r) => r.par.qlooRequests !== null) ? sum((r) => r.par.qlooRequests ?? 0) : null,
    modelCalls: sum((r) => r.par.modelCalls),
    winners: Object.fromEntries(["user", "llm", "agent", "hybrid", "none"].map((t) => [t, rows.filter((r) => (r.par.winnerTrack ?? "none") === t).length])),
    stable: rows.filter((r) => r.par.stable).length,
    unstableInitial: rows.filter((r) => r.par.initialVerdict === "unstable").length,
    abstained: rows.filter((r) => r.par.verdict === "insufficient_evidence").length,
  },
  samePlan: rows.filter((r) => r.same).length,
  judge: {
    parallel: rows.filter((r) => r.judge?.preferred === "parallel").length,
    sequential: rows.filter((r) => r.judge?.preferred === "sequential").length,
    tie: rows.filter((r) => r.judge?.preferred === "tie").length,
    inconsistent: rows.filter((r) => r.judge && !r.judge.consistent).length,
  },
  human,
};

const pct = (x: number) => `${Math.round(x * 100)}%`;
const s = totals.sequential;
const p = totals.parallel;
const md = [
  "# Sequential vs parallel architecture — 15 scenarios",
  "",
  `Generated ${new Date().toISOString()}. Sequential: the control (\`crash:v15\`), runs as recorded in \`eval/out/scenario-runs\`. Parallel: \`${[...parVersions].join(", ") || "unknown"}\`, runs in \`eval/out/${PAR_DIR}\`. Exact counts over ${n} scenarios (${slots} choices); no significance claims.`,
  "",
  "## Totals",
  "",
  "| Measure | Sequential | Parallel |",
  "|---|---:|---:|",
  `| Supported choices, LLM draft (sequential) / LLM track (parallel) | ${s.draftSupported} of ${slots} | ${p.llmTrackSupported} of ${slots} |`,
  `| Supported choices in the final plan, own anchors | ${s.ownAnchors} of ${slots} | ${p.ownAnchors} of ${slots} |`,
  `| Supported choices in the final plan, the other architecture's anchors | ${s.otherAnchors} of ${slots} | ${p.otherAnchors} of ${slots} |`,
  `| Hard-constraint violations in final plans | ${s.violations} | ${p.violations} |`,
  `| Unresolved choices in final plans (Qloo doesn't know them) | ${s.unresolved} | ${p.unresolved} |`,
  `| Slots left open in final plans | 0 | ${p.openSlots} |`,
  `| Mean evidence coverage of final plans | ${pct(s.coverage)} | ${pct(p.coverage)} |`,
  `| Changes accepted / rejected after full re-test | ${s.accepted} / ${s.rejected} | ${p.accepted} / ${p.rejected} (hybrids) |`,
  `| Checks left for a person | ${s.humanChecks} | ${p.humanChecks} |`,
  `| Mainstream (top-0.5%) names in final plans | ${s.mainstream} | ${p.mainstream} |`,
  `| Failed runs | ${s.failures} | ${p.failures} |`,
  `| Run time, median / slowest | ${Math.round(s.medianSeconds)} s / ${Math.round(s.slowestSeconds)} s | ${Math.round(p.medianSeconds)} s / ${Math.round(p.slowestSeconds)} s |`,
  `| Qloo checks / requests sent | ${s.qlooChecks} / ${s.qlooRequests ?? "not measured"} | ${p.qlooChecks} / ${p.qlooRequests ?? "not measured"} |`,
  `| Model calls | ${s.modelCalls} | ${p.modelCalls} |`,
  "",
  `Parallel final plans came from: you ${p.winners.user}, the LLM ${p.winners.llm}, the agent ${p.winners.agent}, a hybrid ${p.winners.hybrid}, none ${p.winners.none}. Final verdict stable under order rotation: ${p.stable} of ${n}. First blind comparison unstable: ${p.unstableInitial} of ${n}. Abstained: ${p.abstained}.`,
  "",
  `Both architectures reached the same final plan in ${totals.samePlan} of ${n} scenarios.`,
  "",
  `**Blind LLM judge (no evidence, both orders; a preference counts only when both agree):** parallel ${totals.judge.parallel}, sequential ${totals.judge.sequential}, tie ${totals.judge.tie} (of which the orders disagreed: ${totals.judge.inconsistent}). The judge is the same model family as the drafting model, so self-preference bias may remain.`,
  "",
  `**Blind human preference:** ${human.reviewed ? `${human.reviewed} reviewed — parallel ${human.parallel}, sequential ${human.sequential}, tie ${human.tie}.` : `not yet reviewed (0 of ${n}). Fill in \`${reviewFile}\`; the label key is in a separate file.`}`,
  "",
  "## Per scenario",
  "",
  "| Scenario | Sequential final (own / other anchors) | Parallel final (own / other anchors) | Parallel winner | Blind judge | Time s (seq / par) | Qloo checks (seq / par) |",
  "|---|---|---|---|---|---:|---:|",
  ...rows.map(
    (r) =>
      `| ${r.title} | ${r.seq.final.join(" · ")} (${r.cross.seqUnderSeq} / ${r.cross.seqUnderPar}) | ${r.par.final.join(" · ")} (${r.cross.parUnderPar} / ${r.cross.parUnderSeq}) | ${r.par.winnerTrack ?? "none"} (${r.par.verdict}${r.par.stable ? ", stable" : ""}) | ${r.same ? "same plan" : r.judge ? `${r.judge.preferred}${r.judge.consistent ? "" : " (orders disagreed)"}` : "–"} | ${Math.round(r.seq.ms / 1000)} / ${Math.round(r.par.ms / 1000)} | ${r.seq.qlooChecks} / ${r.par.qlooChecks} |`,
  ),
  "",
  "## Reading this",
  "",
  "- \"Own anchors\" is each architecture scored on the audience it planned for; \"other anchors\" re-scores the same final plan on the other architecture's audience. When the user named anchors, both are the same.",
  "- Supported counts are this app's rubric over Qloo affinity; they are cultural evidence, not proof of sales, attendance or causation.",
  "- The parallel architecture is not declared better on its own rubric. It stays behind `RECOMMENDATION_ARCHITECTURE=parallel` until blind human review agrees.",
  "",
].join("\n");

writeFileSync(`${OUT}/scenario-architecture-comparison${SUFFIX}.md`, md);
writeFileSync(`${OUT}/scenario-architecture-comparison${SUFFIX}.json`, JSON.stringify({ generatedAt: new Date().toISOString(), parallelRuns: PAR_DIR, totals, rows }, null, 2));
console.log(`wrote ${OUT}/scenario-architecture-comparison${SUFFIX}.md`);
