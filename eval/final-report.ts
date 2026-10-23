/**
 * The complete 15-scenario evaluation report for a parallel:v3 run against the frozen parallel:v2 run.
 *
 *   npm run eval:final-report -- parallel-v3-final-r1 [--repeats parallel-v3-sentinel-r4,parallel-v3-sentinel-r5]
 *
 * Written before the run's results were seen, and reads only. It writes, under eval/out (git-ignored):
 *   final-report-<tag>.{json,md}                      every section and promotion gate
 *   final-human-review-<tag>.json / -key.json         a blinded v2/v3 sheet; never overwritten
 *
 * Comparability: both runs measured each plan against the same audience anchors (v3 used
 * FROZEN_ANCHORS from the v2 run) and the same plan rubric (crash-v1: supported choices). The
 * evidence-matrix states (supported/thin/conflicting/unverified) come from each run's own evidence
 * rubric (v2: evidence:v1, v3: evidence:v4), so they are shown side by side but are not comparable.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import { planFingerprint } from "../src/lib/crashtest/agent";
import { SLOTS, SLOT_LABEL, type CulturalPlan, type RunState, type Slot } from "../src/lib/crashtest/types";
import { getLlm } from "../src/lib/llm";
import { marketById } from "../src/lib/markets";
import { isFrozen } from "./frozen";
import { judgePlans } from "./judge";
import { SENTINEL_IDS } from "./sentinels";

const args = process.argv.slice(2).filter((a) => a !== "--");
const tag = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--repeats");
if (!tag) throw new Error("Usage: eval:final-report -- <v3 tag> [--repeats a,b]");
const repeatTags = (args[args.indexOf("--repeats") + 1] ?? "").split(",").filter((t) => args.includes("--repeats") && t);
const BASE = process.env.V2_TAG ?? "parallel-v2";
const OUT = "eval/out";
const out = `${OUT}/final-report-${tag}`;
const reviewFile = `${OUT}/final-human-review-${tag}.json`;
const keyFile = `${OUT}/final-human-review-${tag}-key.json`;
for (const f of [`${out}.json`, `${out}.md`, reviewFile, keyFile]) if (isFrozen(f)) throw new Error(`${f} is frozen`);
/** The hackathon key's monthly request quota, for expressing Qloo use as a share of it. */
const MONTHLY_QUOTA = 50_000;

type Summary = { id: string; title?: string; ms?: number };
const summaries = (t: string) => new Map(((JSON.parse(readFileSync(`${OUT}/scenario-summary-${t}.json`, "utf8")) as { summaries: Summary[] }).summaries ?? []).map((s) => [s.id, s]));
const load = (t: string, id: string) => (existsSync(`${OUT}/scenario-runs-${t}/${id}.json`) ? (JSON.parse(readFileSync(`${OUT}/scenario-runs-${t}/${id}.json`, "utf8")) as RunState) : null);
const intake = JSON.parse(readFileSync(`${OUT}/scenario-intake.json`, "utf8")) as { rows: { id: string; title: string; readyForReview?: boolean }[] };
const ids = intake.rows.filter((r) => r.readyForReview).map((r) => r.id);
const titles = new Map(intake.rows.map((r) => [r.id, r.title]));
const v3Sum = summaries(tag);
const v2Sum = summaries(BASE);

const labels = (p: CulturalPlan | null | undefined) => SLOTS.map((s) => p?.components.find((c) => c.slot === s)?.label ?? "—");
const cand = (s: RunState | null, id: string) => s?.parallel?.candidates.find((c) => c.candidateId === id) ?? null;
const states = (s: RunState | null) => {
  const id = s?.parallel?.verdict.candidateId;
  const st = id ? Object.values(s!.parallel!.matrix.componentStates[id] ?? {}) : [];
  return {
    supported: st.filter((x) => x === "supported").length,
    thin: st.filter((x) => x === "plausible_thin").length,
    conflicting: st.filter((x) => x === "conflicting").length,
    unverified: st.filter((x) => x === "unverified" || x === "needs_human").length,
  };
};

/** Final choices against the agent's own screens (screens:v4) and the shared evidence matrix's role and intent claims. */
function flags(s: RunState) {
  const p = s.parallel!;
  const F = p.verdict.candidateId ? cand(s, p.verdict.candidateId) : null;
  const pools = p.agent?.pools ?? [];
  const out: { slot: Slot; label: string; origin: string; inAgentPool: boolean; agentScreen: string | null; claims: string[] }[] = [];
  for (const c of F?.plan.components ?? []) {
    if (c.slot === "creative_direction") continue;
    const r = pools.find((x) => x.slot === c.slot && (c.entity ? x.entityId === c.entity.id : x.name === c.label));
    const claims = p.matrix.claims
      .filter((x) => x.candidateId === F!.candidateId && x.slot === c.slot && x.stance !== "supports" && ["R-role-check", "R-host-tier", "R-neighborhood", "R-distinct-requested", "R-avoided-quality", "R-product-central"].includes(x.ruleId ?? ""))
      .map((x) => `${x.ruleId} ${x.stance}: ${x.claim}`);
    out.push({
      slot: c.slot,
      label: c.label,
      origin: F!.sources[c.slot] ?? "unknown",
      inAgentPool: !!r,
      agentScreen: r && (r.screens.role === "fail" || r.screens.role === "doubtful" || r.screens.distinct === "flag" || r.screens.hood === "outside" || r.screens.hood === "far")
        ? [r.screens.role !== "pass" ? `role ${r.screens.role}` : "", r.screens.distinct === "flag" ? "mainstream default" : "", r.screens.hood === "outside" || r.screens.hood === "far" ? `neighbourhood ${r.screens.hood}` : "", ...r.screens.notes.filter((n) => /^(brand|host: (possible|unknown|unsuitable)|role check: (doubtful|wrong))/.test(n))].filter(Boolean).join("; ")
        : null,
      claims,
    });
  }
  return out;
}

const llm = getLlm();
/** NO_JUDGE=1 checks the report without model calls (a dry run of the tooling). */
const judge = process.env.NO_JUDGE ? async () => null : judgePlans;
const pref = (v: Awaited<ReturnType<typeof judgePlans>> | null, a: string, b: string) => (v ? { preferred: v.preferred === "agent" ? a : v.preferred === "draft" ? b : "tie", consistent: v.consistent, reason: v.reason } : null);

const rows = [];
for (const id of ids) {
  const v3 = load(tag, id);
  const v2 = load(BASE, id);
  if (!v2) throw new Error(`${BASE}/${id} is missing`);
  const brief = v2.brief;
  const market = marketById(brief.marketId)!;
  const p = v3?.parallel ?? null;
  const v = p?.verdict ?? null;
  const A = cand(v3, "agent");
  const L = cand(v3, "llm");
  const failed = !v3 || v3.stopReason === "error" || !p;
  // Blind, both orders: v3 final vs v2 final, and the v3 agent's plan vs its own plain-LLM plan.
  const vsV2 = v3?.plan && v2.plan ? pref(await judge(llm, brief, market, v3.plan, v2.plan).catch(() => null), "v3", "v2") : null;
  const agentSameAsLlm = !!A && !!L && planFingerprint(A.plan) === planFingerprint(L.plan);
  const agentVsLlm = A && L && !agentSameAsLlm ? pref(await judge(llm, brief, market, A.plan, L.plan).catch(() => null), "agent", "llm") : null;
  const repeats = SENTINEL_IDS.includes(id) ? repeatTags.map((t) => load(t, id)).filter((s): s is RunState => !!s?.plan) : [];
  rows.push({
    id,
    title: titles.get(id) ?? id,
    group: SENTINEL_IDS.includes(id) ? "sentinel" : "held-out",
    failed,
    error: failed ? (v3?.stopDetail ?? "no run") : null,
    v2: {
      final: labels(v2.plan),
      track: v2.parallel?.verdict.track ?? null,
      verdict: v2.parallel?.verdict.verdict ?? null,
      stable: v2.parallel?.verdict.stable ?? false,
      supported: v2.evaluations.at(-1)?.supported ?? 0,
      states: states(v2),
      requests: v2.qlooUsage?.requests ?? v2.qlooCallsUsed,
      cacheHits: v2.qlooUsage?.cacheHits ?? null,
      modelCalls: v2.llmCalls,
      ms: v2Sum.get(id)?.ms ?? null,
      anchors: v2.plan?.anchors.map((a) => a.id) ?? [],
    },
    v3: {
      final: labels(v3?.plan),
      track: v?.track ?? null,
      verdict: v?.verdict ?? null,
      stable: v?.stable ?? false,
      provisional: v?.provisional ?? false,
      abstained: !v3?.plan,
      supported: v3?.evaluations.at(-1)?.supported ?? 0,
      states: states(v3),
      violations: v?.evaluation?.hardConstraintViolations.length ?? 0,
      locks: (v?.userChoicesPreserved ?? []).filter((u) => u.locked),
      requests: v3?.qlooUsage?.requests ?? v3?.qlooCallsUsed ?? null,
      cacheHits: v3?.qlooUsage?.cacheHits ?? null,
      modelCalls: v3?.llmCalls ?? null,
      ms: v3Sum.get(id)?.ms ?? null,
      anchors: v3?.plan?.anchors.map((a) => a.id) ?? [],
      anchorsFrozenFrom: p?.config?.anchorsFrozenFrom ?? null,
      agent: { final: labels(A?.plan), supported: A?.evaluation?.supported ?? null, selection: p?.agent?.selection ?? null, stop: p?.agent?.stop ?? null },
      llm: { final: labels(L?.plan), supported: L?.evaluation?.supported ?? null },
      flags: v3?.parallel ? flags(v3) : [],
    },
    vsV2,
    agentVsLlm,
    agentSameAsLlm,
    stability: {
      sameAsV2: !!v3?.plan && !!v2.plan && planFingerprint(v3.plan) === planFingerprint(v2.plan),
      componentsSameAsV2: SLOTS.filter((s) => labels(v3?.plan)[SLOTS.indexOf(s)] === labels(v2.plan)[SLOTS.indexOf(s)] && labels(v2.plan)[SLOTS.indexOf(s)] !== "—").length,
      repeats: repeats.length
        ? {
            runs: repeats.length + 1,
            exactSame: v3?.plan ? repeats.filter((r) => planFingerprint(r.plan!) === planFingerprint(v3.plan!)).length : 0,
            componentAgreement: Object.fromEntries(
              SLOTS.filter((s) => s !== "creative_direction").map((s) => {
                const all = [v3?.plan, ...repeats.map((r) => r.plan)].map((pl) => pl?.components.find((c) => c.slot === s)?.label ?? "—");
                const top = Math.max(...[...new Set(all)].map((x) => all.filter((y) => y === x).length));
                return [s, `${top}/${all.length}`];
              }),
            ),
          }
        : null,
    },
  });
  console.log(`${id}: v3 ${v?.track ?? "none"} (${v?.verdict ?? "-"}), judge vs v2 ${vsV2?.preferred ?? "-"}, agent vs llm ${agentVsLlm?.preferred ?? "same plan/-"}`);
}

// ---------- totals and gates ----------
type R = (typeof rows)[number];
const sum = (xs: R[], f: (r: R) => number | null | undefined) => xs.reduce((s, r) => s + (f(r) ?? 0), 0);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};
const totalsFor = (xs: R[]) => ({
  scenarios: xs.length,
  failures: xs.filter((r) => r.failed).length,
  violations: sum(xs, (r) => r.v3.violations),
  locksPreserved: `${sum(xs, (r) => r.v3.locks.filter((l) => l.preserved).length)}/${sum(xs, (r) => r.v3.locks.length)}`,
  unsupportedZeroPlans: xs.filter((r) => !r.v3.abstained && r.v3.supported === 0).length,
  abstained: xs.filter((r) => r.v3.abstained).length,
  stable: xs.filter((r) => r.v3.stable).length,
  unstable: xs.filter((r) => r.v3.verdict === "unstable").length,
  provisional: xs.filter((r) => r.v3.provisional).length,
  supported: { v2: sum(xs, (r) => r.v2.supported), v3: sum(xs, (r) => r.v3.supported), of: xs.length * SLOTS.length },
  states: {
    v2: Object.fromEntries((["supported", "thin", "conflicting", "unverified"] as const).map((k) => [k, sum(xs, (r) => r.v2.states[k])])),
    v3: Object.fromEntries((["supported", "thin", "conflicting", "unverified"] as const).map((k) => [k, sum(xs, (r) => r.v3.states[k])])),
  },
  blindVsV2: { v3: xs.filter((r) => r.vsV2?.preferred === "v3").length, v2: xs.filter((r) => r.vsV2?.preferred === "v2").length, tie: xs.filter((r) => r.vsV2?.preferred === "tie").length, ordersDisagreed: xs.filter((r) => r.vsV2 && !r.vsV2.consistent).length, samePlan: xs.filter((r) => r.stability.sameAsV2).length },
  agentVsLlm: { agent: xs.filter((r) => r.agentVsLlm?.preferred === "agent").length, llm: xs.filter((r) => r.agentVsLlm?.preferred === "llm").length, tie: xs.filter((r) => r.agentVsLlm?.preferred === "tie").length, samePlan: xs.filter((r) => r.agentSameAsLlm).length, notJudged: xs.filter((r) => !r.agentSameAsLlm && !r.agentVsLlm).length, supported: { agent: sum(xs, (r) => r.v3.agent.supported), llm: sum(xs, (r) => r.v3.llm.supported) } },
  winners: Object.fromEntries(["user", "llm", "agent", "hybrid"].map((t) => [t, xs.filter((r) => r.v3.track === t).length])),
  flags: {
    finalChoices: sum(xs, (r) => r.v3.flags.length),
    outsideAgentPool: sum(xs, (r) => r.v3.flags.filter((f) => !f.inAgentPool).length),
    agentScreenFlags: sum(xs, (r) => r.v3.flags.filter((f) => f.agentScreen).length),
    matrixRoleOrIntentClaims: sum(xs, (r) => r.v3.flags.filter((f) => f.claims.length).length),
    agentPlanSelectionFlags: sum(xs, (r) => r.v3.agent.selection?.notes.length ?? 0),
    agentPlanGeneric: xs.filter((r) => r.v3.agent.selection?.guard).length,
  },
  cost: {
    requests: { v2: sum(xs, (r) => r.v2.requests), v3: sum(xs, (r) => r.v3.requests) },
    cacheHits: { v2: sum(xs, (r) => r.v2.cacheHits), v3: sum(xs, (r) => r.v3.cacheHits) },
    modelCalls: { v2: sum(xs, (r) => r.v2.modelCalls), v3: sum(xs, (r) => r.v3.modelCalls) },
    meanSeconds: { v2: Math.round(sum(xs, (r) => r.v2.ms) / xs.length / 100) / 10, v3: Math.round(sum(xs, (r) => r.v3.ms) / xs.length / 100) / 10 },
    medianSeconds: { v2: Math.round(median(xs.map((r) => (r.v2.ms ?? 0) / 1000)) * 10) / 10, v3: Math.round(median(xs.map((r) => (r.v3.ms ?? 0) / 1000)) * 10) / 10 },
  },
  stability: {
    exactSameAsV2: xs.filter((r) => r.stability.sameAsV2).length,
    componentsSameAsV2: `${sum(xs, (r) => r.stability.componentsSameAsV2)}/${xs.length * SLOTS.length}`,
    anchorsMatchV2: xs.filter((r) => r.v3.anchors.join() === r.v2.anchors.join()).length,
  },
});
const all = totalsFor(rows);
const gates = [
  { gate: "0 failed runs", pass: all.failures === 0, value: `${all.failures}` },
  { gate: "0 hard-constraint violations", pass: all.violations === 0, value: `${all.violations}` },
  { gate: "explicit locks preserved", pass: all.locksPreserved.split("/")[0] === all.locksPreserved.split("/")[1], value: all.locksPreserved },
  { gate: "no unsupported zero-result plan (unless abstained)", pass: all.unsupportedZeroPlans === 0, value: `${all.unsupportedZeroPlans}` },
  { gate: "at least 14/15 stable verdicts", pass: all.stable >= 14, value: `${all.stable}/15` },
  { gate: "at least 45/60 supported choices (same anchors, crash-v1 rubric)", pass: all.supported.v3 >= 45, value: `${all.supported.v3}/60 (v2 ${all.supported.v2}/60)` },
  { gate: "more blind v3 wins than losses", pass: all.blindVsV2.v3 > all.blindVsV2.v2, value: `v3 ${all.blindVsV2.v3}, v2 ${all.blindVsV2.v2}, tie ${all.blindVsV2.tie}` },
  { gate: "human review", pass: false, value: "not done (sheet generated)" },
];
const report = {
  generatedAt: new Date().toISOString(),
  tag,
  base: BASE,
  repeats: repeatTags,
  judgeModel: llm.model,
  comparability: "Same audience anchors (v3 froze v2's) and the same crash-v1 plan rubric for supported counts. Evidence-matrix states use each run's own evidence rubric (v2 evidence:v1, v3 evidence:v4) and are not comparable.",
  cost: { qlooQuotaShare: `${((all.cost.requests.v3 / MONTHLY_QUOTA) * 100).toFixed(1)}% of the ${MONTHLY_QUOTA.toLocaleString()}-request monthly quota`, model: "Model calls are counted; token usage and a per-call price aren't recorded, so no money cost is estimated." },
  totals: { all, sentinels: totalsFor(rows.filter((r) => r.group === "sentinel")), heldOut: totalsFor(rows.filter((r) => r.group === "held-out")) },
  gates,
  rows,
};
writeFileSync(`${out}.json`, JSON.stringify(report, null, 2));

// ---------- blinded human review: created once, never overwritten ----------
if (!existsSync(reviewFile) && !existsSync(keyFile)) {
  const key: Record<string, { X: string; Y: string }> = {};
  const sheet = rows.map((r) => {
    const v3First = randomInt(2) === 0;
    key[r.id] = v3First ? { X: "v3", Y: "v2" } : { X: "v2", Y: "v3" };
    const [x, y] = v3First ? [r.v3.final, r.v2.final] : [r.v2.final, r.v3.final];
    const plan = (l: string[]) => Object.fromEntries(SLOTS.map((s, i) => [SLOT_LABEL[s], l[i]]));
    return { id: r.id, title: r.title, X: plan(x), Y: plan(y), preferred: null as "X" | "Y" | "tie" | null, reason: null as string | null, reviewer: null as string | null };
  });
  writeFileSync(reviewFile, JSON.stringify({ instructions: "Read each brief in eval/scenario-cases.ts. For each scenario set preferred to X, Y or tie, with a one-sentence reason and your name. Don't open the key file until every row is done.", rows: sheet }, null, 2));
  writeFileSync(keyFile, JSON.stringify(key, null, 2));
}

// ---------- Markdown ----------
const t = (x: ReturnType<typeof totalsFor>, name: string) => [
  `| ${name} | ${x.supported.v2}/${x.supported.of} → ${x.supported.v3}/${x.supported.of} | ${x.stable}/${x.scenarios} | v3 ${x.blindVsV2.v3} · v2 ${x.blindVsV2.v2} · tie ${x.blindVsV2.tie} | agent ${x.agentVsLlm.agent} · LLM ${x.agentVsLlm.llm} · tie ${x.agentVsLlm.tie} | ${x.failures} / ${x.violations} / ${x.unstable} / ${x.abstained} | ${x.cost.requests.v2} → ${x.cost.requests.v3} | ${x.cost.meanSeconds.v2}s → ${x.cost.meanSeconds.v3}s |`,
];
const md = [
  `# Final evaluation: ${tag} (code ${"parallel-v3-final-r1-code"}) vs ${BASE}`,
  "",
  report.comparability,
  "",
  "## Promotion gates",
  "",
  "| Gate | Result | Value |",
  "|---|---|---|",
  ...gates.map((g) => `| ${g.gate} | ${g.pass ? "pass" : "**fail**"} | ${g.value} |`),
  "",
  "## Totals",
  "",
  "| Set | Supported v2 → v3 | Stable v3 | Blind v3 vs v2 | Blind agent vs own LLM | Failed / violations / unstable / abstained | Qloo requests v2 → v3 | Mean runtime v2 → v3 |",
  "|---|---|---|---|---|---|---|---|",
  ...t(all, "All 15"),
  ...t(report.totals.sentinels, "5 sentinels"),
  ...t(report.totals.heldOut, "10 held-out"),
  "",
  `Final plans came from: ${Object.entries(all.winners).map(([k, n]) => `${k} ${n}`).join(", ")}. Provisional (unstable) results: ${all.provisional}. Locks preserved: ${all.locksPreserved}. Unsupported zero-result plans: ${all.unsupportedZeroPlans}.`,
  "",
  `Evidence-matrix states of the final plans (own rubric; not comparable across versions): v2 ${JSON.stringify(all.states.v2)}; v3 ${JSON.stringify(all.states.v3)}.`,
  "",
  `Role and intent: of ${all.flags.finalChoices} final entity choices, ${all.flags.outsideAgentPool} came from outside the agent's pool; ${all.flags.agentScreenFlags} carry an agent-screen flag; ${all.flags.matrixRoleOrIntentClaims} carry a non-supporting role or intent claim in the shared evidence matrix. The agent's own plans carry ${all.flags.agentPlanSelectionFlags} selection flags; ${all.flags.agentPlanGeneric} were generic bundles.`,
  "",
  `Cost: Qloo requests ${all.cost.requests.v2} → ${all.cost.requests.v3} (${report.cost.qlooQuotaShare}); cache hits ${all.cost.cacheHits.v2} → ${all.cost.cacheHits.v3}; model calls ${all.cost.modelCalls.v2} → ${all.cost.modelCalls.v3}; median runtime ${all.cost.medianSeconds.v2}s → ${all.cost.medianSeconds.v3}s. ${report.cost.model}`,
  "",
  `Stability: exact same final plan as v2 in ${all.stability.exactSameAsV2}/15; components the same as v2 ${all.stability.componentsSameAsV2}; anchors identical to v2 in ${all.stability.anchorsMatchV2}/15.${repeatTags.length ? ` Sentinel repeats (${[tag, ...repeatTags].join(", ")}, same selection code and anchors): see per-scenario rows.` : ""}`,
  "",
  "## Per scenario",
  "",
  "| Scenario | Set | v2 final (act · brand · venue · direction) | v3 final | v3 source · verdict | Supported v2 → v3 | Blind vs v2 | Agent vs LLM | Repeat stability |",
  "|---|---|---|---|---|---|---|---|---|",
  ...rows.map(
    (r) =>
      `| ${r.title} | ${r.group} | ${r.v2.final.join(" · ")} | ${r.v3.final.join(" · ")} | ${r.v3.track ?? "none"} · ${r.v3.verdict ?? "-"}${r.v3.provisional ? " (provisional)" : ""} | ${r.v2.supported} → ${r.v3.supported} | ${r.vsV2 ? `${r.vsV2.preferred}${r.vsV2.consistent ? "" : " (orders disagreed)"}` : "-"} | ${r.agentVsLlm ? `${r.agentVsLlm.preferred}${r.agentVsLlm.consistent ? "" : " (orders disagreed)"}` : r.agentSameAsLlm ? "same plan" : "not judged"} | ${r.stability.repeats ? `exact ${r.stability.repeats.exactSame + 1}/${r.stability.repeats.runs}; ${Object.entries(r.stability.repeats.componentAgreement).map(([s, v]) => `${SLOT_LABEL[s as Slot].split(" ").at(-1)} ${v}`).join(", ")}` : "-"} |`,
  ),
  "",
  "## Flags and reasons",
  ...rows.flatMap((r) => [
    "",
    `### ${r.title}`,
    `- Judge vs v2: ${r.vsV2?.reason ?? "-"}`,
    `- Judge agent vs LLM: ${r.agentVsLlm?.reason ?? (r.agentSameAsLlm ? "same plan" : "not judged")}`,
    ...r.v3.flags.filter((f) => !f.inAgentPool || f.agentScreen || f.claims.length).map((f) => `- ${SLOT_LABEL[f.slot]} "${f.label}" (from ${f.origin}${f.inAgentPool ? "" : ", outside the agent's pool"})${f.agentScreen ? ` · agent screen: ${f.agentScreen}` : ""}${f.claims.length ? ` · ${f.claims.join(" | ")}` : ""}`),
    ...(r.v3.agent.selection?.notes ?? []).map((n) => `- Agent plan flag: ${SLOT_LABEL[n.slot]} "${n.label}": ${n.why}`),
    ...(r.error ? [`- Run error: ${r.error}`] : []),
  ]),
  "",
  `Blinded human-review sheet: ${reviewFile} (key in ${keyFile}, kept separate). The blind judge is the same model family as the drafting model, so self-preference bias may remain; it is not a human review.`,
].join("\n");
writeFileSync(`${out}.md`, md + "\n");
console.log(`wrote ${out}.{json,md}, ${reviewFile}`);
for (const g of gates) console.log(`${g.pass ? "PASS" : "FAIL"} ${g.gate}: ${g.value}`);
