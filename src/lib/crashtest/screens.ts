import { nameKey } from "@/lib/engine/stats";
import type { QlooEntity } from "@/lib/qloo";
import { wantsFormat, type IntentContract } from "./intent";
import { venueFormat } from "./repair";

/**
 * Brief-aware screens, shared by the agent's candidate screening and by the evidence matrix that
 * scores every track's plans, so a rule never applies to one plan and not another. Each is
 * deterministic, reads only the brief-intent contract and Qloo's own records, and returns
 * "unknown" when the evidence isn't there. Soft screens shape ranking and explanations; the
 * hard rules of the brief are elsewhere and stay vetoes. v2: neighbourhood fit reads Qloo's own
 * neighbourhood label and the coordinates Qloo returns (v1 never received coordinates). v3: 2–6 km
 * from a named neighbourhood is outside it, not unknown.
 */
export const SCREENS_VERSION = "screens:v3";

const cat = (c: string) => `urn:tag:category:place:${c}`;

/** Venue categories that suit the formats the brief asks for, plus general event spaces. */
export function preferredCategories(contract: IntentContract, foodAndDrink: boolean): string[] {
  const out = new Set(["event_venue", "cultural_center", "art_gallery", "exhibition_center"].map(cat));
  const add = (...c: string[]) => c.forEach((x) => out.add(cat(x)));
  if (wantsFormat(contract, "showroom", "exhibition")) add("art_gallery", "museum", "exhibition_center", "boutique");
  if (wantsFormat(contract, "live_music", "listening_party", "festival", "party")) add("live_music_venue", "night_club", "concert_hall", "bar", "record_store");
  if (wantsFormat(contract, "pop_up", "store_opening", "workshop", "product_drop")) add("clothing_store", "boutique", "shoe_store", "market", "community_center");
  if (wantsFormat(contract, "bar", "food_and_drink") || foodAndDrink) add("bar", "cafe", "restaurant", "coffee_shop");
  if (wantsFormat(contract, "community")) add("community_center", "park", "market");
  return [...out];
}

/**
 * How plausibly a venue hosts this launch: filed as a kind the brief's formats call for
 * ("preferred"), as another kind that can host an event ("possible"), as one that can't
 * ("unsuitable": lodging, transport, medical), or Qloo doesn't say ("unknown").
 */
export function hostTier(tagIds: string[], contract: IntentContract, foodAndDrink: boolean): "preferred" | "possible" | "unsuitable" | "unknown" {
  const format = venueFormat(tagIds, foodAndDrink || wantsFormat(contract, "bar", "food_and_drink"));
  if (format === "unsuitable") return "unsuitable";
  const preferred = new Set(preferredCategories(contract, foodAndDrink));
  if (tagIds.some((t) => preferred.has(t))) return "preferred";
  return format === "can_host" ? "possible" : "unknown";
}

export interface Centroid {
  name: string;
  lat: number;
  lon: number;
  /** Venues the centroid was taken from. */
  count: number;
  evidenceId: string;
}

export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const dLat = r(b.lat - a.lat);
  const dLon = r(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/**
 * Is a venue in the neighbourhood the brief names? Qloo filing it under that neighbourhood, or
 * lying within 2 km of the neighbourhood's point, is near; 2–6 km is outside it; beyond 6 km is
 * far. Without coordinates it is unknown: a different neighbourhood label alone never counts against it.
 */
export function neighborhoodFit(
  e: Pick<QlooEntity, "geocode"> | undefined,
  c: Centroid | null,
  hood?: string,
): { km: number | null; fit: "near" | "outside" | "far" | "unknown"; named: boolean } {
  const label = e?.geocode?.neighborhood;
  const named = !!hood && !!label && nameKey(label) === nameKey(hood);
  const km = c && e?.geocode?.latitude != null && e.geocode.longitude != null ? distanceKm({ lat: e.geocode.latitude, lon: e.geocode.longitude }, c) : null;
  if (named) return { km, fit: "near", named };
  if (km === null) return { km, fit: "unknown", named };
  return { km, fit: km <= 2 ? "near" : km > 6 ? "far" : "outside", named };
}

/** Top-0.5% popularity: a mainstream default. It counts against a choice only when the brief asks for distinctiveness. */
export const MAINSTREAM = 0.995;
export function mainstreamFlag(popularity: number | null | undefined, contract: IntentContract): boolean {
  return contract.wantsDistinctive && (popularity ?? 0) >= MAINSTREAM;
}

/** Headline-scale acts (top 0.2%) and arena-type venues can make the launch about something else. */
const HEADLINE = 0.998;
const BIG_ROOMS = /^urn:tag:category:place:(stadium|arena|concert_hall|amphitheater)/;
export function centralityFlag(slot: "artist_music" | "brand_collaboration" | "event_place" | "creative_direction", e: Pick<QlooEntity, "popularity" | "tags"> | undefined, contract: IntentContract): string | null {
  if (!e || wantsFormat(contract, "festival")) return null;
  if (slot === "artist_music" && (e.popularity ?? 0) >= HEADLINE)
    return "a headline-scale act can turn a product launch into a concert";
  if (slot === "event_place" && e.tags.some((t) => BIG_ROOMS.test(t.id)))
    return "an arena-scale room can make the product an afterthought";
  return null;
}

/** Words too general to tell what a brief avoids ("another brand", "using references"). */
const VAGUE = new Set(
  "another other being becoming using simply relying creating feeling looking working brand brands clothing product products event events launch thing things could would anywhere world references attention popular standard impressive afterthought added musician".split(" "),
);
/** The content words of the brief's avoidances: "the usual beach-party aesthetic" → beach, party. */
export function avoidedWords(contract: IntentContract): string[] {
  const words = contract.negative.flatMap((n) => n.value.toLowerCase().split(/[^\p{L}]+/u)).filter((w) => w.length >= 5 && !VAGUE.has(w));
  return [...new Set(words.filter((w) => !["aesthetic", "imagery", "generic", "usual", "predictable", "typical", "mainstream", "celebrity", "unrelated"].includes(w)))];
}

/** Does Qloo's own description of a candidate name something the brief avoids? */
export function avoidedMatch(e: Pick<QlooEntity, "tags" | "shortDescription" | "description"> | undefined, contract: IntentContract): string | null {
  if (!e) return null;
  const text = [e.shortDescription ?? "", e.description ?? "", ...e.tags.map((t) => `${t.name ?? ""} ${t.id.split(":").at(-1)?.replace(/_/g, " ") ?? ""}`)].join(" ").toLowerCase();
  const hit = avoidedWords(contract).find((w) => new RegExp(`\\b${w}\\b`).test(text));
  return hit ? hit : null;
}

/** The agent model's structured role reading of one candidate (a screen, not evidence of affinity). */
export interface RoleCheck {
  verdict: "fits" | "doubtful" | "wrong";
  /** False when the model reads it as overshadowing the product. */
  central: boolean;
  reason: string;
  evidenceId: string;
}
