import coverage from "../../data/coverage.json";

/**
 * The markets Transcreate supports. We launch only where Qloo's taste data is deep and
 * city-specific enough to trust (measured and stored in data/coverage.json). Each domain
 * gets a confidence grade; references in an "off" domain
 * are flagged for a human instead of translated.
 */

export const DOMAINS = ["artist", "tv_show", "movie", "brand", "place"] as const;
export type Domain = (typeof DOMAINS)[number];

export const DOMAIN_LABEL: Record<Domain, string> = {
  artist: "Music",
  tv_show: "TV",
  movie: "Film",
  brand: "Brands",
  place: "Places",
};

export type Confidence = "strong" | "usable" | "off";

export interface Market {
  id: string;
  /** Name passed to Qloo's `signal.location.query` / `filter.location.query`. */
  qlooLocation: string;
  label: string;
  country: string;
  /** Country names as they appear in Qloo's `release_country`, for the origin check. */
  releaseCountryNames: string[];
  language: string;
  /** ISO 639-1 codes of the city's languages, to pick the local title of a show or film. */
  languageCodes: string[];
  /** Common districts that still unambiguously identify this supported city during intake. */
  locationAliases?: string[];
}

/** The default comparison side for launches outside New York. */
export const SOURCE_MARKET: Market = {
  id: "us",
  qlooLocation: "New York City",
  label: "United States",
  country: "US",
  releaseCountryNames: ["United States", "United States of America"],
  language: "English",
  languageCodes: ["en"],
};

export const TARGET_MARKETS: Market[] = [
  {
    id: "new-york",
    qlooLocation: "New York City",
    label: "New York",
    country: "US",
    releaseCountryNames: ["United States", "United States of America"],
    language: "English",
    languageCodes: ["en"],
    locationAliases: ["NYC", "Manhattan", "Lower East Side", "Brooklyn", "SoHo"],
  },
  {
    id: "tokyo",
    qlooLocation: "Tokyo",
    label: "Tokyo",
    country: "JP",
    releaseCountryNames: ["Japan"],
    language: "Japanese",
    languageCodes: ["ja"],
    locationAliases: ["Omotesando", "Shimokitazawa", "Shibuya", "Harajuku"],
  },
  {
    id: "london",
    qlooLocation: "London",
    label: "London",
    country: "GB",
    releaseCountryNames: ["United Kingdom"],
    language: "British English",
    languageCodes: ["en"],
    locationAliases: ["Dalston", "Marylebone", "Shoreditch", "East London"],
  },
  {
    id: "mumbai",
    qlooLocation: "Mumbai",
    label: "Mumbai",
    country: "IN",
    releaseCountryNames: ["India"],
    language: "Hindi / English",
    languageCodes: ["hi", "en"],
  },
  {
    id: "sao-paulo",
    qlooLocation: "São Paulo",
    label: "São Paulo",
    country: "BR",
    releaseCountryNames: ["Brazil"],
    language: "Portuguese",
    languageCodes: ["pt"],
  },
  {
    id: "madrid",
    qlooLocation: "Madrid",
    label: "Madrid",
    country: "ES",
    releaseCountryNames: ["Spain"],
    language: "Spanish",
    languageCodes: ["es"],
  },
  {
    id: "mexico-city",
    qlooLocation: "Mexico City",
    label: "Mexico City",
    country: "MX",
    releaseCountryNames: ["Mexico"],
    language: "Spanish",
    languageCodes: ["es"],
    locationAliases: ["CDMX", "Roma Norte", "Condesa", "Polanco"],
  },
  {
    id: "toronto",
    qlooLocation: "Toronto",
    label: "Toronto",
    country: "CA",
    releaseCountryNames: ["Canada"],
    language: "English",
    languageCodes: ["en"],
    locationAliases: ["Queen West", "Ossington", "Yorkville"],
  },
  {
    id: "sydney",
    qlooLocation: "Sydney",
    label: "Sydney",
    country: "AU",
    releaseCountryNames: ["Australia"],
    language: "English",
    languageCodes: ["en"],
    locationAliases: ["Surry Hills", "Newtown", "Paddington"],
  },
  {
    id: "paris",
    qlooLocation: "Paris",
    label: "Paris",
    country: "FR",
    releaseCountryNames: ["France"],
    language: "French",
    languageCodes: ["fr"],
    locationAliases: ["Le Marais", "Canal Saint-Martin", "Montmartre"],
  },
  {
    id: "berlin",
    qlooLocation: "Berlin",
    label: "Berlin",
    country: "DE",
    releaseCountryNames: ["Germany"],
    language: "German",
    languageCodes: ["de"],
    locationAliases: ["Kreuzberg", "Neukölln", "Mitte"],
  },
];

/** Cities used as the "everywhere else" baseline when measuring how local a candidate is. */
export const CONTROL_LOCATIONS = ["London", "Tokyo", "Mumbai", "São Paulo", "Paris", "Madrid"];

/** US cities used to detect choices already familiar in the default source market. */
export const SOURCE_LOCATIONS = ["New York City", "Los Angeles", "Chicago", "San Francisco"];

/**
 * The cultural contrast used by the direction and proposal-skew checks. New York is normally
 * the source-market baseline; a New York launch uses London so it is never compared with itself.
 */
export function contrastLocation(market: Market): string {
  return market.qlooLocation === SOURCE_MARKET.qlooLocation ? "London" : SOURCE_MARKET.qlooLocation;
}

/** Control cities for a market, with the target and duplicates removed before applying a limit. */
export function controlLocations(market: Market, take?: number): string[] {
  const locations = [...new Set(CONTROL_LOCATIONS.filter((city) => city !== market.qlooLocation))];
  return take === undefined ? locations : locations.slice(0, take);
}

/** US familiarity controls, excluding the target when the launch itself is in a US source city. */
export function sourceLocations(market: Market): string[] {
  return [...new Set(SOURCE_LOCATIONS.filter((city) => city !== market.qlooLocation))];
}

type CityCoverage = Record<string, { distinct?: number; categoryDepth?: number }>;

/**
 * Grade from the measured coverage. Media and brands use distinctiveness (does Qloo know a
 * culture specific to this city?); places use category depth (are there enough venues?).
 */
export function gradeFromCoverage(domain: Domain, c: CityCoverage | undefined): Confidence {
  if (!c) return "off";
  if (domain === "place") {
    const depth = c.place?.categoryDepth ?? 0;
    return depth >= 0.45 ? "strong" : depth >= 0.3 ? "usable" : "off";
  }
  const distinct = c[domain]?.distinct ?? 0;
  return distinct >= 0.8 ? "strong" : distinct >= 0.4 ? "usable" : "off";
}

/**
 * Overrides where measured translation quality disagrees with raw coverage.
 */
const OVERRIDES: Partial<Record<string, Partial<Record<Domain, Confidence>>>> = {};

export function confidence(market: Market, domain: Domain): Confidence {
  const override = OVERRIDES[market.id]?.[domain];
  if (override) return override;
  const cities = coverage.cities as Record<string, CityCoverage>;
  return gradeFromCoverage(domain, cities[market.qlooLocation]);
}

export function marketById(id: string): Market | undefined {
  return TARGET_MARKETS.find((m) => m.id === id);
}
