import {
  CONTROL_COUNT,
  GLOBAL_PRESENCE,
  SUPERSTAR_POPULARITY,
  cityList,
  isLocalOrigin,
} from "@/lib/engine/equivalents";
import { isForeignOrigin, originCountries } from "@/lib/engine/origin";
import { categoryTags, roleSimilarity, roleTags } from "@/lib/engine/role";
import { mapLimit, nameKey } from "@/lib/engine/stats";
import { controlLocations, sourceLocations, type Domain, type Market } from "@/lib/markets";
import type { QlooClient, QlooEntity } from "@/lib/qloo";
import { domainOf } from "./resolve";

/**
 * One set of checks for any local pick, whoever made it (the engine or the model alone), so
 * the comparison and the evaluation judge both sides by the same Qloo evidence:
 * - local evidence: in the city's own taste list for that kind (and category);
 * - familiar in the source: in another US city's list too, so it isn't a translation;
 * - global: in the lists of two or more other cities, or a worldwide superstar;
 * - foreign: its known origin is another country;
 * - from here: its origin, release country or location is the target country;
 * - role: how much of the original's role (tags) it shares.
 * A pick counts as local when it comes from here, or when it is in the city's list and is
 * neither global nor familiar in the US; either way it must not be of foreign origin.
 */
export interface PickCheck {
  found: boolean;
  entity: QlooEntity | null;
  origins: string[];
  foreign: boolean;
  fromHere: boolean;
  localEvidence: boolean;
  familiarInSource: boolean;
  global: boolean;
  role: number | null;
  /** Passes every locality check for the target market. */
  local: boolean;
}

const placeKey = (name: string) => nameKey(name.split(/\s[-–|@(]\s?|,/)[0]);

/** Find a named pick in Qloo, preferring the stated kind. Exact name (or aka) matches only. */
export async function findByName(
  client: QlooClient,
  name: string,
  domain: Domain | null,
): Promise<QlooEntity | null> {
  const typed = domain
    ? await client.searchEntities({ query: name, types: [`urn:entity:${domain}`], take: 3 })
    : [];
  const hits = typed.length ? typed : await client.searchEntities({ query: name, take: 3 });
  const hit = hits.find((h) =>
    [h.name, h.displayName, ...h.akas].some((n) => nameKey(n) === nameKey(name)),
  );
  if (!hit) return null;
  const [full] = await client.getEntities([hit.id]);
  return full ?? hit;
}

export async function checkPick(
  client: QlooClient,
  input: { pick: QlooEntity | null; anchor: QlooEntity | null; market: Market },
): Promise<PickCheck> {
  const { pick, anchor, market } = input;
  if (!pick) {
    return {
      found: false,
      entity: null,
      origins: [],
      foreign: false,
      fromHere: false,
      localEvidence: false,
      familiarInSource: false,
      global: false,
      role: null,
      local: false,
    };
  }
  const domain = domainOf(pick.type);
  const origins = originCountries(pick);
  const foreign = isForeignOrigin(pick, market.country);
  const fromHere = domain ? isLocalOrigin(pick, domain, market) : false;
  let localEvidence = false;
  let familiarInSource = false;
  let global = domain !== "place" && (pick.popularity ?? 0) >= SUPERSTAR_POPULARITY;
  if (domain) {
    const category = categoryTags(pick, domain);
    const key = (e: QlooEntity) => (domain === "place" ? placeKey(e.name) : e.id);
    const me = key(pick);
    const controls = controlLocations(market, CONTROL_COUNT);
    const sources = sourceLocations(market);
    const cities = [market.qlooLocation, ...controls, ...sources];
    const lists = await mapLimit(cities, 3, (city) => cityList(client, domain, city, category));
    localEvidence = lists[0].some((e) => e.id === pick.id || key(e) === me);
    const controlHits = lists
      .slice(1, 1 + controls.length)
      .filter((l) => l.some((e) => key(e) === me)).length;
    global ||= controlHits >= GLOBAL_PRESENCE;
    familiarInSource = lists.slice(1 + controls.length).some((l) => l.some((e) => key(e) === me));
  }
  const role = anchor ? roleSimilarity(roleTags(anchor), roleTags(pick)).score : null;
  return {
    found: true,
    entity: pick,
    origins,
    foreign,
    fromHere,
    localEvidence,
    familiarInSource,
    global,
    role,
    local: !foreign && (fromHere || (localEvidence && !familiarInSource && !global)),
  };
}
