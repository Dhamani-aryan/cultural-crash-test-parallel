/**
 * Blind, order-rotated comparison of parallel:v3 sentinel runs against the frozen parallel:v2 runs.
 *
 *   npm run eval:sentinel-compare -- parallel-v3-sentinel-r4 parallel-v3-sentinel-r5
 *
 * For every sentinel and every v3 run, the blind judge (eval/judge.ts) compares the v3 final plan
 * with the v2 final plan twice, with the order swapped; a preference counts only when both orders
 * agree. Plans are shown as "Plan A"/"Plan B" with no version or track. It also reports external
 * Qloo requests and latency against v2, whether the v3 repeats chose the same plan, and any final
 * choice the agent's own role screens flag. Reads only; writes eval/out/sentinel-comparison-*.{json,md}.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { planFingerprint } from "../src/lib/crashtest/agent";
import type { RunState, Slot } from "../src/lib/crashtest/types";
import { SLOT_LABEL } from "../src/lib/crashtest/types";
import { getLlm } from "../src/lib/llm";
import { marketById } from "../src/lib/markets";
import { isFrozen } from "./frozen";
import { judgePlans } from "./judge";
import { SENTINEL_IDS } from "./sentinels";

const SENTINELS = SENTINEL_IDS;
const BASE = process.env.V2_TAG ?? "parallel-v2";
const tags = process.argv.slice(2).filter((a) => a !== "--");
if (!tags.length) throw new Error("Usage: eval:sentinel-compare -- <v3 tag> [<v3 tag> …]");
const out = `eval/out/sentinel-comparison-${tags.join("+")}`;
if (isFrozen(`${out}.json`)) throw new Error(`${out} is frozen`);

type Summary = { id: string; ms?: number; qlooRequests?: number | null };
const load = (tag: string, id: string) => {
  const f = `eval/out/scenario-runs-${tag}/${id}.json`;
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as RunState) : null;
};
const summaries = (tag: string) =>
  new Map(((JSON.parse(readFileSync(`eval/out/scenario-summary-${tag}.json`, "utf8")) as { summaries: Summary[] }).summaries ?? []).map((s) => [s.id, s]));
const requests = (s: RunState | null) => s?.qlooUsage?.requests ?? s?.qlooCallsUsed ?? null;
const labels = (s: RunState | null) => (s?.plan?.components ?? []).filter((c) => c.slot !== "creative_direction").map((c) => c.label);

/** Final choices the agent's own screens flag: wrong or doubtful roles (screens:v4). */
function roleFlags(s: RunState): string[] {
  const pools = s.parallel?.agent?.pools ?? [];
  return (s.plan?.components ?? []).flatMap((c) => {
    if (c.slot === "creative_direction" || c.locked) return [];
    const r = pools.find((p) => p.slot === c.slot && (c.entity ? p.entityId === c.entity.id : p.name === c.label));
    if (!r) return [`${SLOT_LABEL[c.slot as Slot]} "${c.label}": not screened by the agent (from another track)`];
    return r.screens.role === "fail" || r.screens.role === "doubtful" ? [`${SLOT_LABEL[c.slot as Slot]} "${c.label}": ${r.screens.role} (${r.screens.notes.filter((n) => /^(brand|host|role check)/.test(n)).join("; ")})`] : [];
  });
}

const llm = getLlm();
const base = summaries(BASE);
const runs = tags.map((t) => ({ tag: t, sum: summaries(t) }));
interface RunRow {
  tag: string;
  final: string[];
  track: string | null;
  stable: boolean;
  provisional: boolean;
  fingerprint: string | null;
  supported: number | null;
  requests: number | null;
  ms: number | null;
  anchorsFrozenFrom: string | null;
  roleFlags: string[];
  judge: { preferred: "v3" | "v2" | "tie"; consistent: boolean; reason: string; v3: unknown; v2: unknown } | null;
}
interface Row {
  id: string;
  v2: { final: string[]; supported: number | null; requests: number | null; ms: number | null };
  runs: RunRow[];
  repeatsAgree: boolean;
}
const rows: Row[] = [];
for (const id of SENTINELS) {
  const v2 = load(BASE, id);
  if (!v2?.plan) throw new Error(`${BASE}/${id} has no final plan`);
  const market = marketById(v2.brief.marketId)!;
  const per: RunRow[] = [];
  for (const r of runs) {
    const v3 = load(r.tag, id);
    if (!v3) throw new Error(`${r.tag}/${id} is missing`);
    // The v3 brief is the same frozen intake; judge against the v2 brief text to be exact.
    const verdict = v3.plan ? await judgePlans(llm, v2.brief, market, v3.plan, v2.plan) : null;
    per.push({
      tag: r.tag,
      final: labels(v3),
      track: v3.parallel?.verdict.track ?? null,
      stable: v3.parallel?.verdict.stable ?? false,
      provisional: v3.parallel?.verdict.provisional ?? false,
      fingerprint: v3.plan ? planFingerprint(v3.plan) : null,
      supported: v3.evaluations.at(-1)?.supported ?? null,
      requests: requests(v3),
      ms: r.sum.get(id)?.ms ?? null,
      anchorsFrozenFrom: v3.parallel?.config?.anchorsFrozenFrom ?? null,
      roleFlags: roleFlags(v3),
      judge: verdict ? { preferred: verdict.preferred === "agent" ? "v3" : verdict.preferred === "draft" ? "v2" : "tie", consistent: verdict.consistent, reason: verdict.reason, v3: verdict.agent, v2: verdict.draft } : null,
    });
  }
  const prints = new Set(per.map((p) => p.fingerprint));
  rows.push({
    id,
    v2: { final: labels(v2), supported: v2.evaluations.at(-1)?.supported ?? null, requests: requests(v2), ms: base.get(id)?.ms ?? null },
    runs: per,
    repeatsAgree: prints.size === 1,
  });
  console.log(`${id}: ${per.map((p) => `${p.tag} ${p.judge?.preferred ?? "-"}${p.judge && !p.judge.consistent ? " (orders disagreed)" : ""}`).join("; ")}${prints.size === 1 ? "" : "; v3 repeats differ"}`);
}

const all = rows.flatMap((r) => r.runs);
const count = (k: string) => all.filter((p) => p.judge?.preferred === k).length;
const sum = (xs: (number | null | undefined)[]) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);
const totals = {
  comparisons: all.length,
  v3Wins: count("v3"),
  v2Wins: count("v2"),
  ties: count("tie"),
  orderDisagreements: all.filter((p) => p.judge && !p.judge.consistent).length,
  repeatDisagreements: rows.filter((r) => !r.repeatsAgree).length,
  roleFlags: all.reduce((s, p) => s + p.roleFlags.filter((f) => !f.includes("not screened")).length, 0),
  unscreenedFinalChoices: all.reduce((s, p) => s + p.roleFlags.filter((f) => f.includes("not screened")).length, 0),
  stable: all.filter((p) => p.stable).length,
  supported: { v2: sum(rows.map((r) => r.v2.supported)), v3PerRun: runs.map((r) => sum(rows.map((x) => x.runs.find((p) => p.tag === r.tag)!.supported))) },
  requests: { v2: sum(rows.map((r) => r.v2.requests)), v3PerRun: runs.map((r) => sum(rows.map((x) => x.runs.find((p) => p.tag === r.tag)!.requests))) },
  meanSeconds: {
    v2: Math.round(sum(rows.map((r) => r.v2.ms)) / rows.length / 100) / 10,
    v3PerRun: runs.map((r) => Math.round(sum(rows.map((x) => x.runs.find((p) => p.tag === r.tag)!.ms)) / rows.length / 100) / 10),
  },
};
writeFileSync(`${out}.json`, JSON.stringify({ comparedAt: new Date().toISOString(), base: BASE, tags, model: llm.model, totals, rows }, null, 2));

const md = [
  `# Sentinel comparison: ${tags.join(", ")} vs ${BASE}`,
  "",
  `Blind judge (${llm.model}), each pair judged in both orders; a preference counts only when both orders agree. The judge sees "Plan A"/"Plan B" only.`,
  "",
  `**v3 wins ${totals.v3Wins}, v2 wins ${totals.v2Wins}, ties ${totals.ties}** of ${totals.comparisons} (orders disagreed: ${totals.orderDisagreements}). v3 repeats chose different plans in ${totals.repeatDisagreements} of ${rows.length} sentinels.`,
  "",
  `Supported final choices: v2 ${totals.supported.v2}/20; v3 ${totals.supported.v3PerRun.map((n) => `${n}/20`).join(", ")}. Stable v3 verdicts: ${totals.stable} of ${all.length}. Role flags on v3 final choices: ${totals.roleFlags} (plus ${totals.unscreenedFinalChoices} final choices taken from another track, not screened by the agent).`,
  "",
  `External Qloo requests: v2 ${totals.requests.v2}; v3 ${totals.requests.v3PerRun.join(", ")}. Mean runtime: v2 ${totals.meanSeconds.v2}s; v3 ${totals.meanSeconds.v3PerRun.map((s) => `${s}s`).join(", ")}.`,
  "",
  "| Sentinel | v2 final | " + runs.map((r) => `${r.tag} final · judge`).join(" | ") + " |",
  "|---|---|" + runs.map(() => "---").join("|") + "|",
  ...rows.map((r) => `| ${r.id} | ${r.v2.final.join(" · ")} | ${r.runs.map((p) => `${p.final.join(" · ")} · **${p.judge?.preferred ?? "-"}**${p.judge && !p.judge.consistent ? " (orders disagreed)" : ""}`).join(" | ")} |`),
  "",
  "## Judge reasons and flags",
  ...rows.flatMap((r) => ["", `### ${r.id}`, ...r.runs.map((p) => `- ${p.tag}: ${p.judge?.reason ?? "no plan"}${p.roleFlags.length ? ` Flags: ${p.roleFlags.join("; ")}.` : ""}`)]),
  "",
  "The judge is the same model family as the drafting model, so self-preference bias may remain; this is not a human review.",
].join("\n");
writeFileSync(`${out}.md`, md + "\n");
console.log(`wrote ${out}.{json,md}`);
console.log(JSON.stringify(totals, null, 1));
