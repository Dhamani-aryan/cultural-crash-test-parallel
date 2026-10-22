import { z } from "zod";
import { CONTROL_COUNT, GLOBAL_PRESENCE, cityList, isLocalOrigin } from "@/lib/engine/equivalents";
import { isForeignOrigin } from "@/lib/engine/origin";
import { categoryTags, kindLabel, roleSimilarity, roleTags } from "@/lib/engine/role";
import { mapLimit, nameKey } from "@/lib/engine/stats";
import { generateStructured } from "@/lib/llm/structured";
import type { LlmClient } from "@/lib/llm/types";
import { controlLocations, sourceLocations, type Domain } from "@/lib/markets";
import type { QlooEntity } from "@/lib/qloo";
import { LIST_SIZE, tagList, type GatherContext } from "./gather";
import { itemsFrom, sanitizeInsights } from "./ledger";
import { PLACE_CATEGORIES, briefText, findInMarket, findPlace, toRef } from "./plan";
import {
  SLOT_LABEL,
  SLOT_TYPE,
  type Component,
  type ComponentAssessment,
  type CandidateTrial,
  type CandidateView,
  type CulturalPlan,
  type LaunchBrief,
  type Slot,
} from "./types";

/**
 * Targeted repair: research replacements for ONE weak component in Qloo, screen them, and let
 * the model choose among the survivors only. Code checks that the choice is one of them.
 */

export const SHORTLIST = 6;
/** v2: results kept per view, and the reciprocal-rank-fusion constant (the standard k = 60). */
export const VIEW_TAKE = 25;
export const RRF_K = 60;

/** Reciprocal rank fusion: each list adds 1 / (k + rank). Ranks are combined, not raw affinities. */
export function fuseRanks(
  lists: { view: CandidateView; ids: string[] }[],
): Map<string, { score: number; views: Partial<Record<CandidateView, number>> }> {
  const out = new Map<string, { score: number; views: Partial<Record<CandidateView, number>> }>();
  for (const { view, ids } of lists)
    ids.forEach((id, i) => {
      const e = out.get(id) ?? { score: 0, views: {} };
      if (e.views[view] !== undefined) return;
      e.views[view] = i + 1;
      e.score += 1 / (RRF_K + i + 1);
      out.set(id, e);
    });
  return out;
}
const SCREEN = 40;
/** Candidates re-tested per round, in the model's order, before the round gives up. */
export const MAX_TRIALS = 3;

export interface Candidate {
  entity: QlooEntity;
  /** Rank under `anchors + other choices + city`: fit with the audience and the plan. */
  fitRank: number;
  local: boolean;
  localWhy: string;
  role: number;
  sharedRole: string[];
  score: number;
}

export interface RepairProposal {
  slot: Slot;
  after: Component;
  reason: string;
  expectedEffect: string;
  evidenceIds: string[];
  /** Shown in the trace: what else was considered. */
  considered: string[];
}

/** A trial before the controller knows its round or its re-test. */
export type DraftTrial = Omit<CandidateTrial, "iteration">;

export interface EntityRepair {
  /** Re-test these, best first. */
  proposals: RepairProposal[];
  /** Every candidate considered, with why it didn't reach a re-test when it didn't. */
  trials: DraftTrial[];
}

const domainOf = (slot: Slot): Domain =>
  slot === "artist_music" ? "artist" : slot === "brand_collaboration" ? "brand" : "place";

/** Cheap locality screen with the original's category lists (already cached by the evaluation). */
async function screen(
  ctx: GatherContext,
  domain: Domain,
  category: string[],
  entities: QlooEntity[],
): Promise<Map<string, { local: boolean; why: string }>> {
  const controls = controlLocations(ctx.market, CONTROL_COUNT);
  const sources = sourceLocations(ctx.market);
  const cities = [ctx.market.qlooLocation, ...controls, ...sources];
  const lists = await mapLimit(cities, 3, (city) => cityList(ctx.client, domain, city, category));
  const key = (e: QlooEntity) => (domain === "place" ? nameKey(e.name) : e.id);
  const out = new Map<string, { local: boolean; why: string }>();
  for (const e of entities) {
    const me = key(e);
    const inCity = lists[0].some((x) => key(x) === me);
    const controlHits = lists
      .slice(1, 1 + controls.length)
      .filter((l) => l.some((x) => key(x) === me)).length;
    const inSource = lists.slice(1 + controls.length).some((l) => l.some((x) => key(x) === me));
    const fromHere = isLocalOrigin(e, domain, ctx.market);
    const foreign = domain !== "place" && isForeignOrigin(e, ctx.market.country);
    let local: boolean;
    let why: string;
    if (domain === "place") {
      local = fromHere;
      why = inCity ? "one of the city's distinctive venues" : "in the city";
    } else if (fromHere) {
      local = true;
      why = "from here";
    } else if (foreign) {
      local = false;
      why = "from another country";
    } else if (inCity && controlHits < GLOBAL_PRESENCE && !inSource) {
      local = true;
      why = "distinctive here";
    } else {
      local = false;
      why = inCity ? "just as big elsewhere" : "not in the city's own list";
    }
    out.set(e.id, { local, why });
  }
  return out;
}

/** "38 from another country, 2 just as big elsewhere" */
export function screenSummary(candidates: Pick<Candidate, "localWhy">[]): string {
  const counts = new Map<string, number>();
  for (const c of candidates) counts.set(c.localWhy, (counts.get(c.localWhy) ?? 0) + 1);
  return `of the top ${candidates.length} for this audience, ${[...counts].map(([why, n]) => `${n} ${why}`).join(", ")}`;
}

/** Venues a launch event can't be held in, whatever the audience data says. */
const UNSUITABLE_VENUE =
  /^urn:tag:(category|genre):place:.*(hotel|motel|hostel|resort|lodging|bed_and_breakfast|apartment|outlet|storage|airport|hospital|clinic|car_rental|gas_station|parking)/;

/**
 * The same job as the original: a brand from the same kind of business (shared genre tags), a
 * venue of the kind the plan asked for and able to host an event. Artists need no gate.
 */
/** Kinds of place that can host a launch event: a pop-up, a drop, a gig, a session. */
const EVENT_FORMATS = new Set(
  [
    ...PLACE_CATEGORIES,
    "exhibition_center",
    "museum",
    "performing_arts_theater",
    "community_center",
    "shopping_mall",
    "department_store",
    "boutique",
  ].map((c) => `urn:tag:category:place:${c}`),
);
/** Food and drink venues suit only a food or drink launch. */
const FOOD_VENUES = [
  "cafe",
  "coffee_shop",
  "restaurant",
  "bakery",
  "brewery",
  "brewpub",
  "beer_garden",
  "pub",
].map((c) => `urn:tag:category:place:${c}`);
const FOOD_AND_DRINK =
  /coffee|caf[eé]|tea|food|drink|beer|brew|wine|spirit|bakery|restaurant|snack|chocolate|juice/i;

export function isFoodAndDrink(productCategory: string): boolean {
  return FOOD_AND_DRINK.test(productCategory);
}

/**
 * What Qloo's categories say about a venue's format: filed as a kind that can't host a launch
 * (a hotel, a clinic), as one that can, or neither. Qloo's categories are incomplete, so
 * "neither" is unknown, not unsuitable.
 */
export function venueFormat(tagIds: string[], foodAndDrink: boolean): "can_host" | "unsuitable" | "unknown" {
  if (tagIds.some((t) => UNSUITABLE_VENUE.test(t))) return "unsuitable";
  const cats = tagIds.filter((t) => t.startsWith("urn:tag:category:place:"));
  return cats.some((c) => EVENT_FORMATS.has(c) || (foodAndDrink && FOOD_VENUES.includes(c))) ? "can_host" : "unknown";
}

export function roleFits(
  slot: Slot,
  candidate: { tags: { id: string; type: string | null }[] },
  original: { tags: { id: string; type: string | null }[] } | null,
  placeCategory: string | null,
  opts: { foodAndDrink?: boolean } = {},
): boolean {
  if (slot === "event_place") {
    if (candidate.tags.some((t) => UNSUITABLE_VENUE.test(t.id))) return false;
    const cats = candidate.tags
      .filter((t) => t.id.startsWith("urn:tag:category:place:"))
      .map((t) => t.id);
    // Event-format gate: the venue must be filed as a kind of place that can host the launch.
    const canHost = cats.some(
      (c) => EVENT_FORMATS.has(c) || (opts.foodAndDrink && FOOD_VENUES.includes(c)),
    );
    if (!canHost) return false;
    return !placeCategory || cats.includes(placeCategory);
  }
  if (slot === "brand_collaboration" && original) {
    const genres = new Set(categoryTags(original as never, "brand"));
    if (!genres.size) return true;
    return categoryTags(candidate as never, "brand").some((g) => genres.has(g));
  }
  return true;
}

// ---------- brief fit on evidence ----------

/** Words too generic to show a brand fits a brief ("fashion", "brand"). */
const GENERIC = new Set(
  "brand brands fashion clothing apparel label labels store stores shop goods product products wear streetwear casual lifestyle company the and for with from that this other".split(
    " ",
  ),
);
const stem = (w: string) =>
  w.replace(/(ability|ibility|able|ible|ity|ness|ing|ed|es|s)$/, "").slice(0, 7);
function terms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}]+/u)
      .filter((w) => w.length >= 3 && !GENERIC.has(w))
      .map(stem),
  );
}

/** What Qloo says a candidate is: its description and its descriptive tags, not trade data. */
function evidenceText(e: Pick<QlooEntity, "shortDescription" | "description" | "tags">): string {
  const tags = e.tags
    .filter(
      (t) => !/wikipedia_category|key_market|product_category|category:place/.test(t.type ?? t.id),
    )
    .map((t) => t.name ?? "");
  return [e.shortDescription ?? "", e.description ?? "", ...tags].join(" ");
}

/** Phrases a hard text rule rules out: "No fast-fashion collaborators" → "fast fashion". */
export function ruledOut(brief: Pick<LaunchBrief, "constraints">): string[] {
  return brief.constraints
    .filter((c) => c.kind === "hard" && !c.lockSlot)
    .flatMap((c) => {
      const m = c.description.match(/\b(?:no|not|never|avoid|without)\s+(?:any\s+|a\s+)?(.+)$/i);
      if (!m) return [];
      const phrase = m[1]
        .toLowerCase()
        .replace(/[-_]/g, " ")
        .replace(
          /\b(collaborators?|collaborations?|brands?|partners?|partnerships?|venues?|acts?|artists?|choices?)\b/g,
          "",
        )
        .replace(/[^\p{L}\s]/gu, "")
        .replace(/\s+/g, " ")
        .trim();
      return phrase.length >= 3 ? [phrase] : [];
    });
}

/**
 * Does a candidate fit the brief on Qloo's own evidence? A candidate matching a ruled-out
 * phrase never fits. When the original choice is unknown to Qloo there is nothing to compare
 * the role with, so a collaboration brand must also show, in its Qloo description or tags, at
 * least one of the brief's product or attribute terms. Otherwise the unknown choice is kept.
 */
/** The brief's testable product and attribute terms (generic words like "streetwear" removed). */
export const briefTerms = (brief: Pick<LaunchBrief, "productCategory" | "brandAttributes">) =>
  terms([brief.productCategory, ...brief.brandAttributes].join(" "));

export function fitsBrief(
  e: Pick<QlooEntity, "shortDescription" | "description" | "tags">,
  brief: Pick<LaunchBrief, "constraints" | "productCategory" | "brandAttributes">,
  opts: { requireAttributes: boolean },
): { ok: boolean; why?: string } {
  const text = evidenceText(e).toLowerCase().replace(/[-_]/g, " ");
  const banned = ruledOut(brief).find((p) => text.includes(p));
  if (banned) return { ok: false, why: `matches "${banned}", which the brief rules out` };
  if (!opts.requireAttributes) return { ok: true };
  const want = briefTerms(brief);
  const have = terms(text);
  return [...want].some((t) => have.has(t))
    ? { ok: true }
    : { ok: false, why: "Qloo's evidence doesn't show it fits the brief's attributes" };
}

const tagNames = (e: QlooEntity, prefix: string) =>
  e.tags
    .filter((t) => t.id.startsWith(prefix) && t.name)
    .map((t) => t.name!)
    .slice(0, 3);

// ---------- candidate sources ----------

const proposeSchema = z.object({
  names: z.array(z.string()).describe("up to 6 real names, exactly as usually written"),
});

/**
 * The model's own candidates. Qloo's lists rank what is distinctive for the audience, which can
 * miss the obvious right answer for the job; the model knows what does the job. Every name it
 * gives is looked up and scored in Qloo like any other candidate, and dropped if Qloo can't
 * find it or shows no affinity for it.
 */
async function proposeNames(input: {
  llm: LlmClient;
  ctx: GatherContext;
  brief: LaunchBrief;
  slot: Exclude<Slot, "creative_direction">;
  current: Component;
  finding: string;
  avoid: string[];
}): Promise<string[]> {
  const { ctx } = input;
  const what =
    input.slot === "artist_music"
      ? "music acts (artists or DJs) who could headline this launch"
      : input.slot === "brand_collaboration"
        ? "brands that would make a credible collaboration partner for this product"
        : `venues in ${ctx.market.label} that could host this launch event`;
  const { data } = await generateStructured(input.llm, {
    schema: proposeSchema,
    system: `You are a cultural strategist who lives in ${ctx.market.label}. Name up to 6 real ${what}. Prefer ones from ${ctx.market.label}'s own scene that this audience follows, over global defaults. Exact names only.`,
    prompt: [
      briefText(input.brief, ctx.market),
      `Current ${SLOT_LABEL[input.slot].toLowerCase()}: ${input.current.label}. Why it is being replaced: ${input.finding}`,
      input.avoid.length ? `Don't suggest: ${input.avoid.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    label: `propose:${input.slot}`,
  });
  return data.names.slice(0, 6);
}

const rankSchema = z.object({
  choices: z
    .array(
      z.object({
        id: z.string().describe("a candidate's id, copied exactly"),
        reason: z.string().describe("one or two sentences citing the evidence given"),
        expectedEffect: z
          .string()
          .describe(
            "which test should improve in the re-test (audience affinity, local relevance or fit with the plan)",
          ),
      }),
    )
    .describe("up to 3 candidates, best first; empty when none can do the job"),
  none: z.string().optional().describe("when choices is empty: why no candidate fits the role"),
});

const PICK_SYSTEM = `You repair one weak choice in a launch plan. Rank up to 3 candidates, best first, that credibly do the same job for this brand: a venue that can host this launch, a partner brand that makes sense for this product, an act that suits the event and audience. Prefer what a local expert would actually pick, among candidates with strong evidence. If none can do the job, return no choices and say why: a forced bad fit is worse than an open question. Use only the evidence given; never predict sales, engagement or attendance. Copy ids exactly.`;

export async function repairEntity(input: {
  llm: LlmClient;
  ctx: GatherContext;
  brief: LaunchBrief;
  plan: CulturalPlan;
  slot: Exclude<Slot, "creative_direction">;
  assessment: ComponentAssessment;
  rejected: string[];
  /**
   * Upgrade a choice the evidence doesn't contradict but only thinly supports. Candidates (the
   * agent's suggestions and the audience list alike) must be from the city's own country: an
   * upgrade must be a sensible local pick, not merely a higher-scoring import.
   */
  upgrade?: boolean;
  /**
   * Fill an open slot of the evidence-first plan: there is no current choice to replace, and the
   * model may not suggest names. Candidates come only from Qloo's lists; the model only chooses
   * among the screened ones.
   */
  initial?: boolean;
}): Promise<EntityRepair> {
  const { ctx, plan, slot, brief } = input;
  const current = plan.components.find((c) => c.slot === slot)!;
  const domain = domainOf(slot);
  const place = slot === "event_place";
  const others = plan.components
    .filter((c) => c.slot !== slot && c.entity)
    .map((c) => c.entity!.id);
  const signal = [...plan.anchors.map((a) => a.id), ...others];
  const bannedNames = [
    ...brief.constraints.flatMap((c) => (c.kind === "hard" ? (c.excludeNames ?? []) : [])),
    ...input.rejected,
    ...plan.anchors.map((a) => a.name),
    ...plan.components.flatMap((c) => (c.entity ? [c.entity.name] : [])),
    current.label,
  ];
  const banned = new Set(bannedNames.map(nameKey));
  const allowed = (e: QlooEntity) =>
    !banned.has(nameKey(e.name)) && !banned.has(nameKey(e.displayName));

  // Source 1: what this audience, with the rest of the plan, has affinity for in the city.
  const query = {
    filterType: SLOT_TYPE[slot],
    signalEntities: signal,
    signalLocationQuery: place ? undefined : ctx.market.qlooLocation,
    filterLocationQuery: place ? ctx.market.qlooLocation : undefined,
    filterTags: place && current.placeCategory ? [current.placeCategory] : undefined,
    excludeEntities: current.entity ? [current.entity.id] : undefined,
    explainability: true,
    take: LIST_SIZE,
  };
  // v1 asks one question (this audience, with the rest of the plan, in the city). v2 asks each
  // intention separately, so a candidate's strength stays visible: audience fit, local relevance
  // and fit with the other choices, plus the agent's own proposals. Ranks are fused, not scores.
  const v2 = ctx.ranking === "v2";
  const lists: {
    view: CandidateView;
    entities: (QlooEntity & { rank?: number })[];
    evidenceId: string;
  }[] = [];
  const coverage = (n: number) =>
    n >= 10 ? ("usable" as const) : n ? ("partial" as const) : ("empty" as const);
  const ask = async (view: CandidateView, purpose: string, q: typeof query) => {
    const r = await ctx.client.getInsights(q);
    const rec = ctx.ledger.add({
      purpose,
      queryKind: "insights",
      sanitizedRequest: sanitizeInsights(q),
      qlooEntityIds: q.signalEntities ?? [],
      results: itemsFrom(r),
      resultCount: r.entities.length,
      coverageStatus: coverage(r.entities.length),
      warnings: [],
    });
    lists.push({
      view,
      entities: r.entities as (QlooEntity & { rank?: number })[],
      evidenceId: rec.evidenceId,
    });
    return r;
  };
  const what = SLOT_LABEL[slot].toLowerCase();
  let rankOf: (aff: number) => number = () => 0;
  if (!v2) {
    const result = await ask(
      "combined",
      `Find ${what} candidates that fit this audience and the rest of the plan in ${ctx.market.label}`,
      query,
    );
    const listAff = result.entities.map((e) => e.affinity ?? 0);
    rankOf = (aff: number) => 1 + listAff.filter((a) => a > aff).length;
  } else {
    await ask("audience", `Find ${what} candidates for this audience in ${ctx.market.label}`, {
      ...query,
      signalEntities: plan.anchors.map((a) => a.id),
      take: VIEW_TAKE,
    });
    if (others.length) {
      await ask(
        "coherence",
        `Find ${what} candidates that fit the rest of the plan in ${ctx.market.label}`,
        { ...query, signalEntities: others, take: VIEW_TAKE },
      );
    } else {
      // Recorded, never simulated: there is nothing else in the plan to be coherent with.
      ctx.ledger.add({
        purpose: `Plan-coherence view for the ${what} (omitted)`,
        queryKind: "insights",
        sanitizedRequest: {},
        qlooEntityIds: [],
        results: [],
        resultCount: 0,
        coverageStatus: "empty",
        warnings: ["No other resolved choices to test plan coherence against."],
      });
    }
    // Local relevance: the city's own list for this kind (the same list the locality screen reads).
    const [orig] = current.entity ? await ctx.client.getEntities([current.entity.id]) : [];
    const cat =
      place && current.placeCategory
        ? [current.placeCategory]
        : orig
          ? categoryTags(orig, domain)
          : [];
    const cityTop = (await cityList(ctx.client, domain, ctx.market.qlooLocation, cat)).slice(
      0,
      VIEW_TAKE,
    );
    const rec = ctx.ledger.add({
      purpose: `${ctx.market.label}'s own top list for this kind of ${what}`,
      queryKind: "insights",
      sanitizedRequest: {
        "filter.type": SLOT_TYPE[slot],
        "location.query": ctx.market.qlooLocation,
        "filter.tags": cat,
      },
      qlooEntityIds: [],
      results: cityTop.slice(0, 8).map((e, i) => ({ id: e.id, name: e.displayName, rank: i + 1 })),
      resultCount: cityTop.length,
      coverageStatus: coverage(cityTop.length),
      warnings: [],
    });
    lists.push({ view: "local", entities: cityTop, evidenceId: rec.evidenceId });
  }
  const listIds = lists.map((l) => l.evidenceId);

  // Source 2: the agent's own suggestions, found and scored in Qloo under the same signal.
  // An initial evidence-first pick takes names from Qloo only.
  const names = input.initial ? [] : await proposeNames({
    llm: input.llm,
    ctx,
    brief,
    slot,
    current,
    finding: input.assessment.finding,
    avoid: bannedNames,
  }).catch(() => [] as string[]);
  const found = await mapLimit(names, 3, (n) =>
    (place
      ? findPlace(ctx.client, n, ctx.market)
      : findInMarket(ctx.client, n, [domain as "artist" | "brand"], ctx.market)
    ).catch(() => null),
  );
  const proposals = found.filter((e): e is QlooEntity => e !== null && allowed(e));
  const proposalFit = new Map<string, { affinity: number; rank: number }>();
  let proposalRecordId: string | null = null;
  if (proposals.length) {
    const scoring = {
      ...query,
      filterTags: undefined,
      excludeEntities: undefined,
      resultEntities: proposals.map((e) => e.id),
      take: proposals.length,
    };
    const scored = await ctx.client.getInsights(scoring);
    // v1 places each proposal in the combined list; v2 ranks the proposals as their own view.
    const affs = scored.entities.flatMap((e) => (e.affinity !== null ? [e.affinity] : []));
    for (const e of scored.entities)
      if (e.affinity !== null)
        proposalFit.set(e.id, {
          affinity: e.affinity,
          rank: v2 ? 1 + affs.filter((a) => a > e.affinity!).length : rankOf(e.affinity),
        });
    proposalRecordId = ctx.ledger.add({
      purpose: `Score the agent's own ${SLOT_LABEL[slot].toLowerCase()} suggestions for this audience and plan in ${ctx.market.label}`,
      queryKind: "insights",
      sanitizedRequest: sanitizeInsights(scoring),
      qlooEntityIds: proposals.map((e) => e.id),
      results: itemsFrom(scored),
      resultCount: scored.entities.length,
      coverageStatus: scored.entities.length ? "usable" : "empty",
      warnings: [
        ...names.filter((_, i) => !found[i]).map((n) => `"${n}" isn't in Qloo.`),
        ...proposals
          .filter((e) => !proposalFit.has(e.id))
          .map((e) => `No affinity returned for ${e.displayName}.`),
      ],
    }).evidenceId;
  }

  // The agent's suggestions that never reached the screen, each with the recorded reason.
  const trials: DraftTrial[] = [];
  const proposalIds = proposalRecordId ? [proposalRecordId] : [];
  names.forEach((n, i) => {
    const e = found[i];
    const out = (screenedOutReason: string, entityId?: string) =>
      trials.push({
        slot,
        name: e?.displayName ?? n,
        entityId,
        source: "llm_proposal",
        evidenceIds: proposalIds,
        briefFit: "unknown",
        screenedOutReason,
      });
    if (!e) out("Not found in Qloo");
    else if (!allowed(e))
      out("Excluded: ruled out by the brief, already tried, or already in the plan", e.id);
    else if (!proposalFit.has(e.id)) out("No affinity returned for this audience", e.id);
  });

  const seen = new Set<string>();
  const pool: { e: QlooEntity; rank: number; proposed: boolean }[] = [];
  const scoredProposals = proposals.filter((e) => proposalFit.has(e.id));
  // v2: every view's allowed candidates, fused by rank; the fused order forms the pool.
  const fused = v2
    ? fuseRanks([
        ...lists.map((l) => ({ view: l.view, ids: l.entities.filter(allowed).map((e) => e.id) })),
        {
          view: "proposals" as const,
          ids: [...scoredProposals]
            .sort((a, b) => proposalFit.get(a.id)!.rank - proposalFit.get(b.id)!.rank)
            .map((e) => e.id),
        },
      ])
    : null;
  const fusedOrder = fused
    ? [...fused]
        .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
        .map(([id]) => id)
    : [];
  const entityOf = new Map<string, QlooEntity>(
    [...lists.flatMap((l) => l.entities), ...scoredProposals].map((e) => [e.id, e as QlooEntity]),
  );
  const candidatesIn = v2
    ? fusedOrder.slice(0, SCREEN).map((id) => {
        const views = fused!.get(id)!.views;
        const e = entityOf.get(id)!;
        return {
          e,
          rank: views.audience ?? views.proposals ?? views.coherence ?? views.local ?? SCREEN,
          proposed: views.proposals !== undefined,
        };
      })
    : [
        ...scoredProposals.map((e) => ({ e, rank: proposalFit.get(e.id)!.rank, proposed: true })),
        ...lists[0].entities
          .filter(allowed)
          .slice(0, SCREEN)
          .map((e, i) => ({ e: e as QlooEntity, rank: e.rank ?? i + 1, proposed: false })),
      ];
  for (const p of candidatesIn) {
    if (seen.has(p.e.id)) continue;
    seen.add(p.e.id);
    pool.push(p);
  }
  if (!pool.length) return { proposals: [], trials };

  // Full records carry the origin and role tags the screen needs.
  const full = await ctx.client.getEntities(pool.map((p) => p.e.id));
  const byId = new Map(full.map((e) => [e.id, e]));
  const records = pool.map((p) => ({ ...p, e: { ...p.e, ...(byId.get(p.e.id) ?? {}) } }));
  const [original] = current.entity ? await ctx.client.getEntities([current.entity.id]) : [];
  const category = original ? categoryTags(original, domain) : [];
  const local = await screen(
    ctx,
    domain,
    category,
    records.map((r) => r.e),
  );
  const originalRole = original ? roleTags(original) : new Map<string, number>();

  const candidates: (Candidate & { proposed: boolean; locality: string; briefOk: boolean })[] =
    records.map(({ e, rank, proposed }) => {
      const l = { ...local.get(e.id)! };
      const locality = l.why;
      // The agent's venue suggestions may be of another kind than the draft's; only unsuitable venues are out.
      const roleOk = roleFits(slot, e, original ?? null, proposed ? null : current.placeCategory, {
        foodAndDrink: isFoodAndDrink(brief.productCategory),
      });
      // An upgrade replaces a choice nothing contradicts, so it must be a local pick: from the
      // city's own country (venues: in it), whoever suggested it.
      const upgradeOk = !input.upgrade || isLocalOrigin(e, domain, ctx.market);
      // With no resolved original to compare against, a partner brand must fit the brief on evidence.
      // An open slot of the evidence-first plan asks this only when the brief has terms to test:
      // a brief that says only "streetwear" can't be matched, and requiring it would rule out every brand.
      const briefFit = fitsBrief(e, brief, {
        requireAttributes:
          slot === "brand_collaboration" && current.resolution !== "resolved" && (!input.initial || briefTerms(brief).size > 0),
      });
      const fits = roleOk && upgradeOk && briefFit.ok;
      if (!roleOk)
        l.why = place ? "not a venue of the planned kind" : "a different kind of business";
      else if (!upgradeOk) l.why = "not from here (an upgrade must be a local pick)";
      else if (!briefFit.ok) l.why = briefFit.why!;
      const role = original
        ? roleSimilarity(originalRole, roleTags(e))
        : { score: 0, shared: [] as string[] };
      const shared = role.shared.map(
        (id) => kindLabel(id) ?? e.tags.find((t) => t.id === id)?.name ?? id,
      );
      const fit = Math.max(0, 1 - (rank - 1) / LIST_SIZE);
      return {
        entity: e,
        fitRank: rank,
        local: l.local && fits,
        localWhy: l.why,
        role: role.score,
        sharedRole: shared,
        proposed,
        locality,
        briefOk: briefFit.ok,
        // v2 orders the shortlist by fused rank; v1 by its blended score.
        score: fused ? fused.get(e.id)!.score : 0.5 * fit + 0.3 * role.score + (l.local ? 0.2 : 0),
      };
    });
  const shortlist = candidates
    .filter((c) => c.local)
    .sort((a, b) => b.score - a.score)
    .slice(0, SHORTLIST);
  const screenRecord = ctx.ledger.add({
    purpose: `Screen candidates for locality in ${ctx.market.label} and for the same job as ${current.label}`,
    queryKind: "locality",
    sanitizedRequest: {
      method: `${ctx.market.label}'s own top list vs 4 other world cities and 4 US cities, plus origin data and the role check`,
      candidates: records.map((r) => r.e.id),
    },
    qlooEntityIds: records.map((r) => r.e.id),
    results: shortlist.map((c) => ({
      id: c.entity.id,
      name: c.entity.displayName,
      rank: c.fitRank,
      popularity: c.entity.popularity ?? undefined,
    })),
    resultCount: candidates.length,
    coverageStatus: shortlist.length ? "usable" : "empty",
    warnings: shortlist.length
      ? []
      : [`No candidate passed the screen: ${screenSummary(candidates)}.`],
  });
  // One trial per screened candidate; the outcome is filled in below as each stage decides it.
  const screened = new Map(
    candidates.map((c) => [
      c.entity.id,
      {
        slot,
        name: c.entity.displayName,
        entityId: c.entity.id,
        source: c.proposed ? ("llm_proposal" as const) : ("qloo_list" as const),
        evidenceIds: [
          ...(fused
            ? lists
                .filter((l) => fused.get(c.entity.id)!.views[l.view] !== undefined)
                .map((l) => l.evidenceId)
            : listIds),
          ...(c.proposed ? proposalIds : []),
          screenRecord.evidenceId,
        ],
        audienceRank: fused ? fused.get(c.entity.id)!.views.audience : c.fitRank,
        views: fused?.get(c.entity.id)?.views,
        fusedRank: fused ? fusedOrder.indexOf(c.entity.id) + 1 : undefined,
        localityResult: c.locality,
        roleFit: original ? c.role : undefined,
        briefFit: c.briefOk ? ("pass" as const) : ("fail" as const),
        screenedOutReason: c.local
          ? shortlist.includes(c)
            ? undefined
            : `Below the shortlist of ${SHORTLIST}`
          : c.localWhy.charAt(0).toUpperCase() + c.localWhy.slice(1),
      } satisfies DraftTrial,
    ]),
  );
  const finish = (proposals: RepairProposal[]): EntityRepair => ({
    proposals,
    trials: [...trials, ...screened.values()],
  });
  if (!shortlist.length) return finish([]);

  const VIEW_NAME: Record<CandidateView, string> = {
    combined: "audience with the plan",
    audience: "audience",
    local: "local list",
    coherence: "fit with the plan",
    proposals: "your suggestions",
  };
  const viewText = (id: string, rank: number) =>
    fused
      ? `${Object.entries(fused.get(id)!.views)
          .map(([v, r]) => `#${r} in ${VIEW_NAME[v as CandidateView]}`)
          .join(", ")} in ${ctx.market.label}`
      : `#${rank} for this audience with the plan in ${ctx.market.label}`;
  const lines = shortlist.map(
    (c) =>
      `id ${c.entity.id}: ${c.entity.displayName}${c.proposed ? " (your suggestion, scored by Qloo)" : ""} — ${viewText(c.entity.id, c.fitRank)}; ${c.localWhy}` +
      (c.sharedRole.length ? `; same role: ${c.sharedRole.slice(0, 4).join(", ")}` : "") +
      (place ? `; kind: ${tagNames(c.entity, "urn:tag:category:place:").join(", ")}` : "") +
      (slot === "brand_collaboration"
        ? `; business: ${tagNames(c.entity, "urn:tag:genre:brand").join(", ")}`
        : "") +
      (c.entity.shortDescription ? `; ${c.entity.shortDescription}` : ""),
  );
  const { data } = await generateStructured(input.llm, {
    schema: rankSchema,
    system: PICK_SYSTEM,
    prompt: [
      briefText(brief, ctx.market),
      input.initial
        ? `Open choice — ${SLOT_LABEL[slot]}: choose for this launch from the candidates below.`
        : `Weak choice — ${SLOT_LABEL[slot]}: ${current.label}. Finding: ${input.assessment.finding}`,
      `Candidates (all checked in Qloo):\n${lines.join("\n")}`,
    ].join("\n\n"),
    label: `repair:${slot}`,
  });
  if (!data.choices.length) {
    ctx.ledger.add({
      purpose: `The model judged that none of the screened candidates can do the job of the ${SLOT_LABEL[slot].toLowerCase()}`,
      queryKind: "locality",
      sanitizedRequest: { candidates: shortlist.map((c) => c.entity.id) },
      qlooEntityIds: shortlist.map((c) => c.entity.id),
      results: shortlist.map((c) => ({ id: c.entity.id, name: c.entity.displayName })),
      resultCount: shortlist.length,
      coverageStatus: "empty",
      warnings: [
        `No candidate passed the screen: the model found none fit the role (${(data.none ?? "no reason given").replace(/\.$/, "")}).`,
      ],
    });
    for (const c of shortlist)
      screened.get(c.entity.id)!.screenedOutReason =
        "The model judged none of the shortlist could do the job";
    return finish([]);
  }
  // Only ids from the shortlist count; an unknown id falls back to the top-ranked candidate.
  const picks = data.choices.flatMap((ch) => {
    const c = shortlist.find((x) => x.entity.id === ch.id.trim());
    return c ? [{ c, reason: ch.reason, expectedEffect: ch.expectedEffect }] : [];
  });
  if (!picks.length)
    picks.push({
      c: shortlist[0],
      reason: "Top-ranked screened candidate (the model's pick wasn't on the list).",
      expectedEffect: data.choices[0].expectedEffect,
    });
  const tried = picks.slice(0, MAX_TRIALS);
  for (const c of shortlist) {
    const t = screened.get(c.entity.id)!;
    const at = picks.findIndex((p) => p.c === c);
    if (at < 0) t.screenedOutReason = "Not among the model's picks";
    else if (at >= MAX_TRIALS) t.screenedOutReason = `Beyond the ${MAX_TRIALS} re-tests per round`;
  }
  return finish(
    tried.map(({ c, reason, expectedEffect }) => ({
      slot,
      after: {
        slot,
        label: c.entity.displayName,
        origin: "agent_repair",
        locked: false,
        resolution: "resolved",
        entity: toRef(c.entity),
        tags: [],
        placeCategory: place
          ? ((c.proposed || input.initial ? categoryOfVenue(c.entity) : null) ?? current.placeCategory)
          : null,
      },
      reason: c.proposed ? `${reason} (Suggested by the agent, then scored in Qloo.)` : reason,
      expectedEffect,
      // Only the views this candidate appeared in, its own scoring if it was a suggestion, and the screen.
      evidenceIds: [...screened.get(c.entity.id)!.evidenceIds],
      considered: shortlist.map((x) => x.entity.displayName),
    })),
  );
}

/** The first suitable category a venue is filed under, to test it among venues of its own kind. */
function categoryOfVenue(e: QlooEntity): string | null {
  return (
    e.tags
      .map((t) => t.id)
      .find((id) => id.startsWith("urn:tag:category:place:") && !UNSUITABLE_VENUE.test(id)) ?? null
  );
}

const directionSchema = z.object({
  tags: z.array(z.string()).describe("1-3 words copied exactly from the list"),
  direction: z.string().describe("the revised creative direction in a few words"),
  reason: z.string().describe("one or two sentences citing the ranks given"),
  expectedEffect: z
    .string()
    .describe(
      "which test should improve in the re-test, in one line; no predictions of sales or engagement",
    ),
});

export async function repairDirection(input: {
  llm: LlmClient;
  ctx: GatherContext;
  brief: LaunchBrief;
  plan: CulturalPlan;
  assessment: ComponentAssessment;
  /** Keep the direction's intent; replace only the words this audience here doesn't lean to. */
  upgrade?: boolean;
  /** Write the evidence-first plan's direction: there is no current direction to revise. */
  initial?: boolean;
}): Promise<RepairProposal | null> {
  const { ctx, plan } = input;
  const current = plan.components.find((c) => c.slot === "creative_direction")!;
  const anchors = plan.anchors.map((a) => a.id);
  if (!anchors.length) return null;
  const lists = await tagList(
    ctx,
    anchors,
    ctx.market.qlooLocation,
    `What this audience in ${ctx.market.label} leans to`,
  );
  const options = lists.flatMap(({ tags }) => tags.slice(0, 15));
  if (!options.length) return null;
  const { data } = await generateStructured(input.llm, {
    schema: directionSchema,
    system:
      (input.initial
        ? "Write a launch's creative direction from what the audience in this city leans to, keeping the brand's attributes. Choose 1-3 words from the list only, copied exactly, ordered by fit."
        : "Revise a launch's creative direction so it matches what the audience in this city leans to, while keeping the brand's attributes. Choose 1-3 words from the list only, copied exactly, ordered by fit.") +
      (input.upgrade
        ? " Keep the current direction's intent: keep any current word that is on the list, and replace only the ones that aren't."
        : ""),
    prompt: [
      briefText(input.brief, ctx.market),
      input.initial
        ? "No direction has been chosen yet."
        : `Current direction: "${current.label}" (${current.tags.map((t) => t.name).join(", ")}). Finding: ${input.assessment.finding}`,
      `This audience's top aesthetics and tones in ${ctx.market.label}, strongest first:\n${options.map((t) => t.name).join(", ")}`,
    ].join("\n\n"),
    label: "repair:direction",
  });
  const byName = new Map(options.map((t) => [nameKey(t.name), t]));
  // Gates, in code: never adopt a tag the brief rules out, and keep every current term this
  // audience already leans to; only the unsupported terms are replaced.
  // A tag is ruled out when all its words are in a ruled-out phrase, or the phrase's are in it:
  // "No industrial looks" rules out "Industrial"; "No luxury" rules out "Luxury".
  const words = (s: string) =>
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
  const banned = ruledOut(input.brief).map(words);
  const allowedTag = (name: string) => {
    const w = words(name);
    return !banned.some((p) => w.every((x) => p.includes(x)) || p.every((x) => w.includes(x)));
  };
  const kept = current.tags
    .filter((t) => byName.has(nameKey(t.name)) && allowedTag(t.name))
    .map((t) => byName.get(nameKey(t.name))!);
  const picked = data.tags
    .flatMap((n) => byName.get(nameKey(n)) ?? [])
    .filter((t) => allowedTag(t.name));
  const tags = [...new Map([...kept, ...picked].map((t) => [t.id, t])).values()].slice(0, 3);
  if (!tags.length || tags.every((t) => kept.includes(t))) return null;
  return {
    slot: "creative_direction",
    after: {
      ...current,
      label: data.direction,
      origin: "agent_repair",
      tags: tags.map((t) => ({ id: t.id, name: t.name })),
      resolution: "resolved",
    },
    reason: data.reason,
    expectedEffect: data.expectedEffect,
    evidenceIds: lists.map((l) => l.record.evidenceId),
    considered: options.slice(0, 8).map((t) => t.name),
  };
}

/** Swap one component; every other component stays exactly as it was. */
export function applyRepair(plan: CulturalPlan, p: RepairProposal): CulturalPlan {
  return { ...plan, components: plan.components.map((c) => (c.slot === p.slot ? p.after : c)) };
}
