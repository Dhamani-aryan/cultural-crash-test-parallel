import { z } from "zod";
import { domainOf } from "@/lib/agent/resolve";
import { isLocalOrigin } from "@/lib/engine/equivalents";
import { countriesIn, originCountries } from "@/lib/engine/origin";
import { mapLimit, nameKey } from "@/lib/engine/stats";
import { generateStructured } from "@/lib/llm/structured";
import type { LlmClient } from "@/lib/llm/types";
import { SOURCE_MARKET, type Market } from "@/lib/markets";
import type { QlooClient, QlooEntity } from "@/lib/qloo";
import { tagList, type GatherContext } from "./gather";
import {
  SLOTS,
  type Component,
  type CulturalPlan,
  type EntityRef,
  type LaunchBrief,
  type Slot,
  type TagRef,
} from "./types";

/**
 * The first draft. The model turns the brief into a plan from general knowledge: the audience
 * anchors, a choice for every slot the brief left open, and a creative direction. That is
 * exactly what an LLM alone would launch with, so it doubles as the baseline. Everything it
 * names is then resolved in Qloo; nothing unresolved is tested as if it were real.
 */

/** Venue categories a pop-up can be tested in (each checked live to return London venues). */
export const PLACE_CATEGORIES = [
  "clothing_store",
  "event_venue",
  "live_music_venue",
  "night_club",
  "record_store",
  "art_gallery",
  "cultural_center",
  "bar",
  "market",
  "skateboard_park",
  "concert_hall",
  "shoe_store",
] as const;
const placeTag = (c: string) => `urn:tag:category:place:${c}`;

const draftSchema = z.object({
  anchors: z
    .array(z.string())
    .describe("2-4 brands or artists, by exact name, whose fans are the target audience"),
  artist: z.string().describe("music act for the launch, exact name"),
  brand: z
    .string()
    .describe(
      "collaboration brand: another existing brand, never the launching brand itself; exact name",
    ),
  venue: z.string().describe("pop-up venue in the city, exact name as it is known"),
  venueCategory: z.enum(PLACE_CATEGORIES),
  direction: z.string().describe("creative direction in a few words: aesthetic and tone"),
  assumptions: z
    .array(z.string())
    .describe("assumptions you made because the brief left something open"),
  countries: z
    .object({
      anchors: z.array(z.string()).describe("country of each audience anchor, in the same order"),
      artist: z.string(),
      brand: z.string(),
    })
    .optional()
    .describe("the country each named act or brand is from, as a country name"),
});
export type Draft = z.infer<typeof draftSchema>;

const fallbackAnchorsSchema = z.object({
  anchors: z
    .array(z.object({ name: z.string(), country: z.string() }))
    .describe("3-4 established brands or artists whose fans match the described audience"),
});

const DRAFT_SYSTEM = `You are a brand strategist planning a launch. Draft the cultural choices for the brief: a music act, a collaboration brand, a pop-up venue in the city and a creative direction, plus 2-4 brands or artists whose fans stand for the target audience. Use real, specific names exactly as they are usually written. Keep any choice the brief already makes. Never include a name the brief excludes. List the assumptions you made where the brief is silent. For each audience anchor, the act and the brand, give the country it is from, so the right one is looked up. Do not mention data sources.`;

export function briefText(brief: LaunchBrief, market: Market): string {
  const lines = [
    `Brand: ${brief.brandName || "(unnamed)"} — ${brief.productCategory}`,
    `Goal: ${brief.launchGoal}`,
    brief.sourceText ? `User's original description: ${brief.sourceText}` : "",
    `City: ${market.label}`,
    `Audience: ${brief.audienceDescription}`,
    brief.audienceAnchors.length ? `Audience is fans of: ${brief.audienceAnchors.join(", ")}` : "",
    brief.brandAttributes.length ? `Brand attributes: ${brief.brandAttributes.join(", ")}` : "",
    brief.budgetBand ? `Budget: ${brief.budgetBand}` : "",
    ...brief.existingChoices.map((c) => `Already chosen (${c.slot}): ${c.name}`),
    ...brief.constraints.map(
      (c) => `${c.kind === "hard" ? "Hard" : "Soft"} constraint: ${c.description}`,
    ),
  ];
  return lines.filter(Boolean).join("\n");
}

export async function draftPlan(
  llm: LlmClient,
  brief: LaunchBrief,
  market: Market,
): Promise<Draft> {
  const { data } = await generateStructured(llm, {
    schema: draftSchema,
    system: DRAFT_SYSTEM,
    prompt: briefText(brief, market),
    label: "draft",
  });
  // The brief's own choices always win over the model's.
  const given = (slot: Slot) => brief.existingChoices.find((c) => c.slot === slot)?.name;
  return {
    ...data,
    anchors: brief.audienceAnchors.length ? brief.audienceAnchors : data.anchors.slice(0, 4),
    artist: given("artist_music") ?? data.artist,
    brand: given("brand_collaboration") ?? data.brand,
    venue: given("event_place") ?? data.venue,
    direction: given("creative_direction") ?? data.direction,
  };
}

export const toRef = (e: QlooEntity): EntityRef => ({
  id: e.id,
  name: e.displayName,
  type: e.type,
  popularity: e.popularity,
  imageUrl: e.imageUrl,
  shortDescription: e.shortDescription,
});

/**
 * An artist or brand by exact name, preferring the one from the target market. Names collide
 * ("Divine" is a Mumbai rapper and an American performer); the first search hit is often the
 * wrong one for the city, which poisons every test after it.
 */
export async function findInMarket(
  client: QlooClient,
  name: string,
  domains: ("artist" | "brand")[],
  market: Market,
): Promise<QlooEntity | null> {
  const k = nameKey(name);
  const hits = (
    await Promise.all(
      domains.map((d) =>
        client.searchEntities({ query: name, types: [`urn:entity:${d}`], take: 8 }),
      ),
    )
  ).flat();
  const exact = hits
    .filter((h) => [h.name, h.displayName, ...h.akas].some((n) => nameKey(n) === k))
    .slice(0, 6);
  if (!exact.length) return null;
  const full = await client.getEntities([...new Set(exact.map((h) => h.id))]);
  const records = exact.map((h) => full.find((f) => f.id === h.id) ?? h);
  const local = (e: QlooEntity) => {
    const d = domainOf(e.type);
    return d ? isLocalOrigin(e, d, market) : false;
  };
  return [...records].sort(
    (a, b) => Number(local(b)) - Number(local(a)) || (b.popularity ?? 0) - (a.popularity ?? 0),
  )[0];
}

/**
 * Whether a resolved entity is a namesake of the one meant: Qloo's only "Divine" is an American
 * performer, not DIVINE the Mumbai rapper. When the model says where a name is from and Qloo
 * places the match in another country, the match is the wrong one. Returns why, or null.
 */
export function namesake(e: QlooEntity, expectedCountry: string | undefined): string | null {
  const expected = expectedCountry ? countriesIn(expectedCountry)[0] : undefined;
  if (!expected) return null;
  const origins = originCountries(e);
  if (!origins.length || origins.includes(expected)) return null;
  return e.shortDescription ?? `Qloo's ${e.displayName} is from ${origins.join(", ")}`;
}

/** A venue by name, in the target city. Chains share names, so the city must match. */
export async function findPlace(
  client: QlooClient,
  name: string,
  market: Market,
): Promise<QlooEntity | null> {
  const hits = await client.searchEntities({
    query: `${name} ${market.qlooLocation}`,
    types: ["urn:entity:place"],
    take: 5,
  });
  const inCity = hits.filter((h) => h.geocode?.countryCode?.toUpperCase() === market.country);
  const k = nameKey(name);
  const hit =
    inCity.find((h) => nameKey(h.name) === k) ??
    inCity.find((h) => nameKey(h.name).startsWith(k) || k.startsWith(nameKey(h.name)));
  if (!hit) return null;
  const [full] = await client.getEntities([hit.id]);
  return full ?? hit;
}

/**
 * The category a named venue is tested in: one of the event-friendly kinds it is filed under in
 * Qloo, else the kind the plan asked for. Testing BOXPARK Shoreditch among "clothing stores"
 * because the draft said so hides it; testing it among its own kind doesn't.
 */
export function categoryOf(e: QlooEntity, fallback: string): string {
  const cats = e.tags.filter((t) => t.id.startsWith("urn:tag:category:place:")).map((t) => t.id);
  return cats.find((c) => PLACE_CATEGORIES.some((p) => c === placeTag(p))) ?? placeTag(fallback);
}

export async function resolveEntityComponent(
  client: QlooClient,
  slot: Exclude<Slot, "creative_direction">,
  name: string,
  market: Market,
  meta: Pick<Component, "origin" | "locked">,
  venueCategory = "event_venue",
  expectedCountry?: string,
): Promise<Component> {
  const e =
    slot === "event_place"
      ? await findPlace(client, name, market)
      : await findInMarket(client, name, [slot === "artist_music" ? "artist" : "brand"], market);
  const other = e ? namesake(e, expectedCountry) : null;
  if (e && other) {
    return {
      slot,
      label: name,
      ...meta,
      resolution: "ambiguous",
      entity: null,
      tags: [],
      placeCategory: null,
      note: other,
    };
  }
  return {
    slot,
    label: e?.displayName ?? name,
    ...meta,
    resolution: e ? "resolved" : "not_found",
    entity: e ? toRef(e) : null,
    tags: [],
    placeCategory:
      slot === "event_place" ? (e ? categoryOf(e, venueCategory) : placeTag(venueCategory)) : null,
  };
}

// ---------- creative direction → Qloo tags ----------

const tagSchema = z.object({
  tags: z.array(z.string()).describe("1-3 names copied exactly from the vocabulary"),
  note: z.string().describe("one line: how well the vocabulary covers the direction"),
});

/**
 * The words Qloo uses for aesthetics and tone. A fixed, geographically diverse reference panel
 * keeps the vocabulary stable as launch markets are added and prevents expansion increasing the
 * cost of every run.
 */
export async function directionVocabulary(
  ctx: GatherContext,
  anchors: string[],
): Promise<Map<string, TagRef>> {
  const cities = ["Tokyo", "London", "Mumbai", "São Paulo", "Madrid", SOURCE_MARKET.qlooLocation];
  const lists = await mapLimit(cities, 2, (city) =>
    tagList(ctx, anchors, city, `Vocabulary: what this audience leans to in ${city}`),
  );
  const vocab = new Map<string, TagRef>();
  for (const { tags } of lists.flat())
    for (const t of tags) vocab.set(nameKey(t.name), { id: t.id, name: t.name });
  return vocab;
}

export async function mapDirection(
  llm: LlmClient,
  direction: string,
  vocab: Map<string, TagRef>,
): Promise<{ tags: TagRef[]; note: string }> {
  const names = [...new Set([...vocab.values()].map((t) => t.name))].sort();
  const { data } = await generateStructured(llm, {
    schema: tagSchema,
    system:
      "Map a creative direction onto a fixed vocabulary of aesthetic and tone words. Pick the 1-3 words that say the same thing. Copy them exactly. Do not invent words; if nothing fits, pick the closest and say so in the note.",
    prompt: `Direction: "${direction}"\n\nVocabulary:\n${names.join(", ")}`,
    label: "direction",
  });
  const tags = data.tags.flatMap((n) => vocab.get(nameKey(n)) ?? []).slice(0, 3);
  return { tags: [...new Map(tags.map((t) => [t.id, t])).values()], note: data.note };
}

/** Resolve the draft into a plan of Qloo entities and tags. */
export async function buildPlan(input: {
  llm: LlmClient;
  ctx: GatherContext;
  brief: LaunchBrief;
  draft: Draft;
  origin: Component["origin"];
}): Promise<{ plan: CulturalPlan; notes: string[] }> {
  const { llm, ctx, brief, draft } = input;
  const notes: string[] = [];
  const anchorHits = await mapLimit(draft.anchors, 2, async (name) => {
    const i = draft.anchors.indexOf(name);
    const e = await findInMarket(ctx.client, name, ["brand", "artist"], ctx.market);
    if (!e) notes.push(`Audience anchor "${name}" isn't in Qloo and was left out.`);
    const other = e ? namesake(e, draft.countries?.anchors[i]) : null;
    if (other) {
      notes.push(
        `Audience anchor "${name}" was left out: Qloo only has a different one (${other}).`,
      );
      return null;
    }
    return e;
  });
  let anchors = anchorHits.filter((e): e is QlooEntity => e !== null).map(toRef);
  ctx.ledger.add({
    purpose: "Resolve the audience anchors to Qloo entities",
    queryKind: "search",
    sanitizedRequest: { queries: draft.anchors, types: ["urn:entity:brand", "urn:entity:artist"] },
    qlooEntityIds: anchors.map((a) => a.id),
    results: anchors.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type ?? undefined,
      popularity: a.popularity ?? undefined,
    })),
    resultCount: anchors.length,
    coverageStatus: anchors.length >= 2 ? "usable" : anchors.length ? "partial" : "empty",
    warnings: notes.slice(),
  });

  // When the user supplied only a natural-language audience and every model-proposed anchor is
  // absent from Qloo, make one bounded attempt with broader anchors. Never substitute anchors the
  // user explicitly named, and never continue if the fallback also has no measurable entities.
  if (!anchors.length && !brief.audienceAnchors.length) {
    const { data } = await generateStructured(llm, {
      schema: fallbackAnchorsSchema,
      system:
        "Suggest broader, established audience anchors for measurement. Use real brands or music artists with exact commonly used names. They must represent the audience described, not the launch venue or the launching brand. Avoid the failed names. Return 3-4 names and each one's country.",
      prompt: `${briefText(brief, ctx.market)}\n\nFailed anchors: ${draft.anchors.join(", ")}`,
      label: "anchors:fallback",
    });
    const fallbackHits = await mapLimit(data.anchors.slice(0, 4), 2, async ({ name, country }) => {
      const entity = await findInMarket(ctx.client, name, ["brand", "artist"], ctx.market);
      return entity && !namesake(entity, country) ? entity : null;
    });
    anchors = fallbackHits.filter((e): e is QlooEntity => e !== null).map(toRef);
    const tried = data.anchors.map((a) => a.name);
    ctx.ledger.add({
      purpose: "Retry unresolved audience anchors with broader measurable references",
      queryKind: "search",
      sanitizedRequest: { queries: tried, types: ["urn:entity:brand", "urn:entity:artist"] },
      qlooEntityIds: anchors.map((a) => a.id),
      results: anchors.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type ?? undefined,
        popularity: a.popularity ?? undefined,
      })),
      resultCount: anchors.length,
      coverageStatus: anchors.length >= 2 ? "usable" : anchors.length ? "partial" : "empty",
      warnings: anchors.length ? [] : ["The broader fallback anchors were also absent from Qloo."],
    });
    if (anchors.length)
      notes.push(
        `Broader audience anchors were used because Qloo didn't know ${draft.anchors.join(", ")}.`,
      );
  }

  const locked = (slot: Slot) =>
    brief.constraints.some((c) => c.kind === "hard" && c.lockSlot === slot);
  const meta = (slot: Slot) => ({
    origin: brief.existingChoices.some((c) => c.slot === slot)
      ? ("user_provided" as const)
      : input.origin,
    locked: locked(slot),
  });
  const ownBrand = brief.brandName ? nameKey(brief.brandName) : null;
  if (ownBrand && nameKey(draft.brand) === ownBrand)
    notes.push(
      `The draft named the launching brand itself as its collaborator; that isn't a choice to test.`,
    );
  const [artist, brandResolved, venue] = await Promise.all([
    resolveEntityComponent(
      ctx.client,
      "artist_music",
      draft.artist,
      ctx.market,
      meta("artist_music"),
      undefined,
      draft.countries?.artist,
    ),
    resolveEntityComponent(
      ctx.client,
      "brand_collaboration",
      draft.brand,
      ctx.market,
      meta("brand_collaboration"),
      undefined,
      draft.countries?.brand,
    ),
    resolveEntityComponent(
      ctx.client,
      "event_place",
      draft.venue,
      ctx.market,
      meta("event_place"),
      draft.venueCategory,
    ),
  ]);
  const brand: Component =
    ownBrand && nameKey(draft.brand) === ownBrand
      ? { ...brandResolved, resolution: "not_found", entity: null, label: draft.brand }
      : brandResolved;
  const resolved = [artist, brand, venue];
  ctx.ledger.add({
    purpose: "Resolve the plan's choices to Qloo entities",
    queryKind: "search",
    sanitizedRequest: {
      queries: [draft.artist, draft.brand, `${draft.venue} ${ctx.market.qlooLocation}`],
      types: ["urn:entity:artist", "urn:entity:brand", "urn:entity:place"],
    },
    qlooEntityIds: resolved.flatMap((c) => (c.entity ? [c.entity.id] : [])),
    results: resolved.flatMap((c) =>
      c.entity ? [{ id: c.entity.id, name: c.entity.name, type: c.entity.type ?? undefined }] : [],
    ),
    resultCount: resolved.filter((c) => c.entity).length,
    coverageStatus: resolved.every((c) => c.entity) ? "usable" : "partial",
    warnings: resolved.filter((c) => !c.entity).map((c) => `"${c.label}" not found in Qloo.`),
  });

  let direction: Component = {
    slot: "creative_direction",
    label: draft.direction,
    ...meta("creative_direction"),
    resolution: "not_found",
    entity: null,
    tags: [],
    placeCategory: null,
  };
  if (anchors.length) {
    const vocab = await directionVocabulary(
      ctx,
      anchors.map((a) => a.id),
    );
    const mapped = await mapDirection(llm, draft.direction, vocab);
    direction = {
      ...direction,
      tags: mapped.tags,
      resolution: mapped.tags.length ? "resolved" : "not_found",
    };
    if (mapped.note) notes.push(`Creative direction: ${mapped.note}`);
  }
  const components = [artist, brand, venue, direction];
  return {
    plan: { anchors, components: SLOTS.map((s) => components.find((c) => c.slot === s)!) },
    notes,
  };
}
