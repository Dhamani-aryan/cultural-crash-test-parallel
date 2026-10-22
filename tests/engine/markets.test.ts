import { describe, expect, it } from "vitest";
import {
  DOMAINS,
  TARGET_MARKETS,
  confidence,
  contrastLocation,
  gradeFromCoverage,
  marketById,
  sourceLocations,
} from "@/lib/markets";

describe("markets", () => {
  it("grades media by distinctiveness and places by category depth", () => {
    expect(gradeFromCoverage("artist", { artist: { distinct: 0.9 } })).toBe("strong");
    expect(gradeFromCoverage("movie", { movie: { distinct: 0.45 } })).toBe("usable");
    expect(gradeFromCoverage("movie", { movie: { distinct: 0.2 } })).toBe("off");
    expect(gradeFromCoverage("place", { place: { categoryDepth: 0.5 } })).toBe("strong");
    expect(gradeFromCoverage("place", { place: { categoryDepth: 0.1 } })).toBe("off");
    expect(gradeFromCoverage("brand", undefined)).toBe("off");
  });

  it("has a measured grade for every launch market and domain", () => {
    for (const m of TARGET_MARKETS) {
      const grades = DOMAINS.map((d) => confidence(m, d));
      // A launch market must be usable in most domains, or it shouldn't be a launch market.
      expect(grades.filter((g) => g !== "off").length).toBeGreaterThanOrEqual(4);
    }
  });

  it("supports New York without comparing it with itself", () => {
    const market = marketById("new-york")!;
    expect(contrastLocation(market)).toBe("London");
    expect(sourceLocations(market)).not.toContain("New York City");
  });
});
