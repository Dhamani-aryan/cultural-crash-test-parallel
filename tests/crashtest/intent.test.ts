import { describe, expect, it } from "vitest";
import { compileIntent } from "@/lib/crashtest/intent";
import { LaunchBriefSchema, type LaunchBriefInput } from "@/lib/crashtest/types";
import { marketById } from "@/lib/markets";
import { SCENARIOS } from "../../eval/scenario-cases";

const contract = (b: Partial<LaunchBriefInput> & Pick<LaunchBriefInput, "marketId">) =>
  compileIntent(
    LaunchBriefSchema.parse({ productCategory: "Streetwear", launchGoal: "Pop-up launch", audienceDescription: "Fans", ...b }),
    marketById(b.marketId)!,
    { names: [], source: "none" },
  );
const prompt = (id: string) => SCENARIOS.find((s) => s.id === id)!.prompt;

describe("brief-intent contract", () => {
  it("cites the exact phrase behind every item, and invents nothing", () => {
    const brief = { marketId: "sydney", sourceText: prompt("sun-care-sydney"), productCategory: "Sun care", launchGoal: "Pop-up launch" };
    const c = contract(brief);
    const items = [c.city, c.product, ...c.neighborhoods, ...c.formats, ...c.positive, ...c.negative, ...c.attributes];
    for (const i of items) expect(i.phrase.length, JSON.stringify(i)).toBeGreaterThan(0);
    // Every phrase is found, word for word, in the field it cites.
    const text: Record<string, string> = { sourceText: brief.sourceText, launchGoal: brief.launchGoal, productCategory: brief.productCategory, audienceDescription: "Fans" };
    for (const i of [...c.neighborhoods, ...c.formats, ...c.positive, ...c.negative]) expect(text[i.field], JSON.stringify(i)).toContain(i.phrase);
    // A brief that states no quality gets none.
    expect(contract({ marketId: "london" }).positive).toEqual([]);
  });

  it("reads Bondi as the named place, the event formats and the 'usual beach-party' avoidance", () => {
    const c = contract({ marketId: "sydney", sourceText: prompt("sun-care-sydney") });
    expect(c.neighborhoods.map((n) => n.value)).toEqual(["Bondi"]);
    expect(c.formats.map((f) => f.value)).toEqual(expect.arrayContaining(["workshop", "live_music", "community"]));
    // "Party" appears only in what the brief avoids, so it isn't a wanted format.
    expect(c.formats.map((f) => f.value)).not.toContain("party");
    expect(c.negative).toHaveLength(1);
    expect(c.negative.map((n) => n.phrase).join(" | ")).toMatch(/beach-party aesthetic/);
    expect(c.wantsDistinctive).toBe(true);
    expect(c.positive.map((p) => p.value)).toEqual(expect.arrayContaining(["authentic", "distinctive"]));
  });

  it("divides named choices into locked, preferred and merely considered", () => {
    const c = contract({
      marketId: "new-york",
      sourceText: prompt("streetwear-new-york"),
      existingChoices: [{ slot: "artist_music", name: "Princess Nokia" }, { slot: "event_place", name: "Pioneer Works" }],
      constraints: [{ id: "l", description: "Keep Pioneer Works", kind: "hard", lockSlot: "event_place" }],
    });
    expect(c.choices.find((x) => x.name === "Princess Nokia")!.strength).toBe("considered");
    expect(c.choices.find((x) => x.name === "Pioneer Works")!.strength).toBe("locked");
    expect(c.neighborhoods.map((n) => n.value)).toContain("Lower East Side");
    expect(c.wantsDistinctive).toBe(true);
  });

  it("never treats a quality the brief negates as asked for", () => {
    const c = contract({ marketId: "london", sourceText: "We want it to feel premium, not mainstream and not generic." });
    expect(c.positive.map((p) => p.value)).not.toContain("mainstream");
    expect(c.negative.map((n) => n.value)).toEqual(["mainstream", "generic"]);
    expect(c.wantsDistinctive).toBe(true);
  });

  it("lists unverifiable hard rules and a stated budget for a person", () => {
    const c = contract({ marketId: "london", budgetBand: "£20k", constraints: [{ id: "r", description: "No fast-fashion collaborators", kind: "hard" }] });
    expect(c.unverifiable.map((u) => u.value)).toEqual(["No fast-fashion collaborators", "Budget fit: £20k"]);
  });
});
