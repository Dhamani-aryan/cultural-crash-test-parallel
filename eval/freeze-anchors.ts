/**
 * Freeze the audience anchors a recorded scenario run measured against, so later runs can be
 * measured against exactly the same audience (FROZEN_ANCHORS=<file> npm run scenario:run).
 *
 *   npm run eval:freeze-anchors -- parallel-v2
 *
 * Reads eval/out/scenario-runs-<tag>/*.json (read-only) and writes eval/out/anchors-<tag>.json
 * (git-ignored: Qloo entity IDs). An existing anchors file is never rewritten.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { EntityRef, RunState } from "../src/lib/crashtest/types";

const tag = process.argv.slice(2).find((a) => a !== "--");
if (!tag) throw new Error("Usage: eval:freeze-anchors -- <scenario tag>");
const dir = `eval/out/scenario-runs-${tag}`;
const out = `eval/out/anchors-${tag}.json`;
if (existsSync(out)) throw new Error(`${out} exists; frozen anchors are never rewritten.`);
const scenarios: Record<string, { anchors: EntityRef[]; source: "user" | "model_hypothesis" }> = {};
let runVersion: string | undefined;
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
  const s = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as RunState;
  const anchors = s.plan?.anchors ?? s.parallel?.candidates[0]?.plan.anchors ?? [];
  const source = s.parallel?.anchorSource;
  if (!anchors.length || (source !== "user" && source !== "model_hypothesis")) {
    console.log(`skip ${f}: no recorded anchors`);
    continue;
  }
  runVersion ??= s.provenance?.runVersion;
  scenarios[f.replace(/\.json$/, "")] = { anchors, source };
}
writeFileSync(out, JSON.stringify({ from: `${tag} (${runVersion ?? "unknown version"})`, frozenAt: new Date().toISOString(), scenarios }, null, 2) + "\n");
console.log(`wrote ${out}: ${Object.keys(scenarios).length} scenarios`);
