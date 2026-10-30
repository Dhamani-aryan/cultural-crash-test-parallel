import { describe, expect, it } from "vitest";
import {
  cleanDescription,
  normalizeCompare,
  normalizeInsights,
  normalizeSearch,
  normalizeTags,
  trimListingTitle,
} from "@/lib/qloo/normalize";
import { fixture } from "./helpers";

describe("normalizeInsights", () => {
  const r = normalizeInsights(fixture("insights-movie"));

  it("keeps valid entities in rank order and drops ones without IDs", () => {
    expect(r.entities.map((e) => e.id)).toEqual(["FAKE-MOVIE-0001", "FAKE-MOVIE-0002"]);
    expect(r.entities.map((e) => e.rank)).toEqual([1, 2]);
  });

  it("reads affinity, popularity, image and tags", () => {
    const [one, two] = r.entities;
    expect(one).toMatchObject({
      affinity: 0.91,
      affinityRank: 1,
      popularity: 0.62,
      imageUrl: "https://example.test/one.jpg",
      description: "A made-up film used only in tests.",
    });
    expect(one.tags[0]).toEqual({
      id: "urn:tag:genre:test:drama",
      name: "Drama",
      type: "urn:tag:genre",
    });
    expect(two.imageUrl).toBe("https://example.test/two.jpg");
    expect(two.tags[0].id).toBe("urn:tag:genre:test:comedy");
    expect(two.affinityRank).toBeNull();
  });

  it("reads explainability in the list shape the hackathon API returns", () => {
    expect(r.entities[0].explainability).toEqual({ "FAKE-SEED-A1": 0.7, "FAKE-SEED-B1": 0.3 });
    expect(r.entities[1].explainability).toBeNull();
    expect(r.aggregateExplainability).toEqual({ "FAKE-SEED-A1": 0.55, "FAKE-SEED-B1": 0.45 });
    expect(r.durationMs).toBe(120);
  });
});

describe("normalizeSearch", () => {
  it("reads the top-level results array and the types list", () => {
    const r = normalizeSearch(fixture("search"));
    expect(r[0]).toMatchObject({
      id: "FAKE-ARTIST-0001",
      type: "urn:entity:artist",
      disambiguation: "Made-up band",
      rank: 1,
    });
    expect(r[1].rank).toBe(2);
  });
});

describe("normalizeTags", () => {
  it("reads tags and their parent types in either format", () => {
    expect(normalizeTags(fixture("tags"))).toEqual([
      {
        id: "urn:tag:keyword:test:coming_of_age",
        name: "Coming of age",
        type: "urn:tag:keyword",
        parents: ["urn:entity:movie"],
      },
      {
        id: "urn:tag:genre:test:folk",
        name: "Folk",
        type: "urn:tag:genre",
        parents: ["urn:entity:artist"],
      },
    ]);
  });
});

describe("normalizeCompare", () => {
  const r = normalizeCompare(fixture("compare"));

  it("merges repeated shared tags and unions their supporting seeds", () => {
    expect(r.sharedTags.map((t) => t.name)).toEqual(["Soul", "Identity"]);
    expect(r.sharedTags[0]).toMatchObject({
      score: 0.95,
      aEntityIds: ["FAKE-SEED-A1", "FAKE-SEED-A2"],
      bEntityIds: ["FAKE-SEED-B1"],
    });
  });

  it("reads one-sided tags with their counts", () => {
    expect(r.aTags[0]).toMatchObject({ name: "Youth", count: 4, score: null });
    expect(r.bTags).toEqual([]);
  });
});

describe("cleanDescription", () => {
  it("drops links, contact addresses and ad boilerplate but keeps the description", () => {
    const raw =
      "Join a host and guests as they chat about whatever. Comedy sketches and music. " +
      "Help us improve: https://bit.ly/x  For advertising opportunities please email ads@studio.com " +
      "Privacy Policy: https://example.com/privacy";
    expect(cleanDescription(raw)).toBe(
      "Join a host and guests as they chat about whatever. Comedy sketches and music.",
    );
    expect(cleanDescription("See https://example.com")).toBeNull();
    expect(cleanDescription(null)).toBeNull();
  });
});

describe("place coordinates and neighbourhood", () => {
  // The shape the hackathon API returns for a place: coordinates in the top-level `location`,
  // the address breakdown (with the neighbourhood as its name) in properties.geocode.
  const place = (geocode: Record<string, unknown> | undefined, location?: Record<string, unknown>) =>
    normalizeInsights({
      success: true,
      results: {
        entities: [
          {
            name: "Fake Hall",
            entity_id: "FAKE-PLACE-0001",
            type: "urn:entity:place",
            properties: geocode ? { geocode } : {},
            ...(location ? { location } : {}),
          },
        ],
      },
    }).entities[0];
  const nyc = { city: "New York", name: "Lower East Side", metro: "New York City", country: "United States", country_code: "US", admin1_region: "New York", admin2_region: "New York County" };

  it("reads latitude and longitude from the top-level location", () => {
    expect(place(nyc, { lat: 40.7222, lon: -73.9874, geohash: "dr5rsm" }).geocode).toEqual({
      city: "New York",
      metro: "New York City",
      countryCode: "US",
      latitude: 40.7222,
      longitude: -73.9874,
      neighborhood: "Lower East Side",
    });
    // Coordinates alone still give a geocode; no coordinates stay null.
    expect(place(undefined, { lat: 1, lon: 2 }).geocode).toMatchObject({ latitude: 1, longitude: 2, countryCode: null, neighborhood: null });
    expect(place(nyc).geocode).toMatchObject({ latitude: null, longitude: null });
    expect(place(undefined).geocode).toBeNull();
  });

  it("takes the geocode name as a neighbourhood only when it names something below the city", () => {
    expect(place({ ...nyc, name: "New York" }).geocode!.neighborhood).toBeNull();
    expect(place({ ...nyc, name: "New York County" }).geocode!.neighborhood).toBeNull();
    expect(place({ city: "Sydney", name: "Bondi Beach", country_code: "AU" }).geocode!.neighborhood).toBe("Bondi Beach");
  });
});

describe("trimListingTitle", () => {
  it("keeps a place's own name from a listing-style title", () => {
    expect(trimListingTitle("Galerie Joseph - 116 rue de Turenne | Location showroom Pop up store Paris")).toBe("Galerie Joseph");
    expect(trimListingTitle("Studio North | Event space hire")).toBe("Studio North");
  });
  it("leaves ordinary names alone", () => {
    expect(trimListingTitle("Le Carreau du Temple")).toBe("Le Carreau du Temple");
    expect(trimListingTitle("Carreau du Temple / dance")).toBe("Carreau du Temple / dance");
    expect(trimListingTitle("Run-DMC")).toBe("Run-DMC");
    expect(trimListingTitle("Blink - 182")).toBe("Blink - 182");
  });
});
