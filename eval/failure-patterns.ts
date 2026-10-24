/**
 * Find the smallest representative set of failed scenarios from an existing run. This command is
 * read-only and makes no model or Qloo calls.
 *
 *   npm run eval:failures -- parallel-v5-sentinel-r2
 */
import { existsSync, readFileSync } from "node:fs";
import { failurePatterns, selectPatternRepresentatives, type PatternCase, type ScenarioStateLike, type ScenarioSummaryLike } from "./failure-patterns-lib";

const tag = process.argv.slice(2).find((x) => x !== "--");
if (!tag) throw new Error("Usage: npm run eval:failures -- <scenario tag>");
const summaryPath = `eval/out/scenario-summary-${tag}.json`;
const runDirectory = `eval/out/scenario-runs-${tag}`;
if (!existsSync(summaryPath)) throw new Error(`Missing ${summaryPath}`);

const summaries = (JSON.parse(readFileSync(summaryPath, "utf8")) as { summaries?: ScenarioSummaryLike[] }).summaries ?? [];
const cases: PatternCase[] = summaries.map((summary) => {
  const statePath = `${runDirectory}/${summary.id}.json`;
  const state = existsSync(statePath)
    ? (JSON.parse(readFileSync(statePath, "utf8")) as ScenarioStateLike)
    : undefined;
  return { id: summary.id, patterns: failurePatterns(summary, state) };
});
const failed = cases.filter((c) => c.patterns.length);
const selected = selectPatternRepresentatives(failed);
const covered = [...new Set(selected.flatMap((c) => c.patterns))];

console.log(`Run: ${tag}`);
console.log(`Scenarios: ${summaries.length}; observed failures: ${failed.length}; representative reruns: ${selected.length}`);
for (const c of failed) console.log(`- ${c.id}: ${c.patterns.join(", ")}`);
console.log("\nSmallest useful rerun set:");
for (const c of selected) console.log(`- ${c.id}: ${c.patterns.join(", ")}`);
console.log(`\nCovered patterns: ${covered.join(", ") || "none"}`);
if (selected.length)
  console.log(`\nRun only these after a relevant code change:\n  npm run scenario:run -- ${selected.map((c) => c.id).join(" ")}`);

