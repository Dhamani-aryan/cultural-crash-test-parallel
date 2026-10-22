/**
 * Run every review-ready scenario from scenario:intake through the current default agent.
 *
 *   npm run scenario:run
 *   npm run scenario:run -- eyewear-tokyo non-alcoholic-london
 *
 * Full states are written under eval/out/scenario-runs; the compact index is suitable for review.
 *
 * RECOMMENDATION_ARCHITECTURE=parallel runs the parallel engine instead and writes to
 * eval/out/scenario-runs-parallel and eval/out/scenario-summary-parallel.json, so it never
 * overwrites the sequential baseline. SCENARIO_TAG=<tag> picks another suffix.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { runCrashTest } from "../src/lib/crashtest/run";
import { architectureFrom, runVersionFor } from "../src/lib/crashtest/version";
import type { RunState } from "../src/lib/crashtest/types";
import { createMemoryCache } from "../src/lib/cache/cache";
import { getQlooEnv } from "../src/lib/env";
import type { IntakeState } from "../src/lib/intake/types";
import { toLaunchBrief } from "../src/lib/intake/validate";
import { getLlm } from "../src/lib/llm";
import { createQlooClient } from "../src/lib/qloo";
import { withCache } from "../src/lib/qloo/cached";

const intakeFile = "eval/out/scenario-intake.json";
if (!existsSync(intakeFile)) throw new Error("Run npm run scenario:intake first.");
const input = JSON.parse(readFileSync(intakeFile, "utf8")) as {
  rows: { id: string; title: string; readyForReview?: boolean; state?: IntakeState; error: string | null }[];
};
const only = new Set(process.argv.slice(2).filter((x) => x !== "--"));
const selected = input.rows.filter((row) => row.readyForReview && row.state && (!only.size || only.has(row.id)));
if (!selected.length) throw new Error("No review-ready scenarios selected.");

const qlooStats = { hits: 0, requests: 0 };
const deps = {
  llm: getLlm(),
  qloo: withCache(
    createQlooClient({ ...getQlooEnv(), timeoutMs: 20_000, maxRetries: 4, onEmpty: () => {} }),
    createMemoryCache(50_000),
    undefined,
    qlooStats,
  ),
  qlooStats,
};
const ARCHITECTURE = architectureFrom();
const RUN_VERSION = runVersionFor(ARCHITECTURE);
const suffix = process.env.SCENARIO_TAG ?? (ARCHITECTURE === "parallel" ? "parallel" : "");
const directory = `eval/out/scenario-runs${suffix ? `-${suffix}` : ""}`;
mkdirSync(directory, { recursive: true });
const summaryFile = `eval/out/scenario-summary${suffix ? `-${suffix}` : ""}.json`;
type SavedSummary = { id: string; [key: string]: unknown };
const previous = existsSync(summaryFile)
  ? (JSON.parse(readFileSync(summaryFile, "utf8")) as { summaries?: SavedSummary[] }).summaries ?? []
  : [];
const summaries = new Map(previous.map((summary) => [summary.id, summary]));

const labels = (state: RunState | null) =>
  Object.fromEntries((state?.plan?.components ?? []).map((component) => [component.slot, component.label]));

for (const row of selected) {
  process.stdout.write(`${row.id} … `);
  const started = Date.now();
  try {
    const state = await runCrashTest(deps, toLaunchBrief(row.state!), { runVersion: RUN_VERSION, architecture: ARCHITECTURE });
    writeFileSync(`${directory}/${row.id}.json`, JSON.stringify(state, null, 2));
    const first = state.evaluations[0];
    const last = state.evaluations.at(-1);
    const summary = {
      id: row.id,
      title: row.title,
      runVersion: RUN_VERSION,
      stopReason: state.stopReason,
      ms: Date.now() - started,
      initialSupported: first?.supported ?? null,
      finalSupported: last?.supported ?? null,
      initial: Object.fromEntries((state.initialPlan?.components ?? []).map((component) => [component.slot, component.label])),
      final: labels(state),
      accepted: state.changes.filter((change) => !change.reverted).map((change) => ({ slot: change.slot, before: change.before, after: change.after, reason: change.reason })),
      rejected: state.changes.filter((change) => change.reverted).map((change) => ({ slot: change.slot, before: change.before, after: change.after, outcome: change.retest?.rejectionCode })),
      unresolved: state.unresolvedQuestions,
      qlooChecks: state.qlooCallsUsed,
      modelCalls: state.llmCalls,
      error: state.stopReason === "error" ? state.stopDetail ?? "unknown error" : null,
      ...(state.parallel
        ? {
            // A parallel run changes plans through hybrids, re-tested as complete plans.
            accepted: state.parallel.rounds.flatMap((r) => r.attempts.filter((a) => a.accepted).map((a) => ({ slot: a.slot ?? null, after: a.candidateId, reason: a.reason }))),
            rejected: state.parallel.rounds.flatMap((r) =>
              r.attempts.filter((a) => !a.accepted && a.rejectionCode !== "duplicate").map((a) => ({ slot: a.slot ?? null, after: a.candidateId, outcome: a.rejectionCode })),
            ),
            winner: state.parallel.verdict.candidateId,
            winnerTrack: state.parallel.verdict.track,
            verdict: state.parallel.verdict.verdict,
            stable: state.parallel.verdict.stable,
            usage: state.parallel.usage,
          }
        : {}),
    };
    summaries.set(row.id, summary);
    console.log(
      `${summary.initialSupported}→${summary.finalSupported} supported; ${summary.accepted.length} accepted; ${summary.rejected.length} rejected; ${summary.unresolved.length} unresolved` +
        (state.parallel ? `; final ${state.parallel.verdict.track ?? "none"} (${state.parallel.verdict.verdict}${state.parallel.verdict.stable ? ", stable" : ""})` : ""),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summaries.set(row.id, { id: row.id, title: row.title, runVersion: RUN_VERSION, error: message, ms: Date.now() - started });
    console.log(`ERROR ${message}`);
  }
  const ordered = input.rows.flatMap((candidate) => (summaries.has(candidate.id) ? [summaries.get(candidate.id)] : []));
  writeFileSync(summaryFile, JSON.stringify({ ranAt: new Date().toISOString(), runVersion: RUN_VERSION, summaries: ordered }, null, 2));
}

console.log(`wrote ${summaryFile}`);
