import { checkPick } from "@/lib/agent/check";
import type { Ranking } from "./version";
import { mapLimit, nameKey } from "@/lib/engine/stats";
import { contrastLocation, type Market } from "@/lib/markets";
import type { InsightsInput, InsightsResult, QlooClient } from "@/lib/qloo";
import { coverageOf, itemsFrom, sanitizeInsights, type Ledger } from "./ledger";
import {
  SLOT_TYPE,
  type Component,
  type CulturalPlan,
  type EvidenceRecord,
  type Slot,
} from "./types";

/**
 * Evidence gathering: every Qloo query that feeds the evaluator goes through here and lands
 * in the ledger. Scoring (evaluate.ts) is pure and reads only what this returns.
 */

export const LIST_SIZE = 50;
/** Creative direction is tested against these Qloo tag families. */
export const DIRECTION_TAG_TYPES = [
  "urn:tag:aesthetic_property:qloo",
  "urn:tag:emotional_tone:qloo",
];

/** Where one item sits in one Qloo list. */
export interface ListHit {
  evidenceId: string;
  /** In the top LIST_SIZE results of the query. */
  inList: boolean;
  rank?: number;
  listSize: number;
  /** Qloo's affinity, when returned (in the list, or scored on its own). */
  affinity?: number;
  /** False when Qloo returned nothing for the item: no evidence of support under this signal. */
  returned: boolean;
  /** Signal entity ID → contribution, when explainability was computed. */
  explainability?: Record<string, number>;
}

export interface LocalFinding {
  evidenceId: string;
  /** Venues are local by location; what matters is whether the city's own list has them. */
  place: boolean;
  fromHere: boolean;
  inCityList: boolean;
  global: boolean;
  familiarInSource: boolean;
  foreign: boolean;
  origins: string[];
}

export interface TagLocal {
  evidenceId: string;
  tag: string;
  cityRank?: number;
  sourceRank?: number;
  /** The comparison city; normally New York, but London for a New York launch. */
  sourceLocation?: string;
}

export interface ComponentEvidence {
  slot: Slot;
  /** Null: not measurable (unresolved, or no audience anchors). */
  audience: ListHit[] | null;
  coherence: ListHit[] | null;
  local: LocalFinding | null;
  tagLocal: TagLocal[] | null;
  /** Another component (or anchor) this one duplicates. */
  duplicateOf: string | null;
}

export interface GatherContext {
  client: QlooClient;
  ledger: Ledger;
  market: Market;
  /** How repair candidates are retrieved and ranked (v1 when absent). */
  ranking?: Ranking;
}

async function insights(
  ctx: GatherContext,
  purpose: string,
  input: InsightsInput,
  focus: string[] = [],
): Promise<{ result: InsightsResult; record: EvidenceRecord }> {
  let result: InsightsResult;
  const warnings: string[] = [];
  try {
    result = await ctx.client.getInsights(input);
  } catch (err) {
    if ((err as Error).name === "BudgetExceeded") throw err;
    const record = ctx.ledger.add({
      purpose,
      queryKind: "insights",
      sanitizedRequest: sanitizeInsights(input),
      qlooEntityIds: [...(input.signalEntities ?? []), ...focus],
      results: [],
      resultCount: 0,
      coverageStatus: "error",
      warnings: [err instanceof Error ? err.message : String(err)],
    });
    return {
      result: { entities: [], tags: [], aggregateExplainability: null, durationMs: null },
      record,
    };
  }
  const count = result.entities.length + result.tags.length;
  if (input.explainability && count > 0 && !result.entities.some((e) => e.explainability))
    if (input.filterType !== "urn:tag")
      warnings.push("Explainability was requested but not returned.");
  const record = ctx.ledger.add({
    purpose,
    queryKind: "insights",
    sanitizedRequest: sanitizeInsights(input),
    qlooEntityIds: [...(input.signalEntities ?? []), ...focus],
    results: itemsFrom(result, focus),
    resultCount: count,
    coverageStatus: input.resultEntities
      ? count
        ? "usable"
        : "empty"
      : coverageOf(count, input.take ?? LIST_SIZE),
    warnings,
  });
  return { result, record };
}

function entityQuery(c: Component, market: Market, signal: string[]): InsightsInput {
  const type = SLOT_TYPE[c.slot as keyof typeof SLOT_TYPE];
  const place = c.slot === "event_place";
  return {
    filterType: type,
    signalEntities: signal,
    signalLocationQuery: place ? undefined : market.qlooLocation,
    filterLocationQuery: place ? market.qlooLocation : undefined,
    filterTags: place && c.placeCategory ? [c.placeCategory] : undefined,
    explainability: true,
    take: LIST_SIZE,
  };
}

/** Find an entity in a signal's top list; if it isn't there, ask Qloo to score it alone. */
async function entityHit(
  ctx: GatherContext,
  c: Component,
  signal: string[],
  purpose: string,
): Promise<ListHit> {
  const id = c.entity!.id;
  const base = entityQuery(c, ctx.market, signal);
  const { result, record } = await insights(ctx, purpose, base, [id]);
  const found = result.entities.find(
    (e) => e.id === id || nameKey(e.name) === nameKey(c.entity!.name),
  );
  if (found) {
    return {
      evidenceId: record.evidenceId,
      inList: true,
      rank: found.rank,
      listSize: result.entities.length,
      affinity: found.affinity ?? undefined,
      returned: true,
      explainability: found.explainability ?? undefined,
    };
  }
  const single = await insights(
    ctx,
    `${purpose} (scored on its own: not in the top ${LIST_SIZE})`,
    { ...base, resultEntities: [id], take: 1 },
    [id],
  );
  const own = single.result.entities[0];
  return {
    evidenceId: single.record.evidenceId,
    inList: false,
    listSize: result.entities.length,
    affinity: own?.affinity ?? undefined,
    returned: Boolean(own),
    explainability: own?.explainability ?? undefined,
  };
}

/** The audience's top tags of the creative-direction families, under one signal and city. */
export async function tagList(
  ctx: GatherContext,
  signal: string[],
  location: string,
  purpose: string,
): Promise<{ tags: InsightsResult["tags"]; record: EvidenceRecord }[]> {
  return mapLimit(DIRECTION_TAG_TYPES, 2, async (t) => {
    const { result, record } = await insights(
      ctx,
      `${purpose}: ${t.split(":")[2].replace("_", " ")}`,
      {
        filterType: "urn:tag",
        filterTagTypes: [t],
        signalEntities: signal,
        signalLocationQuery: location,
        take: LIST_SIZE,
      },
    );
    return { tags: result.tags, record };
  });
}

function tagHits(lists: Awaited<ReturnType<typeof tagList>>, c: Component): ListHit[] {
  return c.tags.map((tag) => {
    for (const { tags, record } of lists) {
      const t = tags.find((x) => x.id === tag.id || nameKey(x.name) === nameKey(tag.name));
      if (t)
        return {
          evidenceId: record.evidenceId,
          inList: true,
          rank: t.rank,
          listSize: tags.length,
          affinity: t.affinity ?? undefined,
          returned: true,
        };
    }
    const family =
      lists.find((l) => l.tags.some((x) => tag.id.startsWith(x.subtype ?? "-"))) ?? lists[0];
    return {
      evidenceId: family.record.evidenceId,
      inList: false,
      listSize: family.tags.length,
      // Tag insights can't score a single tag, so "outside the top list" is the measurement.
      returned: true,
    };
  });
}

async function locality(ctx: GatherContext, c: Component): Promise<LocalFinding | null> {
  const purpose = `Is ${c.entity!.name} local to ${ctx.market.label}, or just famous?`;
  let full: Awaited<ReturnType<QlooClient["getEntities"]>>[number] | undefined;
  let check: Awaited<ReturnType<typeof checkPick>>;
  try {
    [full] = await ctx.client.getEntities([c.entity!.id]);
    check = await checkPick(ctx.client, { pick: full ?? null, anchor: null, market: ctx.market });
  } catch (err) {
    if ((err as Error).name === "BudgetExceeded") throw err;
    ctx.ledger.add({
      purpose,
      queryKind: "locality",
      sanitizedRequest: { entity: c.entity!.id },
      qlooEntityIds: [c.entity!.id],
      results: [],
      resultCount: 0,
      coverageStatus: "error",
      warnings: [err instanceof Error ? err.message : String(err)],
    });
    return null;
  }
  const record = ctx.ledger.add({
    purpose,
    queryKind: "locality",
    sanitizedRequest: {
      method: `${ctx.market.label}'s own top list for this kind and category, compared with 4 other world cities and 4 US cities (location-only Insights), plus Qloo's origin data`,
      entity: c.entity!.id,
    },
    qlooEntityIds: [c.entity!.id],
    results: [
      { id: c.entity!.id, name: c.entity!.name, popularity: full?.popularity ?? undefined },
    ],
    resultCount: 1,
    coverageStatus: check.found ? "usable" : "empty",
    warnings: check.found ? [] : ["Full record not found."],
  });
  return {
    evidenceId: record.evidenceId,
    place: c.slot === "event_place",
    fromHere: check.fromHere,
    inCityList: check.localEvidence,
    global: check.global,
    familiarInSource: check.familiarInSource,
    foreign: check.foreign,
    origins: check.origins,
  };
}

/** Run every check for every component of the plan. */
export async function gatherEvidence(
  ctx: GatherContext,
  plan: CulturalPlan,
  only?: Slot[],
): Promise<Map<Slot, ComponentEvidence>> {
  const anchors = plan.anchors.map((a) => a.id);
  const resolved = plan.components.filter((c) => c.resolution === "resolved");
  const entityIds = resolved.filter((c) => c.entity).map((c) => c.entity!.id);
  const out = new Map<Slot, ComponentEvidence>();

  // Tag lists are shared by the creative-direction checks.
  const direction = resolved.find((c) => c.slot === "creative_direction" && c.tags.length);
  const contrast = contrastLocation(ctx.market);
  const dirLists = direction
    ? {
        audience: anchors.length
          ? await tagList(
              ctx,
              anchors,
              ctx.market.qlooLocation,
              `What this audience in ${ctx.market.label} leans to`,
            )
          : null,
        source: anchors.length
          ? await tagList(ctx, anchors, contrast, `The same audience in ${contrast}, for contrast`)
          : null,
        package: entityIds.length
          ? await tagList(
              ctx,
              entityIds,
              ctx.market.qlooLocation,
              `What the plan's other choices lean to in ${ctx.market.label}`,
            )
          : null,
      }
    : null;

  const targets = plan.components.filter((c) => !only || only.includes(c.slot));
  await mapLimit(targets, 2, async (c) => {
    const ev: ComponentEvidence = {
      slot: c.slot,
      audience: null,
      coherence: null,
      local: null,
      tagLocal: null,
      duplicateOf: null,
    };
    out.set(c.slot, ev);
    if (c.resolution !== "resolved") return;

    if (c.slot === "creative_direction") {
      if (dirLists?.audience) ev.audience = tagHits(dirLists.audience, c);
      // An empty package list means nothing to test against, not "outside the top 0".
      if (dirLists?.package?.some((l) => l.tags.length))
        ev.coherence = tagHits(dirLists.package, c);
      if (dirLists?.audience && dirLists.source) {
        const city = tagHits(dirLists.audience, c);
        const src = tagHits(dirLists.source, c);
        ev.tagLocal = c.tags.map((t, i) => ({
          evidenceId: city[i].evidenceId,
          tag: t.name,
          cityRank: city[i].rank,
          sourceRank: src[i].rank,
          sourceLocation: contrast,
        }));
      }
      return;
    }

    const e = c.entity!;
    const dup =
      plan.components.find(
        (o) =>
          o !== c &&
          o.entity &&
          (o.entity.id === e.id || nameKey(o.entity.name) === nameKey(e.name)),
      ) ?? null;
    // An anchor as a choice (DIVINE headlining for DIVINE's fans) is a fit, not a repeat.
    ev.duplicateOf = dup ? dup.label : null;

    const others = entityIds.filter((id) => id !== e.id);
    // Qloo leaves signal entities out of its results, so an anchor used as a choice is tested
    // against the other anchors (leave one out) instead of failing against itself.
    const isAnchor = anchors.includes(e.id);
    const audienceSignal = anchors.filter((id) => id !== e.id);
    const [audience, coherence, local] = await Promise.all([
      audienceSignal.length
        ? entityHit(
            ctx,
            c,
            audienceSignal,
            isAnchor
              ? `Does the rest of this audience in ${ctx.market.label} have affinity for ${e.name} (itself an audience anchor)?`
              : `Does this audience in ${ctx.market.label} have affinity for ${e.name}?`,
          )
        : null,
      others.length
        ? entityHit(
            ctx,
            c,
            others,
            `Does ${e.name} fit the rest of the plan in ${ctx.market.label}?`,
          )
        : null,
      locality(ctx, c),
    ]);
    ev.audience = audience ? [audience] : null;
    ev.coherence = coherence ? [coherence] : null;
    ev.local = local;
  });
  return out;
}
