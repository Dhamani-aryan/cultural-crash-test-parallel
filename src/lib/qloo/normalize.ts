import { QlooError } from "./errors";
import { AGE_BUCKETS } from "./types";
import type {
  AgeBucket,
  CompareResult,
  Demographics,
  CompareTag,
  EntityMatch,
  InsightsEntity,
  InsightsTag,
  InsightsResult,
  QlooEntity,
  TagMatch,
} from "./types";

/**
 * Lenient normalizers for raw Qloo JSON. The docs describe the shapes only loosely, so
 * every field is optional here and missing values become `null` rather than errors.
 * Shapes were confirmed against the live hackathon API.
 */

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const PROMO = /https?:\/\/|www\.|[\w.+-]+@[\w-]+\.[\w.]+|privacy policy|advertis/i;

/**
 * Descriptions are shown to organizers and given to the model, so drop sentences that are
 * links, contact addresses or sponsorship boilerplate (a podcast description included an ad
 * sales email and a privacy-policy URL). Returns null if nothing descriptive is left.
 */
export function cleanDescription(text: string | null): string | null {
  if (!text) return null;
  const kept = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !PROMO.test(sentence));
  const out = kept.join(" ").trim();
  return out.length >= 20 ? out : null;
}

function imageUrl(props: Obj): string | null {
  const image = props.image;
  if (typeof image === "string") return image;
  if (isObj(image)) return str(image.url);
  return null;
}

function tagsOf(raw: Obj): QlooEntity["tags"] {
  return arr(raw.tags).flatMap((t) => {
    if (typeof t === "string") return [{ id: t, name: null, type: null }];
    if (!isObj(t)) return [];
    const id = str(t.tag_id) ?? str(t.id);
    return id ? [{ id, name: str(t.name), type: str(t.type) }] : [];
  });
}

/**
 * Explainability → `{ inputEntityId: score }`. Accepts the observed hackathon shape
 * `{ "signal.interests.entities": [{ entity_id, score | avg_score }] }` as well as the
 * documented map shape `{ entityId: number | { score } }`.
 */
function scoreMap(v: unknown): Record<string, number> | null {
  const out: Record<string, number> = {};
  const fromList = (list: unknown[]) => {
    for (const item of list) {
      if (!isObj(item)) continue;
      const id = str(item.entity_id);
      const score = num(item.score) ?? num(item.avg_score);
      if (id && score !== null) out[id] = score;
    }
  };
  if (Array.isArray(v)) fromList(v);
  else if (isObj(v)) {
    const signal = v["signal.interests.entities"];
    if (Array.isArray(signal)) fromList(signal);
    else {
      for (const [key, value] of Object.entries(v)) {
        const score = num(value) ?? (isObj(value) ? num(value.score) : null);
        if (score !== null) out[key] = score;
      }
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Aggregate influence: prefer the broadest `effect_on_*` list (e.g. all over top3). */
function aggregateMap(v: unknown): Record<string, number> | null {
  const e = obj(v);
  const signal = e["signal.interests.entities"];
  if (isObj(signal)) {
    const keys = Object.keys(signal).filter((k) => Array.isArray(signal[k]));
    const best = keys.find((k) => k.includes("all")) ?? keys.sort().at(-1);
    return best ? scoreMap(signal[best]) : null;
  }
  return scoreMap(e.all) ?? scoreMap(e.top_10);
}

/** Akas come as `{ language, value }` or `{ languages: [...], value }`. */
function akasOf(props: Obj): { value: string; languages: string[] }[] {
  return arr(props.akas).flatMap((a) => {
    if (typeof a === "string") return [{ value: a, languages: [] }];
    if (!isObj(a) || !str(a.value)) return [];
    const languages = [str(a.language), ...arr(a.languages).map(str)].filter(
      (l): l is string => l !== null,
    );
    return [{ value: str(a.value)!, languages }];
  });
}

const LATIN = /^[\p{Script=Latin}\p{N}\p{P}\p{S}\s]+$/u;

/** Prefer the name itself when it is Latin script, else an English (or any Latin) aka. */
export function pickDisplayName(
  name: string,
  akas: { value: string; languages: string[] }[],
): string {
  if (LATIN.test(name)) return name;
  const latin = akas.filter((a) => LATIN.test(a.value));
  const english = latin.find((a) => a.languages.some((l) => l === "en" || l.startsWith("en_")));
  return (english ?? latin[0])?.value ?? name;
}

export function normalizeEntity(raw: unknown): QlooEntity | null {
  if (!isObj(raw)) return null;
  const id = str(raw.entity_id) ?? str(raw.id);
  const name = str(raw.name);
  if (!id || !name) return null;
  const props = obj(raw.properties);
  const geo = isObj(props.geocode) ? props.geocode : null;
  // Coordinates come in the top-level `location` ({ lat, lon }), not in properties.geocode.
  const loc = isObj(raw.location) ? raw.location : null;
  const akas = akasOf(props);
  const releaseCountry = props.release_country;
  return {
    id,
    name,
    displayName: pickDisplayName(name, akas),
    akas: [...new Set(akas.map((a) => a.value))],
    akaLanguages: akas.filter((a) => a.languages.length > 0),
    releaseCountries: (Array.isArray(releaseCountry) ? releaseCountry : [releaseCountry])
      .map(str)
      .filter((c): c is string => c !== null),
    type: str(raw.type) ?? str(arr(raw.types)[0]),
    subtype: str(raw.subtype),
    description: cleanDescription(str(props.description) ?? str(props.short_description)),
    shortDescription: cleanDescription(str(props.short_description)),
    imageUrl: imageUrl(props),
    popularity: num(raw.popularity),
    disambiguation: str(raw.disambiguation),
    geocode:
      geo || loc
        ? {
            city: geo ? str(geo.city) : null,
            metro: geo ? str(geo.metro) : null,
            countryCode: geo ? str(geo.country_code) : null,
            latitude: (geo ? num(geo.latitude) : null) ?? (loc ? num(loc.lat) : null),
            longitude: (geo ? num(geo.longitude) : null) ?? (loc ? num(loc.lon) : null),
            neighborhood: neighborhoodOf(geo),
          }
        : null,
    tags: tagsOf(raw),
  };
}

/** A place's geocode name when it names something below the city (a neighbourhood), else null. */
function neighborhoodOf(geo: Obj | null): string | null {
  const name = geo ? str(geo.name) : null;
  if (!name || !geo) return null;
  const above = [geo.city, geo.metro, geo.admin1_region, geo.admin2_region, geo.country].map((x) => str(x)?.toLowerCase());
  return above.includes(name.toLowerCase()) ? null : name;
}

function requireSuccess(body: unknown, path: string): Obj {
  if (!isObj(body)) throw new QlooError("invalid_response", path, null, "expected a JSON object");
  if (body.success === false) {
    throw new QlooError("bad_request", path, null, str(obj(body.error).message) ?? "success=false");
  }
  return body;
}

export function normalizeSearch(body: unknown): EntityMatch[] {
  const b = requireSuccess(body, "/search");
  const results = Array.isArray(b.results) ? b.results : arr(obj(b.results).entities);
  return results.flatMap((raw, i) => {
    const e = normalizeEntity(raw);
    return e ? [{ ...e, rank: i + 1 }] : [];
  });
}

export function normalizeInsights(body: unknown): InsightsResult {
  const b = requireSuccess(body, "/v2/insights");
  const results = obj(b.results);
  const entities: InsightsEntity[] = arr(results.entities).flatMap((raw, i) => {
    const e = normalizeEntity(raw);
    if (!e) return [];
    const q = obj((raw as Obj).query);
    return [
      {
        ...e,
        rank: i + 1,
        affinity: num(q.affinity),
        affinityRank: num(q.affinity_rank),
        explainability: scoreMap(q.explainability),
      },
    ];
  });
  const tags: InsightsTag[] = arr(results.tags).flatMap((raw, i) => {
    if (!isObj(raw)) return [];
    const id = str(raw.tag_id) ?? str(raw.id);
    const name = str(raw.name);
    if (!id || !name) return [];
    return [
      {
        id,
        name: name.trim(),
        subtype: str(raw.subtype),
        popularity: num(raw.popularity),
        affinity: num(obj(raw.query).affinity),
        rank: i + 1,
      },
    ];
  });
  return {
    entities,
    tags,
    aggregateExplainability: aggregateMap(obj(b.query).explainability),
    durationMs: num(results.duration) ?? num(b.duration),
  };
}

export function normalizeEntities(body: unknown): QlooEntity[] {
  if (!isObj(body))
    throw new QlooError("invalid_response", "/entities", null, "expected an object");
  const results = Array.isArray(body.results) ? body.results : arr(obj(body.results).entities);
  return results.flatMap((raw) => normalizeEntity(raw) ?? []);
}

export function normalizeDemographics(body: unknown): Demographics[] {
  const b = requireSuccess(body, "/v2/insights");
  return arr(obj(b.results).demographics).flatMap((d) => {
    if (!isObj(d) || !str(d.entity_id)) return [];
    const q = obj(d.query);
    const ageRaw = obj(q.age);
    const age = Object.fromEntries(AGE_BUCKETS.map((k) => [k, num(ageRaw[k]) ?? 0])) as Record<
      AgeBucket,
      number
    >;
    return [{ entityId: str(d.entity_id)!, age, femaleSkew: num(obj(q.gender).female) ?? 0 }];
  });
}

export function normalizeTags(body: unknown): TagMatch[] {
  const b = requireSuccess(body, "/v2/tags");
  const tags = Array.isArray(b.results) ? b.results : arr(obj(b.results).tags);
  return tags.flatMap((t) => {
    if (!isObj(t)) return [];
    const id = str(t.id) ?? str(t.tag_id);
    const name = str(t.name);
    if (!id || !name) return [];
    const parents = arr(t.parents).flatMap((p) =>
      typeof p === "string" ? [p] : isObj(p) && str(p.type) ? [str(p.type)!] : [],
    );
    return [{ id, name, type: str(t.type) ?? str(t.subtype), parents }];
  });
}

/** Compare tags repeat once per supporting seed pair, so merge them by tag ID. */
function compareTags(list: unknown[]): CompareTag[] {
  const byId = new Map<string, CompareTag>();
  for (const t of list) {
    if (!isObj(t)) continue;
    const id = str(t.tag_id) ?? str(t.id);
    const name = str(t.name);
    if (!id || !name) continue;
    const q = obj(t.query);
    const ids = (side: string) =>
      arr(q[`${side}.signal.interests.entities`]).flatMap((e) =>
        isObj(e) && str(e.entity_id) ? [str(e.entity_id)!] : [],
      );
    const tag = byId.get(id) ?? {
      id,
      name,
      subtype: str(t.subtype),
      popularity: num(t.popularity),
      score: null,
      count: null,
      aEntityIds: [],
      bEntityIds: [],
    };
    const score = num(q.score);
    if (score !== null) tag.score = Math.max(tag.score ?? 0, score);
    const count = Number(q.count);
    if (Number.isFinite(count)) tag.count = Math.max(tag.count ?? 0, count);
    tag.aEntityIds = [...new Set([...tag.aEntityIds, ...ids("a")])];
    tag.bEntityIds = [...new Set([...tag.bEntityIds, ...ids("b")])];
    byId.set(id, tag);
  }
  return [...byId.values()].sort((x, y) => (y.score ?? 0) - (x.score ?? 0));
}

export function normalizeCompare(body: unknown): CompareResult {
  const b = requireSuccess(body, "/v2/analysis/compare");
  const r = obj(b.results);
  return {
    sharedTags: compareTags(arr(r.tags)),
    aTags: compareTags(arr(r.a)),
    bTags: compareTags(arr(r.b)),
    matchEntities: arr(r.matchEntities).flatMap((raw) => normalizeEntity(raw) ?? []),
    raw: b.results ?? null,
    durationMs: num(b.duration),
  };
}
