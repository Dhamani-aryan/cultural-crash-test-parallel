/**
 * Compare two evaluation runs (A = current agent, B = experiment) and apply the merge gates.
 *
 *   EVAL_A=frozen-b1-v1 EVAL_B=frozen-b1-v2 npm run eval:compare
 *
 * B's plausibility run is eval/out/plausibility-<PLAUSIBILITY_B>.json, by default the tag
 * eval:plausibility writes for B's ranking.
 *
 * Prints the side-by-side exact counts, each gate, and every reason the comparison can't support
 * a merge. "B may be merged" needs a valid comparison (same frozen baseline, same cases, all
 * scored, same agent version and models) and every required gate exactly passed — including the
 * human plausibility gate, which stays undecided until B's plausibility run is fully valid and a
 * person has reviewed and graded every case (see checkPlausibility in eval/plausibility.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import { baselinePath, loadBaseline } from "./baseline";
import { CASES } from "./cases";
import { checkPlausibility, PLAUSIBILITY, type PlausibilityFile } from "./plausibility";
import { comparisonBlockers, decide, gates, summarize, summaryRows, type RunFile } from "./summary";

const load = (tag: string) => JSON.parse(readFileSync(`eval/out/results-${tag}.json`, "utf8")) as RunFile;
const A_TAG = process.env.EVAL_A;
const B_TAG = process.env.EVAL_B;
if (!A_TAG || !B_TAG) throw new Error("Set EVAL_A and EVAL_B to two result tags.");
const a = load(A_TAG);
const b = load(B_TAG);

const plausFile = `eval/out/plausibility-${process.env.PLAUSIBILITY_B ?? b.ranking ?? "v1"}.json`;
const plaus = existsSync(plausFile) ? checkPlausibility(JSON.parse(readFileSync(plausFile, "utf8")) as PlausibilityFile, PLAUSIBILITY, b) : null;

const baseline = a.frozen && existsSync(baselinePath(a.frozen)) ? loadBaseline(a.frozen) : null;
const blockers = comparisonBlockers(a, b, {
  expectedCaseIds: CASES.map((c) => c.id),
  baseline: baseline ? { id: baseline.id, caseIds: baseline.cases.map((c) => c.id) } : null,
});

const sa = summarize(a.cases);
const sb = summarize(b.cases);
console.log(`| Measure | A: ${A_TAG} (${a.ranking ?? "v1"}) | B: ${B_TAG} (${b.ranking ?? "v1"}) |`);
console.log("|---|---|---|");
const ra = summaryRows(sa);
const rb = summaryRows(sb);
ra.forEach(([k, v], i) => console.log(`| ${k} | ${v} | ${rb[i][1]} |`));
console.log("");
const gs = gates(sa, sb, plaus?.tally ?? null);
const human = gs.find((g) => g.name.startsWith("No reviewed plausibility"))!;
console.log("Required gates:");
for (const g of gs.filter((g) => g !== human)) console.log(`- ${g.pass === null ? "UNDECIDED" : g.pass ? "PASS" : "FAIL"} ${g.name}: ${g.detail}`);
console.log("");
console.log("Human plausibility gate (required; graded by a person, never by a model):");
console.log(`- ${human.pass === null ? "NOT ACTIVE" : human.pass ? "PASS" : "FAIL"} ${human.name}: ${human.detail}`);
console.log(`  B's plausibility run: ${plaus ? plausFile : `none (${plausFile} doesn't exist)`}`);
for (const p of plaus?.problems ?? []) console.log(`  - ${p}`);
console.log("");
console.log(blockers.length ? "Comparison validity: INVALID for merging" : "Comparison validity: valid");
for (const r of blockers) console.log(`- ${r}`);
console.log("");
console.log(decide(gs, [...blockers, ...(plaus?.problems ?? [])]).text);
