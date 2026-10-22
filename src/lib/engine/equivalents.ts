import {
  contrastLocation,
  controlLocations,
  sourceLocations,
  confidence,
  type Confidence,
  type Domain,
  type Market,
} from "@/lib/markets";
import { AGE_BUCKETS, type Demographics, type QlooClient, type QlooEntity } from "@/lib/qloo";
import { isForeignOrigin, originCountries } from "./origin";
import { categoryTags, kindLabel, roleSimilarity, roleTags } from "./role";
import { chunk, clamp01, cosine, mapLimit, nameKey } from "./stats";

/**
 * The equivalence engine: given a reference (the anchor) and a target market, find the local
 * entities that do the same job for a similar audience there. Deterministic: the same Qloo
 * answers always give the same ranking. The agent may also propose names it knows; each must
 * be found in Qloo and pass the same gates (including being in the city's own list for its
 * kind), so the model widens the search but never decides what counts as local.
 *
 *   pool      top results for a location-only signal in the target city (+ broad category
 *             for brands and places)
 *   locality  how few control cities also have the candidate in their own top results
 *   gates     not global (in several cities' lists, or a worldwide superstar), not already
 *             familiar in the US, not of foreign origin, not a foreign TV/film release
 *   role      weighted Jaccard over role tags (genre, values, segment, tone…)
 *   audience  cosine of age/gender skews
 *   fame      position in the target city's list: will people there recognise it?
 *
 * Why not compare affinities across cities: under a location signal Qloo leaves out entities
 * that aren't distinctive there, so a missing score means "unknown", not "absent". Presence
 * in other cities' top lists is the robust test (and those lists are shared, so cacheable).
 */

// Fame weighs as much as it does because the evaluation showed obscure-but-local picks lose to
// iconic ones: a reference only works if readers recognise it.
export const WEIGHTS = { role: 0.4, locality: 0.2, audience: 0.1, fame: 0.3 } as const;
export const POOL_PAGES = 2;
export const CONTROL_COUNT = 4;
/** In this many control cities' top lists = known everywhere, not a local equivalent. */
export const GLOBAL_PRESENCE = 2;
/**
 * Qloo popularity is a worldwide (US-weighted) percentile. The biggest local stars top out
 * around 0.997 (Utada Hikaru, Caetano Veloso, Rosalía); global stars sit at 0.999+ (Bieber,
 * Shakira, Coldplay). Above this, an entity is known everywhere, so it isn't a local swap.
 */
export const SUPERSTAR_POPULARITY = 0.998;
/** Two entities with identical audience skews and this much role overlap are the same one. */
export const SAME_ENTITY_ROLE = 0.5;

export interface ScoreParts {
  role: number;
  locality: number;
  audience: number | null;
  fame: number;
}

export interface Equivalent {
  entity: QlooEntity;
  score: number;
  parts: ScoreParts;
  /** Role tags shared with the anchor, as names, strongest first (for the evidence card). */
  sharedTags: string[];
  /** Rank in the target city's list (1 = most distinctive there) and the list length. */
  localRank: number;
  poolSize: number;
  /** Control cities whose top lists also contain it. */
  alsoIn: string[];
  /** The agent suggested it; Qloo confirmed it is local. */
  proposed: boolean;
}

export type RejectReason =
  | "global"
  | "familiar_in_source"
  | "foreign_origin"
  | "foreign_release"
  | "duplicate"
  | "no_local_evidence";

export interface EquivalentsResult {
  anchorId: string;
  marketId: string;
  domain: Domain;
  confidence: Confidence;
  equivalents: Equivalent[];
  rejected: { name: string; reason: RejectReason; proposed?: boolean }[];
  /** Whether the original itself is already in the city's list, or known everywhere. */
  anchor: { inCity: boolean; global: boolean };
  poolSize: number;
  qlooCalls: number;
}

export interface FindInput {
  /** The anchor as a full record (from `getEntities`), so all its tags are present. */
  anchor: QlooEntity;
  domain: Domain;
  market: Market;
  take?: number;
  /** Extra entity IDs to keep out (e.g. other references already used in the text). */
  exclude?: string[];
  /** Entities the agent suggested (full records). */
  proposals?: QlooEntity[];
}

const demoVector = (d: Demographics | undefined) =>
  d ? [...AGE_BUCKETS.map((k) => d.age[k]), d.femaleSkew] : null;

/** Chain stores share a name across cities ("Starbucks - Juhu"), so places compare by brand name. */
const chainKey = (name: string) => nameKey(name.split(/\s[-–|@(]\s?|,/)[0]);

/** The top results for one city: the target pool, or a control list for the global check. */
export async function cityList(
  client: QlooClient,
  domain: Domain,
  location: string,
  category: string[],
): Promise<QlooEntity[]> {
  const pages = await mapLimit(
    Array.from({ length: POOL_PAGES }, (_, i) => i + 1),
    POOL_PAGES,
    (page) =>
      client.getInsights({
        filterType: `urn:entity:${domain}`,
        signalLocationQuery: location,
        filterLocationQuery: domain === "place" ? location : undefined,
        filterTags: category.length ? category : undefined,
        filterTagsOperator: category.length ? "union" : undefined,
        take: 50,
        page,
      }),
  );
  return pages.flatMap((p) => p.entities);
}

interface PoolItem {
  entity: QlooEntity;
  rank: number;
  listSize: number;
  alsoIn: string[];
  inSource: boolean;
  proposed: boolean;
}

export async function findEquivalents(
  client: QlooClient,
  input: FindInput,
): Promise<EquivalentsResult> {
  const { anchor, domain, market } = input;
  const take = input.take ?? 3;
  const grade = confidence(market, domain);
  const result: EquivalentsResult = {
    anchorId: anchor.id,
    marketId: market.id,
    domain,
    confidence: grade,
    equivalents: [],
    rejected: [],
    anchor: { inCity: false, global: false },
    poolSize: 0,
    qlooCalls: 0,
  };
  if (grade === "off") return result;

  // 1. City lists per category: the target pool, the control cities (global check) and the
  //    US cities (familiarity check). One set per category, shared across anchors.
  const controls = controlLocations(market, CONTROL_COUNT);
  const sources = sourceLocations(market);
  const cities = [market.qlooLocation, ...controls, ...sources];
  const keyOf = (e: QlooEntity) => (domain === "place" ? chainKey(e.name) : e.id);
  const listSets = new Map<string, Promise<QlooEntity[][]>>();
  const listsFor = (category: string[]) => {
    const k = category.join(",");
    if (!listSets.has(k)) {
      result.qlooCalls += cities.length * POOL_PAGES;
      listSets.set(
        k,
        mapLimit(cities, 3, (city) => cityList(client, domain, city, category)),
      );
    }
    return listSets.get(k)!;
  };
  const presence = async (entity: QlooEntity, category: string[]) => {
    const lists = await listsFor(category);
    const key = keyOf(entity);
    const same = (e: QlooEntity) => e.id === entity.id || keyOf(e) === key;
    return {
      rank: lists[0].findIndex(same) + 1,
      listSize: lists[0].length,
      alsoIn: controls.filter((_, i) => lists[1 + i].some(same)),
      inSource: lists.slice(1 + controls.length).some((l) => l.some(same)),
    };
  };
  // Places are physically local, so a worldwide-famous landmark (Hyde Park) is exactly the
  // equivalent we want; the superstar gate applies to media, people and brands only.
  const superstar = (e: QlooEntity) =>
    domain !== "place" && (e.popularity ?? 0) >= SUPERSTAR_POPULARITY;

  const category = categoryTags(anchor, domain);
  const lists = await listsFor(category);
  let targetList = lists[0];
  if (domain === "place") {
    // Places are pinned to the city by the location filter, so co-affinity with the anchor is
    // safe here and finds the famous landmarks a "distinctive" list can miss (Hyde Park).
    result.qlooCalls++;
    const liked = await client.getInsights({
      filterType: "urn:entity:place",
      signalEntities: [anchor.id],
      filterLocationQuery: market.qlooLocation,
      filterTags: category.length ? category : undefined,
      filterTagsOperator: category.length ? "union" : undefined,
      take: 50,
    });
    const have = new Set(targetList.map((e) => e.id));
    targetList = [...targetList, ...liked.entities.filter((e) => !have.has(e.id))];
  }
  const anchorAt = await presence(anchor, category);
  result.anchor = {
    inCity: anchorAt.rank > 0,
    global: anchorAt.alsoIn.length >= GLOBAL_PRESENCE || superstar(anchor),
  };
  const controlSets = lists.slice(1, 1 + controls.length).map((l) => new Set(l.map(keyOf)));
  const sourceSet = new Set(lists.slice(1 + controls.length).flatMap((l) => l.map(keyOf)));

  // 2. The agent's proposals. Knowing a name isn't evidence that people there care about it,
  //    so each needs one of: it comes from here (origin, release country, or a place in the
  //    city's country), or Qloo's affinity for it is higher under the city's location signal
  //    than under New York's.
  const proposedIds = new Set((input.proposals ?? []).map((p) => p.id));
  const extra: PoolItem[] = [];
  const outside = (input.proposals ?? []).filter(
    (p) =>
      p.type === `urn:entity:${domain}` &&
      p.id !== anchor.id &&
      !targetList.some((e) => e.id === p.id),
  );
  const skew = outside.length ? await affinitySkew(client, domain, market, outside) : new Map();
  result.qlooCalls += outside.length ? 2 : 0;
  for (const p of outside) {
    if (!isLocalOrigin(p, domain, market) && !skew.get(p.id)) {
      result.rejected.push({ name: p.displayName, reason: "no_local_evidence", proposed: true });
      continue;
    }
    extra.push({
      entity: p,
      rank: 0,
      listSize: targetList.length,
      alsoIn: controls.filter((_, c) => controlSets[c].has(keyOf(p))),
      inSource: sourceSet.has(keyOf(p)),
      proposed: true,
    });
  }

  // 3. Clean the pool: drop the anchor, repeats and the same entity under another name.
  const candidates: PoolItem[] = [
    ...targetList.map((entity, i) => ({
      entity,
      rank: i + 1,
      listSize: targetList.length,
      alsoIn: controls.filter((_, c) => controlSets[c].has(keyOf(entity))),
      inSource: sourceSet.has(keyOf(entity)),
      proposed: proposedIds.has(entity.id),
    })),
    ...extra,
  ];
  const excluded = new Set([anchor.id, ...(input.exclude ?? [])]);
  const seenIds = new Set<string>();
  const seenNames = new Set([
    nameKey(anchor.displayName),
    nameKey(anchor.name),
    ...anchor.akas.map(nameKey),
  ]);
  const pool: PoolItem[] = [];
  for (const item of candidates) {
    const { entity } = item;
    if (excluded.has(entity.id) || seenIds.has(entity.id)) continue;
    seenIds.add(entity.id);
    const keys = [entity.displayName, entity.name, ...entity.akas].map(nameKey).filter(Boolean);
    if (keys.some((k) => seenNames.has(k))) {
      result.rejected.push({ name: entity.displayName, reason: "duplicate" });
      continue;
    }
    keys.forEach((k) => seenNames.add(k));
    pool.push(item);
  }
  result.poolSize = targetList.length;
  if (pool.length === 0) return result;

  // 4. Full records. Insights results omit Wikipedia categories and key markets, which carry
  //    both the origin (Pizza Hut is American) and what kind of thing it is (a doughnut shop).
  //    Proposals already are full records.
  const partial = pool.filter((p) => !extra.includes(p));
  for (const batch of chunk(partial, 50)) {
    result.qlooCalls++;
    const full = new Map(
      (await client.getEntities(batch.map((p) => p.entity.id))).map((e) => [e.id, e]),
    );
    for (const item of batch) {
      const record = full.get(item.entity.id);
      if (!record) continue;
      item.entity = {
        ...item.entity,
        tags: record.tags.length ? record.tags : item.entity.tags,
        description: record.description ?? item.entity.description,
        shortDescription: record.shortDescription ?? item.entity.shortDescription,
        releaseCountries: record.releaseCountries.length
          ? record.releaseCountries
          : item.entity.releaseCountries,
      };
    }
  }

  // 5. Audience skews (anchor first). Identical skews also reveal one person under two names.
  const demos = new Map<string, Demographics>();
  for (const batch of chunk([anchor.id, ...pool.map((p) => p.entity.id)], 50)) {
    result.qlooCalls++;
    for (const d of await client.getDemographics(batch)) demos.set(d.entityId, d);
  }
  const anchorDemo = demoVector(demos.get(anchor.id));
  const seenDemos = new Map<string, Map<string, number>>();
  const kept: { key: string; role: Map<string, number> }[] = [];

  // 6. Gates and score parts.
  const anchorRole = roleTags(anchor);
  const tagName = new Map<string, string>();
  for (const t of [...anchor.tags, ...pool.flatMap((p) => p.entity.tags)]) {
    if (t.name) tagName.set(t.id, t.name);
  }
  const scored: Equivalent[] = [];
  for (const { entity, rank, listSize, alsoIn, inSource, proposed } of pool) {
    const reject = (reason: RejectReason) =>
      result.rejected.push({
        name: entity.displayName,
        reason,
        ...(proposed ? { proposed } : {}),
      });
    const demo = demoVector(demos.get(entity.id));
    const entityRole = roleTags(entity);
    // Same audience skew to the last decimal *and* largely the same tags: one entity listed
    // twice (e.g. "Jin Akanishi" and "赤西仁"). The skew alone isn't enough, because sparse
    // entities can share a default skew.
    const demoKey = demo && demo.some((x) => x !== 0) ? demo.join(",") : null;
    const twin = demoKey ? seenDemos.get(demoKey) : undefined;
    if (twin && roleSimilarity(twin, entityRole).score >= SAME_ENTITY_ROLE) {
      reject("duplicate");
      continue;
    }
    if (demoKey && !twin) seenDemos.set(demoKey, entityRole);
    // "Anushka" and "Anushka Manchanda": one name extends the other and the tags agree.
    const key = nameKey(entity.displayName);
    const extended = kept.find(
      (k) =>
        (key.startsWith(k.key) || k.key.startsWith(key)) &&
        Math.min(key.length, k.key.length) >= 4 &&
        roleSimilarity(k.role, entityRole).score >= SAME_ENTITY_ROLE,
    );
    if (extended) {
      reject("duplicate");
      continue;
    }
    kept.push({ key, role: entityRole });

    // From here beats known elsewhere: Rosalía is the Spanish answer to Taylor Swift even
    // though the whole world knows her. The global and US checks are for imports.
    const local = isLocalOrigin(entity, domain, market);
    if (!local && (alsoIn.length >= GLOBAL_PRESENCE || superstar(entity))) {
      reject("global");
      continue;
    }
    if (!local && inSource) {
      reject("familiar_in_source");
      continue;
    }
    if (isForeignOrigin(entity, market.country)) {
      reject("foreign_origin");
      continue;
    }
    if (
      (domain === "tv_show" || domain === "movie") &&
      entity.releaseCountries.length > 0 &&
      !entity.releaseCountries.some((c) => market.releaseCountryNames.includes(c))
    ) {
      reject("foreign_release");
      continue;
    }

    const role = roleSimilarity(anchorRole, entityRole);
    const sharedNames = [
      ...new Set(
        role.shared
          .sort((a, b) => (anchorRole.get(b) ?? 0) - (anchorRole.get(a) ?? 0))
          .map((id) => kindLabel(id) ?? tagName.get(id) ?? id),
      ),
    ];
    scored.push({
      entity,
      score: 0,
      parts: {
        role: role.score,
        locality: 1 - alsoIn.length / (controls.length || 1),
        audience: anchorDemo && demo ? clamp01((cosine(anchorDemo, demo) + 1) / 2) : null,
        // For places, how famous the landmark is matters more than how distinctive it is;
        // proposals outside the city's list have no rank, so they use popularity too.
        fame:
          domain === "place" || rank === 0
            ? (entity.popularity ?? 0)
            : 1 - (rank - 1) / Math.max(1, listSize - 1),
      },
      sharedTags: sharedNames.slice(0, 6),
      localRank: rank,
      poolSize: listSize,
      alsoIn,
      proposed,
    });
  }

  // Role Jaccard is small in absolute terms (~100 tags each side), so each part is scaled to
  // the pool's range before weighting. Unknown audience counts as the pool's middle.
  const scaler = (values: number[]) => {
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    return (x: number) => (hi > lo ? (x - lo) / (hi - lo) : 1);
  };
  const role = scaler(scored.map((s) => s.parts.role));
  const audienceKnown = scored.map((s) => s.parts.audience).filter((a): a is number => a !== null);
  const audience = scaler(audienceKnown.length ? audienceKnown : [0]);
  for (const s of scored) {
    s.score =
      WEIGHTS.role * role(s.parts.role) +
      WEIGHTS.locality * s.parts.locality +
      WEIGHTS.audience * (s.parts.audience === null ? 0.5 : audience(s.parts.audience)) +
      WEIGHTS.fame * s.parts.fame;
  }
  scored.sort((a, b) => b.score - a.score || a.localRank - b.localRank);
  // The agent always sees its own suggestions that passed every gate, even below the cut:
  // role tags separate chains only weakly, and the agent judges fit in the sentence.
  const top = scored.slice(0, take);
  result.equivalents = [...top, ...scored.slice(take).filter((s) => s.proposed)];
  return result;
}

/**
 * Known to come from the target market: origin tags or nationality, a TV/film release there,
 * or a place located in that country.
 */
export function isLocalOrigin(entity: QlooEntity, domain: Domain, market: Market): boolean {
  if (domain === "place") return entity.geocode?.countryCode?.toUpperCase() === market.country;
  if (
    (domain === "tv_show" || domain === "movie") &&
    entity.releaseCountries.some((c) => market.releaseCountryNames.includes(c))
  ) {
    return true;
  }
  return originCountries(entity).includes(market.country);
}

/**
 * Whether each entity leans towards the city: present under the city's location signal with
 * a higher affinity than under New York's (or absent in New York). Under a location signal
 * Qloo omits entities that aren't distinctive there, so absence in both means "unknown".
 */
async function affinitySkew(
  client: QlooClient,
  domain: Domain,
  market: Market,
  entities: QlooEntity[],
): Promise<Map<string, boolean>> {
  const ids = entities.map((e) => e.id).slice(0, 50);
  const scores = async (location: string) => {
    const r = await client.getInsights({
      filterType: `urn:entity:${domain}`,
      signalLocationQuery: location,
      resultEntities: ids,
      take: ids.length,
    });
    return new Map(r.entities.map((e) => [e.id, e.affinity ?? 0]));
  };
  const [city, source] = await Promise.all([
    scores(market.qlooLocation),
    scores(contrastLocation(market)),
  ]);
  return new Map(
    ids.map((id) => [id, city.has(id) && (!source.has(id) || city.get(id)! > source.get(id)!)]),
  );
}
