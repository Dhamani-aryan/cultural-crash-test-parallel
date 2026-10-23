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
 *
 * FROZEN_ANCHORS=<file> (see eval/freeze-anchors.ts) measures each scenario against the audience
 * anchors frozen there instead of asking the model again, so repeats are comparable.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { runCrashTest } from "../src/lib/crashtest/run";
import { architectureFrom, runVersionFor } from "../src/lib/crashtest/version";
import { isFrozen } from "./frozen";
import { existingVersions, outputRefusal } from "./output-guard";
import type { EntityRef, RunState } from "../src/lib/crashtest/types";
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
const frozenAnchors = process.env.FROZEN_ANCHORS
  ? (JSON.parse(readFileSync(process.env.FROZEN_ANCHORS, "utf8")) as { from: string; scenarios: Record<string, { anchors: EntityRef[]; source: "user" | "model_hypothesis" }> })
  : null;
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
const summaryFile = `eval/out/scenario-summary${suffix ? `-${suffix}` : ""}.json`;
// A frozen baseline is never written to, and one directory never mixes agent versions.
const refusal = outputRefusal({ directory, summaryFile, runVersion: RUN_VERSION, frozen: isFrozen, existing: existingVersions(directory) });
if (refusal) throw new Error(refusal);
mkdirSync(directory, { recursive: true });
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
    const frozen = frozenAnchors?.scenarios[row.id];
    if (frozenAnchors && !frozen) throw new Error(`${process.env.FROZEN_ANCHORS} has no anchors for ${row.id}`);
    const state = await runCrashTest(deps, toLaunchBrief(row.state!), {
      runVersion: RUN_VERSION,
      architecture: ARCHITECTURE,
      anchors: frozen ? { ...frozen, from: frozenAnchors!.from } : undefined,
    });
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
            provisional: state.parallel.verdict.provisional,
            usage: state.parallel.usage,
            qlooRequests: state.qlooUsage?.requests ?? null,
            cacheHits: state.qlooUsage?.cacheHits ?? null,
            ...(state.parallel.agent
              ? {
                  agent: {
                    stop: state.parallel.agent.stop,
                    bundlesTested: state.parallel.agent.bundlesTested,
                    challengesAccepted: state.parallel.agent.rounds.filter((r) => r.accepted).length,
                    challengesRejected: state.parallel.agent.rounds.flatMap((r) => r.attempts.filter((a) => !a.accepted).map((a) => a.rejectionCode)),
                  },
                  config: state.parallel.config,
                }
              : {}),
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
