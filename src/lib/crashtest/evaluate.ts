import { nameKey } from "@/lib/engine/stats";
import type { ComponentEvidence, ListHit } from "./gather";
import {
  RUBRIC_VERSION,
  WEIGHTS,
  type ComponentAssessment,
  type ComponentStatus,
  type Constraint,
  type CulturalPlan,
  type DimensionScore,
  type PlanEvaluation,
  type RejectionCode,
  type RetestResult,
  type Slot,
} from "./types";

/**
 * Rubric crash-v1. Deterministic: the same evidence always gives the same scores. Every
 * number is the app's own measure built from Qloo results, not a Qloo score and never a
 * probability. A dimension without evidence stays undefined and weights renormalise over the
 * rest; coverage is reported separately so a thin score can't pass for a solid one.
 */

/** A component must clear these to count as supported. */
export const SUPPORTED = { total: 0.6, audience: 0.6, local: 0.6 } as const;
/** A plan-level change smaller than this is not an improvement. */
export const MATERIAL_DELTA = 0.03;
const OUTSIDE_TOP = 0.25;

/** In the top list: 0.6–1.0 by rank. Returned but outside it: 0.25. Not returned: no evidence. */
export function hitScore(h: ListHit): number | undefined {
  if (h.inList && h.rank) return 0.6 + 0.4 * (1 - (h.rank - 1) / Math.max(h.listSize, 1));
  if (h.returned) return OUTSIDE_TOP;
  return undefined;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);
const fmt = (x: number | undefined) => (x === undefined ? "" : x.toFixed(3));

function topDriver(h: ListHit, names: Map<string, string>): string {
  const ex = Object.entries(h.explainability ?? {}).sort((a, b) => b[1] - a[1])[0];
  return ex && names.has(ex[0])
    ? `; strongest link: ${names.get(ex[0])} (${ex[1].toFixed(2)})`
    : "";
}

function listDimension(
  key: "audience" | "coherence",
  hits: ListHit[] | null,
  ctx: { what: string; city: string; tags: string[] | null; names: Map<string, string> },
): DimensionScore {
  const weight = WEIGHTS[key];
  const scope = key === "audience" ? "this audience" : "the rest of the plan";
  const whose = key === "audience" ? "this audience's" : "the rest of the plan's";
  if (!hits || hits.length === 0) {
    return {
      key,
      weight,
      evidenceIds: [],
      explanation:
        key === "audience"
          ? "Not measured: the plan has no resolved audience anchors."
          : "Not measured: no other resolved choices to test it against.",
    };
  }
  const scores = hits.map(hitScore);
  const defined = scores.filter((s): s is number => s !== undefined);
  const ids = [...new Set(hits.map((h) => h.evidenceId))];
  if (!defined.length) {
    return {
      key,
      weight,
      evidenceIds: ids,
      explanation: `Qloo returned no affinity for ${ctx.what} among ${scope} in ${ctx.city}.`,
    };
  }
  let explanation: string;
  if (ctx.tags) {
    const parts = hits.map((h, i) =>
      h.inList ? `"${ctx.tags![i]}" #${h.rank}` : `"${ctx.tags![i]}" not in the top ${h.listSize}`,
    );
    explanation = `Among ${whose} top aesthetics and tones in ${ctx.city}: ${parts.join(", ")}.`;
  } else {
    const h = hits[0];
    explanation = h.inList
      ? `#${h.rank} of ${h.listSize} for ${scope} in ${ctx.city} (affinity ${fmt(h.affinity)})${topDriver(h, ctx.names)}.`
      : `Outside ${whose} top ${h.listSize} in ${ctx.city}` +
        (h.affinity !== undefined ? ` (affinity ${fmt(h.affinity)} when scored alone).` : ".");
  }
  return { key, score: mean(defined), weight, evidenceIds: ids, explanation };
}

function localDimension(ev: ComponentEvidence, what: string, city: string): DimensionScore {
  const weight = WEIGHTS.local;
  if (ev.tagLocal) {
    const per = ev.tagLocal.map((t) => {
      const contrast = t.sourceLocation ?? "New York";
      if (t.cityRank === undefined) return { s: 0.2, why: `"${t.tag}" isn't characteristic here` };
      if (t.sourceRank === undefined)
        return {
          s: 1,
          why: `"${t.tag}" ranks #${t.cityRank} here and isn't in ${contrast}'s top list`,
        };
      const d = t.sourceRank - t.cityRank;
      if (d >= 5)
        return {
          s: 1,
          why: `"${t.tag}" ranks higher here (#${t.cityRank}) than in ${contrast} (#${t.sourceRank})`,
        };
      if (d > -5) return { s: 0.7, why: `"${t.tag}" ranks about the same here and in ${contrast}` };
      return {
        s: 0.5,
        why: `"${t.tag}" ranks lower here (#${t.cityRank}) than in ${contrast} (#${t.sourceRank})`,
      };
    });
    return {
      key: "local",
      score: mean(per.map((p) => p.s)),
      weight,
      evidenceIds: [...new Set(ev.tagLocal.map((t) => t.evidenceId))],
      explanation: `${per.map((p) => p.why).join("; ")}.`,
    };
  }
  const l = ev.local;
  if (!l) return { key: "local", weight, evidenceIds: [], explanation: "Not measured." };
  let score: number;
  let explanation: string;
  if (l.place) {
    if (!l.fromHere) {
      score = 0.1;
      explanation = `Qloo doesn't place ${what} in ${city}'s country.`;
    } else if (l.inCityList) {
      score = 1;
      explanation = `Among ${city}'s distinctive venues of its kind in Qloo.`;
    } else {
      score = 0.6;
      explanation = `In ${city}, but not among its distinctive venues of its kind.`;
    }
  } else if (l.fromHere) {
    score = 1;
    explanation = `Qloo places ${what}'s origin in ${city}'s country.`;
  } else if (l.inCityList && !l.global && !l.familiarInSource) {
    score = 1;
    explanation = `In ${city}'s own top list and not in other cities' lists: distinctive here.`;
  } else if (l.inCityList) {
    score = 0.6;
    explanation = `In ${city}'s top list, but just as big ${l.global ? "in other world cities" : "in US cities"}.`;
  } else if (l.global) {
    score = 0.2;
    explanation = `A global default, not distinctive to ${city}: absent from its own top list.`;
  } else if (l.familiarInSource) {
    score = 0.3;
    explanation = `Big in US cities' lists but absent from ${city}'s own top list.`;
  } else {
    // Not from here and not in the city's list is thin evidence, not a contradiction: a Danish
    // design brand can be a fine London collaborator.
    score = 0.4;
    explanation =
      `Not in ${city}'s own top list for its kind` +
      (l.foreign && l.origins.length ? `; Qloo ties it to ${l.origins.join(", ")}.` : ".");
  }
  return { key: "local", score, weight, evidenceIds: [l.evidenceId], explanation };
}

function excludedBy(label: string, constraints: Constraint[]): Constraint | undefined {
  return constraints.find(
    (c) => c.kind === "hard" && c.excludeNames?.some((n) => nameKey(n) === nameKey(label)),
  );
}

export interface EvaluateInput {
  plan: CulturalPlan;
  evidence: Map<Slot, ComponentEvidence>;
  constraints: Constraint[];
  city: string;
  iteration: number;
  previous?: PlanEvaluation;
}

export function assessComponent(
  input: EvaluateInput,
  slot: Slot,
  names: Map<string, string>,
): ComponentAssessment {
  const c = input.plan.components.find((x) => x.slot === slot)!;
  const ev = input.evidence.get(slot);
  const base = { slot, label: c.label };
  if (c.resolution !== "resolved" || !ev) {
    return {
      ...base,
      status: "unresolved",
      contradicted: false,
      coverage: "insufficient",
      dimensions: [],
      finding:
        c.resolution === "ambiguous"
          ? `Qloo's only "${c.label}" is a different one (${c.note ?? "another entity with the same name"}), so it couldn't be tested.`
          : `"${c.label}" isn't in Qloo, so there is no evidence either way.`,
    };
  }
  const tags = c.slot === "creative_direction" ? c.tags.map((t) => t.name) : null;
  const what = c.label;
  const dims: DimensionScore[] = [
    listDimension("audience", ev.audience, { what, city: input.city, tags, names }),
    localDimension(ev, what, input.city),
    listDimension("coherence", ev.coherence, { what, city: input.city, tags, names }),
    {
      key: "distinct",
      score: ev.duplicateOf ? 0 : 1,
      weight: WEIGHTS.distinct,
      evidenceIds: [],
      heuristic: true,
      explanation: ev.duplicateOf
        ? `Repeats ${ev.duplicateOf}.`
        : "Not a repeat of another choice (app heuristic).",
    },
  ];
  const scored = dims.filter((d) => d.score !== undefined);
  const wsum = scored.reduce((a, d) => a + d.weight, 0);
  const total = wsum ? scored.reduce((a, d) => a + d.weight * d.score!, 0) / wsum : undefined;
  const measured = dims.filter((d) => d.key !== "distinct" && d.score !== undefined).length;
  const coverage = measured >= 3 ? "adequate" : measured === 2 ? "partial" : "insufficient";
  const get = (k: string) => dims.find((d) => d.key === k)!;
  const audience = get("audience");
  const local = get("local");

  let status: ComponentStatus;
  let finding: string;
  const banned = excludedBy(c.label, input.constraints);
  if (banned) {
    status = "constraint_conflict";
    finding = `Breaks a hard constraint: ${banned.description}`;
  } else if (ev.audience && audience.score === undefined) {
    // Qloo returned nothing for it under this audience and city. Its other dimensions can't
    // stand in for that, so it gets no total rather than a flattering one. For a name Qloo
    // places in the city's own country that is thin evidence, not a contradiction: under a
    // location signal Qloo often leaves out very popular local names (Sanrio in Tokyo).
    status = "no_support";
    const fromHere = Boolean(ev.local?.fromHere) && !ev.local?.place;
    finding = fromHere
      ? `${audience.explanation} It is from here, and Qloo often leaves out very popular local names under a city signal, so this is thin evidence, not a contradiction.`
      : audience.explanation;
    return {
      ...base,
      status,
      total: undefined,
      coverage,
      dimensions: dims,
      finding,
      contradicted: !fromHere,
    };
  } else if (
    total !== undefined &&
    total >= SUPPORTED.total &&
    (audience.score ?? 0) >= SUPPORTED.audience &&
    (local.score ?? 0) >= SUPPORTED.local &&
    // Every part must be in the audience's list: a direction isn't supported by half its words.
    (ev.audience ?? []).every((h) => h.inList) &&
    !ev.duplicateOf
  ) {
    status = "supported";
    finding = audience.explanation;
  } else {
    status = "weak";
    // The finding names the dimension that holds it back most.
    const worst = scored
      .filter((d) => d.key !== "distinct" || ev.duplicateOf)
      .sort((a, b) => a.score! - b.score!)[0];
    finding = worst?.explanation ?? "Too little evidence to call it supported.";
  }
  // Weak is a contradiction only when the evidence points against the choice: a global or
  // foreign import (low local relevance), or a direction most of whose words this audience
  // here doesn't lean to. Thin evidence for a local choice is left for a human to judge.
  // A generic global default (absent from the city's own list but big elsewhere or in the US)
  // is the contradiction; being from another country or thinly evidenced is not.
  const l = ev.local;
  const globalDefault = Boolean(
    l && !l.place && !l.fromHere && !l.inCityList && (l.global || l.familiarInSource),
  );
  const contradicted =
    status === "constraint_conflict" ||
    (status === "weak" &&
      (c.slot === "creative_direction" ? (audience.score ?? 0) < 0.5 : globalDefault));
  return { ...base, status, total, coverage, dimensions: dims, finding, contradicted };
}

const STATUS_ORDER: ComponentStatus[] = [
  "constraint_conflict",
  "no_support",
  "unresolved",
  "weak",
  "supported",
];

export function evaluatePlan(input: EvaluateInput): PlanEvaluation {
  const names = new Map<string, string>();
  for (const a of input.plan.anchors) names.set(a.id, a.name);
  for (const c of input.plan.components) if (c.entity) names.set(c.entity.id, c.entity.name);

  const components = input.plan.components.map((c) => assessComponent(input, c.slot, names));
  const totals = components.map((c) => c.total).filter((t): t is number => t !== undefined);
  const totalScore = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : undefined;
  const hardConstraintViolations = components
    .filter((c) => c.status === "constraint_conflict")
    .map((c) => `${c.label}: ${c.finding}`);
  const locked = new Set(input.plan.components.filter((c) => c.locked).map((c) => c.slot));
  const weakest = components
    .filter((c) => c.contradicted && !locked.has(c.slot))
    .sort(
      (a, b) =>
        STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
        (a.total ?? 0) - (b.total ?? 0),
    )
    .map((c) => c.slot);
  const contradicted = components.filter((c) => c.contradicted && !locked.has(c.slot)).length;
  const accepted = hardConstraintViolations.length === 0 && contradicted === 0;
  const prev = input.previous?.totalScore;
  return {
    iteration: input.iteration,
    rubricVersion: RUBRIC_VERSION,
    totalScore,
    supported: components.filter((c) => c.status === "supported").length,
    contradicted,
    scored: totals.length,
    components,
    hardConstraintViolations,
    weakest,
    accepted,
    materialImprovementFromPrevious:
      prev !== undefined && totalScore !== undefined ? totalScore - prev : undefined,
  };
}

/**
 * The acceptance guard for one candidate's full-plan re-test, as structured facts. Replacing a
 * choice must improve the plan without breaking a hard rule, and without costing another
 * Supported choice unless that trade removes a contradiction (then the loss is recorded). An
 * upgrade of a choice nothing contradicts must also land on Supported and be materially better.
 * `accepted` is left false here: only the best passing candidate of a round is accepted.
 */
export function judgeRetest(
  prev: PlanEvaluation,
  next: PlanEvaluation,
  slot: Slot,
  upgrade: boolean,
): RetestResult {
  const before = prev.components.find((c) => c.slot === slot)!;
  const now = next.components.find((c) => c.slot === slot)!;
  const progress = compareEvaluations(prev, next, slot);
  const lostSupported = prev.components
    .filter(
      (c) =>
        c.slot !== slot &&
        c.status === "supported" &&
        next.components.find((x) => x.slot === c.slot)?.status !== "supported",
    )
    .map((c) => c.slot);
  let rejectionCode: RejectionCode | undefined;
  if (
    now.status === "constraint_conflict" ||
    next.hardConstraintViolations.length > prev.hardConstraintViolations.length
  )
    rejectionCode = "constraint_conflict";
  else if (lostSupported.length && !(next.contradicted < prev.contradicted))
    rejectionCode = "plan_regression";
  else if (!progress.better) rejectionCode = "no_improvement";
  else if (upgrade && now.status !== "supported") rejectionCode = "target_not_supported";
  else if (upgrade && !progress.material) rejectionCode = "no_improvement";
  return {
    slotStatusBefore: before.status,
    slotStatusAfter: now.status,
    slotScoreBefore: before.total,
    slotScoreAfter: now.total,
    supportedBefore: prev.supported,
    supportedAfter: next.supported,
    components: next.components.length,
    planScoreBefore: prev.totalScore,
    planScoreAfter: next.totalScore,
    contradictedBefore: prev.contradicted,
    contradictedAfter: next.contradicted,
    lostSupported,
    accepted: false,
    rejectionCode,
  };
}

export interface Progress {
  better: boolean;
  worse: boolean;
  /** Big enough to count as progress for the stall rule. */
  material: boolean;
}

/**
 * Did a repair help? Fewer contradicted choices count first, then supported choices, then the
 * repaired choice's own status, then the plan score. Comparing scores alone would mislead when a choice moves from "no
 * support" (no score) to a scored status.
 */
export function compareEvaluations(
  prev: PlanEvaluation,
  next: PlanEvaluation,
  slot: Slot,
): Progress {
  const k = prev.contradicted - next.contradicted;
  if (k !== 0) return { better: k > 0, worse: k < 0, material: k > 0 };
  const s = next.supported - prev.supported;
  if (s !== 0) return { better: s > 0, worse: s < 0, material: s > 0 };
  const rank = (e: PlanEvaluation) =>
    STATUS_ORDER.indexOf(e.components.find((c) => c.slot === slot)!.status);
  const r = rank(next) - rank(prev);
  if (r !== 0) return { better: r > 0, worse: r < 0, material: r > 0 };
  const d = (next.totalScore ?? 0) - (prev.totalScore ?? 0);
  return { better: d > 0, worse: d < 0, material: d >= MATERIAL_DELTA };
}
