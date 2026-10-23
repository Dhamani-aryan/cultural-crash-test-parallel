import { resolveEntityComponent } from "@/lib/crashtest/plan";
import type { LaunchBrief } from "@/lib/crashtest/types";
import type { Market } from "@/lib/markets";
import type { QlooClient } from "@/lib/qloo";
import type { IdentityFact } from "./types";

/**
 * Cheap preflight identity checks, before any U/L/A generation: a named act or brand whose only
 * Qloo match is a namesake from another country (the existing namesake protection) becomes an
 * identity fact for the gate. Venues are matched within the city already. `countries` is the
 * shared reading of where each named act or brand is from (see userChoiceCountries).
 */
export async function identityFacts(client: QlooClient, brief: LaunchBrief, market: Market, countries: Map<string, string>): Promise<IdentityFact[]> {
  const facts: IdentityFact[] = [];
  for (const c of brief.existingChoices) {
    if (c.slot !== "artist_music" && c.slot !== "brand_collaboration") continue;
    const expectedCountry = countries.get(c.name.trim().toLowerCase());
    if (!expectedCountry) continue;
    const comp = await resolveEntityComponent(client, c.slot, c.name, market, { origin: "user_provided", locked: false }, undefined, expectedCountry);
    if (comp.resolution === "ambiguous") facts.push({ slot: c.slot, name: c.name, expectedCountry, qlooDescription: comp.note ?? "a namesake from another country" });
  }
  return facts;
}
