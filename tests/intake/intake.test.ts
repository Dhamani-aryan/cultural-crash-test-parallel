import { describe, expect, it } from "vitest";
import { LaunchBriefSchema } from "@/lib/crashtest/types";
import type { LlmClient } from "@/lib/llm/types";
import { applyIntake, newIntake } from "@/lib/intake/state";
import { MAX_CLARIFICATION_TURNS, type IntakeState } from "@/lib/intake/types";
import { infersSensitiveTrait, missingFields, refresh, toLaunchBrief } from "@/lib/intake/validate";
import { handleCrashTest } from "@/lib/server/handlers";

/** Empty extraction: every field present, nothing stated. */
const none: Record<string, unknown> = {
  brandName: "",
  productCategory: "",
  launchGoal: "",
  cityText: "",
  audienceDescription: "",
  audienceAnchors: [],
  brandAttributes: [],
  budgetBand: "",
  website: "",
  choices: [],
  exclude: [],
  otherRules: [],
};

/** A fake model: `facts` maps a message substring to what extraction returns for it. */
function fakeLlm(facts: Record<string, Record<string, unknown>>, hypotheses: unknown[] = []) {
  const calls: string[] = [];
  const llm: LlmClient = {
    provider: "fake",
    model: "fake",
    async generateText({ system, prompt }) {
      calls.push(system.slice(0, 30));
      const reply = (x: unknown) => ({
        text: JSON.stringify(x),
        usage: null,
        model: "fake",
        ms: 1,
      });
      if (system.startsWith("You read one message")) {
        const msg = prompt.slice(prompt.indexOf('Message:\n"""') + 12);
        const hit = Object.entries(facts).find(([k]) => msg.includes(k));
        return reply({ ...none, ...(hit?.[1] ?? {}) });
      }
      if (system.startsWith("Suggest 2 or 3 broad audience")) return reply({ hypotheses });
      throw new Error(`unexpected prompt: ${system.slice(0, 40)}`);
    },
  };
  return { llm, calls };
}

const FULL = "FULL";
const fullFacts = {
  [FULL]: {
    brandName: "Northline",
    productCategory: "Sustainable streetwear",
    launchGoal: "Limited capsule launch",
    cityText: "London",
    audienceDescription: "18–30 skate and independent-fashion fans",
    brandAttributes: ["sustainable", "DIY"],
    choices: [{ slot: "event_place" as const, name: "Village Underground", locked: true }],
    exclude: ["Gucci"],
  },
};

const lastAssistant = (s: IntakeState) =>
  [...s.messages].reverse().find((m) => m.role === "assistant")!.text;

describe("intake", () => {
  it("turns a complete description into a summary and starts the run, without a second confirmation (P2.1)", async () => {
    const { llm } = fakeLlm(fullFacts);
    const r1 = await applyIntake(llm, { action: "message", message: FULL, marketId: "london" });
    expect(r1.state.missingCriticalFields).toEqual([]);
    expect(r1.state.readyToRun).toBe(true);
    expect(r1.startRequested).toBe(true);
    expect(lastAssistant(r1.state)).toMatch(/^Here’s the brief I’ll test:[\s\S]*I have enough to test the plan\.$/);
    expect(lastAssistant(r1.state)).not.toMatch(/Confirm the brief|Brief locked/);
    expect(r1.state.chips).toEqual([]);
    // An explicit confirm (an example brief's chip) still starts it, with the same neutral words.
    const r2 = await applyIntake(llm, { action: "confirm", state: r1.state });
    expect(r2.startRequested).toBe(true);
    expect(lastAssistant(r2.state)).toBe("I have enough to test the plan.");
  });

  it("asks only for what's genuinely missing", async () => {
    const { llm } = fakeLlm({
      pop: { productCategory: "Sneakers", launchGoal: "pop-up", cityText: "London" },
    });
    const r = await applyIntake(llm, {
      action: "message",
      message: "A sneaker pop-up in London",
      marketId: "london",
    });
    expect(r.state.missingCriticalFields).toEqual(["audience", "brandContext"]);
    const text = lastAssistant(r.state);
    expect(text).toMatch(/Who is it for/);
    expect(text).toMatch(/stand for/);
    expect(text).not.toMatch(/What kind of launch/);
    expect(text).not.toMatch(/Which city/);
    expect(r.state.chips.some((c) => c.action === "explore_audience")).toBe(true);
  });

  it("merges a later answer without erasing earlier facts", async () => {
    const { llm } = fakeLlm({
      pop: { productCategory: "Sneakers", launchGoal: "pop-up", audienceAnchors: ["Nike"] },
      fans: {
        audienceDescription: "Sneaker collectors",
        audienceAnchors: ["Stüssy"],
        brandAttributes: ["bold"],
      },
    });
    const r1 = await applyIntake(llm, {
      action: "message",
      message: "A sneaker pop-up",
      marketId: "london",
    });
    const r2 = await applyIntake(llm, {
      action: "message",
      message: "For sneaker fans, bold",
      state: r1.state,
    });
    const b = r2.state.brief;
    expect(b.productCategory).toBe("Sneakers");
    expect(b.launchGoal).toBe("pop-up");
    expect(b.audienceAnchors).toEqual(["Nike", "Stüssy"]);
    expect(b.audienceDescription).toBe("Sneaker collectors");
    expect(r2.state.missingCriticalFields).toEqual([]);
  });

  it("asks the user to settle a city the text and the selector disagree on", async () => {
    const { llm } = fakeLlm({ Tokyo: { ...fullFacts[FULL], cityText: "Tokyo" } });
    const r = await applyIntake(llm, {
      action: "message",
      message: "Launching in Tokyo",
      marketId: "london",
    });
    expect(r.state.missingCriticalFields).toContain("cityConflict");
    expect(lastAssistant(r.state)).toMatch(/You mention Tokyo, but London is selected/);
    const pick = r.state.chips.find((c) => c.label === "Tokyo")!;
    const r2 = await applyIntake(llm, {
      action: pick.action!,
      patch: pick.patch as never,
      state: r.state,
    });
    expect(r2.state.brief.marketId).toBe("tokyo");
    expect(r2.state.missingCriticalFields).not.toContain("cityConflict");
  });

  it("maps a supported-city district to its city instead of losing the market", async () => {
    const { llm } = fakeLlm({ Dalston: { ...fullFacts[FULL], cityText: "Dalston" } });
    const r = await applyIntake(llm, {
      action: "message",
      message: "A listening party in Dalston",
    });
    expect(r.state.brief.marketId).toBe("london");
    expect(r.state.brief.cityText).toBe("");
    expect(r.state.missingCriticalFields).not.toContain("marketId");
  });

  it("recovers one unambiguous supported city when a district was preserved as a rule", async () => {
    const { llm } = fakeLlm({
      listening: { ...fullFacts[FULL], cityText: "", otherRules: ["in Dalston"] },
    });
    const r = await applyIntake(llm, {
      action: "message",
      message: "A listening party in Dalston, part of London's nightlife",
    });
    expect(r.state.brief.marketId).toBe("london");
    expect(r.state.missingCriticalFields).not.toContain("marketId");
  });

  it("accepts a stated positioning rule as brand context", async () => {
    const { llm } = fakeLlm({
      festival: {
        productCategory: "Sneakers",
        launchGoal: "festival",
        cityText: "London",
        audienceDescription: "streetwear and music fans",
        otherRules: ["must feel authentic, not like unrelated popular names"],
      },
    });
    const r = await applyIntake(llm, {
      action: "message",
      message: "A festival that must feel authentic",
    });
    expect(r.state.missingCriticalFields).not.toContain("brandContext");
  });

  it("recovers explicit opening and positioning language when extraction omits them", async () => {
    const { llm } = fakeLlm({
      speakeasy: {
        productCategory: "speakeasy",
        cityText: "New York",
        audienceDescription: "cocktail and underground-music fans",
      },
    });
    const r = await applyIntake(llm, {
      action: "message",
      message:
        "We're opening a speakeasy in New York for cocktail and underground-music fans. We want the concept to fit the local creative culture.",
    });
    expect(r.state.brief.launchGoal).toBe("opening");
    expect(r.state.brief.brandAttributes).toEqual([
      "We want the concept to fit the local creative culture.",
    ]);
    expect(r.state.missingCriticalFields).toEqual([]);
  });

  it("keeps extracted brand attributes valid for the run schema", async () => {
    const long = "A deliberately long positioning statement that exceeds the run limit ".repeat(3);
    const { llm } = fakeLlm({ long: { ...fullFacts[FULL], brandAttributes: [long] } });
    const r = await applyIntake(llm, { action: "message", message: "long" });
    expect(r.state.brief.brandAttributes[0]).toHaveLength(120);
    expect(() => LaunchBriefSchema.parse(toLaunchBrief(r.state))).not.toThrow();
  });

  it("keeps long extracted choice names valid for the run schema", async () => {
    const long = "Experimental scent, lighting, sound and electronic nightlife direction ".repeat(
      3,
    );
    const { llm } = fakeLlm({
      longchoice: {
        ...fullFacts[FULL],
        choices: [{ slot: "creative_direction", name: long, locked: false }],
      },
    });
    const r = await applyIntake(llm, { action: "message", message: "longchoice" });
    expect(r.state.brief.choices[0].name).toHaveLength(120);
    expect(() => LaunchBriefSchema.parse(toLaunchBrief(r.state))).not.toThrow();
  });

  it("preserves the user's original description in the confirmed run brief", async () => {
    const { llm } = fakeLlm(fullFacts);
    const description = `${FULL} A customization workshop in Shimokitazawa.`;
    const r = await applyIntake(llm, { action: "message", message: description });
    const brief = LaunchBriefSchema.parse(toLaunchBrief(r.state));
    expect(brief.sourceText).toBe(description);
    expect(brief.sourceText).toContain("Shimokitazawa");
  });

  it("names an unsupported extracted city instead of asking a generic city question", async () => {
    const { llm } = fakeLlm({ Seoul: { ...fullFacts[FULL], cityText: "Seoul" } });
    const r = await applyIntake(llm, { action: "message", message: "A launch in Seoul" });
    expect(r.state.missingCriticalFields).toContain("marketId");
    expect(lastAssistant(r.state)).toMatch(/You mention Seoul, which isn't one of the cities/);
  });

  it("proposes non-sensitive audience ideas and requires the user to pick one", async () => {
    const { llm } = fakeLlm(
      { pop: { productCategory: "Sneakers", launchGoal: "pop-up", brandAttributes: ["bold"] } },
      [
        {
          label: "Sneaker collectors",
          description: "People who queue for limited drops",
          suggestedAnchors: ["Nike", "Patta"],
          assumptions: ["Drop culture"],
        },
        {
          label: "Religious youth groups",
          description: "Defined by religion",
          suggestedAnchors: [],
          assumptions: [],
        },
        {
          label: "Skate scene",
          description: "Skaters and DIY fans",
          suggestedAnchors: ["Palace"],
          assumptions: [],
        },
      ],
    );
    const r1 = await applyIntake(llm, {
      action: "message",
      message: "A sneaker pop-up",
      marketId: "london",
    });
    const r2 = await applyIntake(llm, { action: "explore_audience", state: r1.state });
    expect(r2.state.audienceHypotheses.map((h) => h.label)).toEqual([
      "Sneaker collectors",
      "Skate scene",
    ]);
    expect(r2.state.missingCriticalFields).toContain("audience");
    const r3 = await applyIntake(llm, {
      action: "select_audience",
      hypothesisId: "H1",
      state: r2.state,
    });
    expect(r3.state.brief.audienceDescription).toMatch(/Sneaker collectors/);
    expect(r3.state.origins.audienceDescription).toBe("user_confirmed");
    expect(r3.state.brief.audienceAnchors).toEqual(["Nike", "Patta"]);
    expect(r3.state.origins.audienceAnchors).toBe("model_suggested");
    expect(r3.state.missingCriticalFields).not.toContain("audience");
    expect(toLaunchBrief(r3.state).audienceAnchors).toEqual([]);
  });

  it("rejects audience descriptions built on sensitive traits", () => {
    expect(infersSensitiveTrait("young Muslim women")).toBe(true);
    expect(infersSensitiveTrait("low-income families")).toBe(true);
    expect(infersSensitiveTrait("London skate and independent streetwear fans")).toBe(false);
  });

  it("stops asking after the clarification-turn limit and keeps the run disabled", async () => {
    const { llm } = fakeLlm({});
    let s = (
      await applyIntake(llm, { action: "message", message: "hello there", marketId: "london" })
    ).state;
    for (let i = 0; i < MAX_CLARIFICATION_TURNS + 2; i++)
      s = (await applyIntake(llm, { action: "message", message: `nothing useful ${i}`, state: s }))
        .state;
    expect(s.clarificationTurns).toBe(MAX_CLARIFICATION_TURNS);
    expect(lastAssistant(s)).toMatch(/I've asked all I'll ask/);
    expect(s.readyToRun).toBe(false);
  });

  it("won't start while something is missing, and starts on 'go' after the summary", async () => {
    const { llm } = fakeLlm({
      ...fullFacts,
      pop: { productCategory: "Sneakers", launchGoal: "pop-up", cityText: "London" },
    });
    const early = await applyIntake(llm, {
      action: "message",
      message: "A sneaker pop-up",
      marketId: "london",
    });
    const refused = await applyIntake(llm, {
      action: "message",
      message: "go",
      state: early.state,
    });
    expect(refused.startRequested).toBe(false);
    expect(lastAssistant(refused.state)).toMatch(/Not yet/);
    const r1 = await applyIntake(llm, { action: "message", message: FULL, marketId: "london" });
    const r2 = await applyIntake(llm, { action: "message", message: "go", state: r1.state });
    expect(r2.startRequested).toBe(true);
    expect(r2.state.readyToRun).toBe(true);
  });

  it("fills in the rest as stated assumptions when the user hands it over, but still asks for the city", async () => {
    const { llm } = fakeLlm({ sneaker: { productCategory: "Sneakers" } }, [
      {
        label: "Sneaker collectors",
        description: "People who queue for drops",
        suggestedAnchors: ["Patta"],
        assumptions: [],
      },
    ]);
    const r1 = await applyIntake(llm, {
      action: "message",
      message: "We sell sneakers. That's all I have, figure out the rest.",
    });
    expect(r1.state.delegated).toBe(true);
    expect(r1.state.brief.audienceDescription).toMatch(/Sneaker collectors/);
    expect(r1.state.missingCriticalFields).toEqual(["marketId"]);
    expect(lastAssistant(r1.state)).toMatch(/Which city/);
    const pick = r1.state.chips.find((c) => c.label === "London")!;
    const r2 = await applyIntake(llm, {
      action: pick.action!,
      patch: pick.patch as never,
      state: r1.state,
    });
    expect(r2.state.missingCriticalFields).toEqual([]);
    expect(lastAssistant(r2.state)).toMatch(/I assumed: the audience is "Sneaker collectors"/);
  });

  it("doesn't trust a client that claims readiness", async () => {
    const forged: IntakeState = { ...newIntake("london"), confirmed: true, readyToRun: true };
    expect(refresh(forged).readyToRun).toBe(false);
    const res = await handleCrashTest(
      new Request("http://test/api/crashtest", {
        method: "POST",
        body: JSON.stringify({ intake: forged }),
      }),
      () => {
        throw new Error("must not run");
      },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("brief_not_confirmed");
  });

  it("carries locks, exclusions and the exploration switch into the crash-test brief", async () => {
    const { llm } = fakeLlm(fullFacts);
    const r = await applyIntake(llm, { action: "message", message: FULL, marketId: "london" });
    expect(r.state.brief.exploreUserChoices).toBe(true);
    const brief = LaunchBriefSchema.parse(toLaunchBrief(r.state));
    expect(brief.exploreUserChoices).toBe(true);
    expect(brief.constraints).toContainEqual(expect.objectContaining({ lockSlot: "event_place" }));
    expect(brief.constraints).toContainEqual(expect.objectContaining({ excludeNames: ["Gucci"] }));
    const off = await applyIntake(llm, {
      action: "update_brief",
      patch: { exploreUserChoices: false },
      state: r.state,
    });
    // An edit that leaves the brief complete summarises it again and runs it (P2.1: no second confirmation).
    expect(off.startRequested).toBe(true);
    expect(LaunchBriefSchema.parse(toLaunchBrief(off.state)).exploreUserChoices).toBe(false);
  });

  it("applies a brief edit through the HTTP handler without blanking other fields", async () => {
    const { handleIntake } = await import("@/lib/server/handlers");
    const { llm } = fakeLlm(fullFacts);
    const r = await applyIntake(llm, { action: "message", message: FULL, marketId: "london" });
    const res = await handleIntake(
      new Request("http://test/api/intake", {
        method: "POST",
        body: JSON.stringify({
          action: "update_brief",
          patch: { budgetBand: "£20k" },
          state: r.state,
        }),
      }),
      () => llm,
    );
    const { state } = await res.json();
    expect(state.brief.budgetBand).toBe("£20k");
    expect(state.brief.productCategory).toBe("Sustainable streetwear");
    expect(state.brief.choices).toHaveLength(1);
    expect(state.origins.productCategory).toBe("user_supplied");
  });

  it("treats a model-suggested audience as not yet confirmed", () => {
    const s = newIntake("london");
    const withSuggestion = {
      ...s,
      brief: { ...s.brief, audienceDescription: "Skaters" },
      origins: { audienceDescription: "model_suggested" as const },
    };
    expect(missingFields(withSuggestion)).toContain("audience");
  });

  it("never calls Qloo or anything but the model during the intake", async () => {
    const { llm, calls } = fakeLlm(fullFacts);
    await applyIntake(llm, { action: "message", message: FULL, marketId: "london" });
    expect(calls).toEqual(["You read one message from some"]);
  });
});
