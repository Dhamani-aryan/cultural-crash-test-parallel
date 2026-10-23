import { describe, expect, it } from "vitest";
import { agentKey, selectionFlags, type SelectionFlags } from "@/lib/crashtest/agent";
import { compileIntent } from "@/lib/crashtest/intent";
import { compareVectors } from "@/lib/crashtest/matrix";
import { runCrashTest } from "@/lib/crashtest/run";
import { brandRole, hostTier, selectionHostTier } from "@/lib/crashtest/screens";
import { LaunchBriefSchema, type Component, type LaunchBriefInput, type PoolRecord, type RunState } from "@/lib/crashtest/types";
import { marketById } from "@/lib/markets";
import type { QlooEntity } from "@/lib/qloo";
import { entity, tag } from "../engine/helpers";
import { LONDON_BRIEF, W, withExtras, worldClient, worldLlm } from "./world";

const london = marketById("london")!;
const contractOf = (b: Partial<LaunchBriefInput> = {}) => compileIntent(LaunchBriefSchema.parse({ ...LONDON_BRIEF, ...b }), london, { names: [], source: "none" });
const place = (c: string) => `urn:tag:category:place:${c}`;
const genre = (name: string) => tag(`urn:tag:genre:brand:${name.toLowerCase().replace(/\W+/g, "_")}`, "urn:tag:genre:brand", name);
const productCategory = (name: string) => tag(`urn:tag:product_category:qloo:${name.toLowerCase()}`, "urn:tag:product_category:qloo", name);

async function run(brief: LaunchBriefInput, extras: QlooEntity[], over: Parameters<typeof worldLlm>[0] = {}) {
  const fake = worldLlm(over);
  const state = await runCrashTest({ qloo: withExtras(worldClient().client, extras), llm: fake.llm }, brief, { architecture: "parallel", blindId: (n) => `P${n}`, runVersion: "test" });
  return { state, p: state.parallel!, calls: fake.calls };
}
const agentLabel = (s: RunState, slot: Component["slot"]) => s.parallel!.candidates.find((c) => c.candidateId === "agent")!.plan.components.find((c) => c.slot === slot)?.label;

describe("screens:v4: is a collaboration candidate a product brand?", () => {
  it("reads Qloo's own product categories and brand genres", () => {
    expect(brandRole({ tags: [genre("Casual"), productCategory("Apparel")] }).kind).toBe("product");
    expect(brandRole({ tags: [genre("High-end / Designer"), genre("Fashion")] }).kind).toBe("product");
    expect(brandRole({ tags: [genre("Cultural Arts")] })).toEqual({ kind: "institution", genres: ["Cultural Arts"] });
    expect(brandRole({ tags: [genre("Website"), genre("Fitness App"), genre("Mobile App")] }).kind).toBe("not_product");
    expect(brandRole({ tags: [genre("Entertainment"), genre("Art"), genre("Media")] }).kind).toBe("product");
    expect(brandRole({ tags: [genre("Professional Services")] }).kind).toBe("not_product");
    // No genre at all: unknown, never a failure.
    expect(brandRole({ tags: [] }).kind).toBe("unknown");
  });
});

describe("screens:v4: the agent's venue tier", () => {
  const pop = contractOf();
  const party = contractOf({ sourceText: "A launch party with a DJ set." });
  it("never prefers a retail store, nor a bar when the brief isn't about food, drink or a party", () => {
    // The evidence matrix's rule (evidence:v4) is unchanged: a pop-up still lists shops as preferred there.
    expect(hostTier([place("clothing_store")], pop, false)).toBe("preferred");
    expect(selectionHostTier([place("clothing_store")], pop, false)).toBe("possible");
    expect(selectionHostTier([place("body_piercing_shop")], pop, false)).toBe("unknown");
    expect(selectionHostTier([place("event_venue")], pop, false)).toBe("preferred");
    expect(selectionHostTier([place("bar")], party, false)).toBe("preferred");
    expect(selectionHostTier([place("night_club")], party, false)).toBe("preferred");
    expect(selectionHostTier([place("restaurant")], pop, true)).toBe("preferred");
    // A shop that is also filed as an event space is preferred through that.
    expect(selectionHostTier([place("clothing_store"), place("event_venue")], pop, false)).toBe("preferred");
    expect(selectionHostTier([place("hotel")], pop, false)).toBe("unsuitable");
  });
});

describe("screens:v4: role errors can't win through affinity", () => {
  it("drops a gallery offered as a brand, and keeps a user-named one as only doubtful", async () => {
    const gallery = entity("g1", { name: "Grand Gallery", type: "urn:entity:brand", tags: [genre("Cultural Arts")] });
    const { state, p } = await run(LONDON_BRIEF, [gallery]);
    const rec = p.agent!.pools.find((r) => r.name === "Grand Gallery")!;
    expect(rec.views.audience).toBe(1);
    expect(rec).toMatchObject({ outcome: "dropped: wrong role", screens: { role: "fail" } });
    expect(rec.screens.notes).toContain("brand: an institution, not a brand (Cultural Arts)");
    for (const c of p.candidates.filter((x) => x.track === "agent")) expect(c.plan.components.map((x) => x.label)).not.toContain("Grand Gallery");
    expect(agentLabel(state, "brand_collaboration")).not.toBe("Grand Gallery");

    const named = await run({ ...LONDON_BRIEF, existingChoices: [{ slot: "brand_collaboration", name: "Grand Gallery" }] }, [gallery]);
    expect(named.p.agent!.pools.find((r) => r.name === "Grand Gallery")).toMatchObject({ source: "user", outcome: "pool", screens: { role: "doubtful" } });
  });

  it("keeps a top-affinity chain store from winning the venue over an event space", async () => {
    const store = entity("st1", {
      name: "Chain Store",
      type: "urn:entity:place",
      geocode: { city: "London", metro: null, countryCode: "GB", latitude: 51.5, longitude: -0.1 },
      tags: [tag(place("clothing_store"), "urn:tag:category:place", "Clothing store")],
    });
    const { state, p } = await run(LONDON_BRIEF, [store]);
    const rec = p.agent!.pools.find((r) => r.name === "Chain Store")!;
    expect(rec.views.audience).toBe(1);
    expect(rec.screens).toMatchObject({ role: "doubtful" });
    expect(rec.screens.notes).toContain("host: possible");
    expect(agentLabel(state, "event_place")).toBe("Yard Market");
  });
});

// ---------- selection order and the whole-plan guard ----------

const comp = (slot: Component["slot"], label: string, popularity: number, over: Partial<Component> = {}): Component => ({
  slot,
  label,
  origin: "agent_proposed",
  locked: false,
  resolution: "resolved",
  entity: { id: label, name: label, type: null, popularity, imageUrl: null, shortDescription: null },
  tags: [],
  placeCategory: null,
  ...over,
});
const screens = (over: Partial<PoolRecord["screens"]> = {}): PoolRecord["screens"] => ({ role: "pass", locality: "unknown", brief: "pass", distinct: "pass", central: "pass", notes: [], ...over });

describe("screens:v4: selection", () => {
  const indie = contractOf({ sourceText: "An independent label, not another generic collaboration." });

  it("ranks the brief's distinctiveness above audience support, only when the brief asks for it", () => {
    const generic: SelectionFlags = { role: 0, intent: 1, guard: null, notes: [] };
    const clean: SelectionFlags = { role: 0, intent: 0, guard: null, notes: [] };
    // Same hard rules, locks and completeness; the generic plan has better brief fit and audience support.
    const evGeneric = [0, 0, 1, 3, 0, 2, 1, 1, 1];
    const evIndie = [0, 0, 1, 2, -1, 1, 1, 1, 0.8];
    expect(compareVectors(agentKey(evIndie, clean), agentKey(evGeneric, generic))).toBeGreaterThan(0);
    // Hard rules, locks and completeness still come first.
    expect(compareVectors(agentKey([-1, 0, 1, 9, 0, 9, 9, 9, 1], clean), agentKey(evGeneric, generic))).toBeLessThan(0);
    expect(compareVectors(agentKey([0, 0, 0.75, 9, 0, 9, 9, 9, 1], clean), agentKey(evGeneric, generic))).toBeLessThan(0);
  });

  it("flags requested distinctiveness and the named neighbourhood, but never a locked or user-named choice", () => {
    const plan = {
      anchors: [],
      components: [
        comp("artist_music", "Star", 0.99),
        comp("brand_collaboration", "House", 0.999),
        comp("event_place", "Far Room", 0.9),
      ],
    };
    const by: Record<string, PoolRecord["screens"]> = { Star: screens(), House: screens({ distinct: "flag" }), "Far Room": screens({ hood: "outside" }) };
    const f = selectionFlags(plan, (c) => by[c.label], indie);
    expect(f.intent).toBe(2);
    expect(f.notes.map((n) => n.slot)).toEqual(["brand_collaboration", "event_place"]);
    const user = { ...plan, components: plan.components.map((c) => ({ ...c, origin: "user_provided" as const })) };
    expect(selectionFlags(user, (c) => by[c.label], indie).intent).toBe(0);
    const locked = { ...plan, components: plan.components.map((c) => ({ ...c, locked: true })) };
    expect(selectionFlags(locked, (c) => by[c.label], indie)).toMatchObject({ intent: 0, role: 0, guard: null });
  });

  it("rejects a narratively generic bundle: two prestige defaults, or one with nothing local", () => {
    const flags = (pops: number[], local: boolean[]) =>
      selectionFlags(
        { anchors: [], components: pops.map((p, i) => comp((["artist_music", "brand_collaboration", "event_place"] as const)[i], `c${i}`, p)) },
        (c) => screens({ locality: local[Number(c.label.slice(1))] ? "pass" : "unknown" }),
        contractOf(),
      ).guard;
    expect(flags([0.999, 0.998, 0.9], [true, true, true])).toBe("two or more global prestige defaults");
    expect(flags([0.999, 0.9, 0.9], [false, false, false])).toBe("a global prestige default and nothing local");
    expect(flags([0.999, 0.9, 0.9], [false, true, false])).toBeNull();
    expect(flags([0.99, 0.98, 0.9], [false, false, false])).toBeNull();
  });
});

describe("frozen evaluation anchors", () => {
  it("measures against the frozen anchors without asking the model to choose them", async () => {
    const fake = worldLlm();
    const anchors = [W.anchorA, W.anchorB].map((e) => ({ id: e.id, name: e.displayName, type: e.type, popularity: e.popularity, imageUrl: null, shortDescription: null }));
    const state = await runCrashTest({ qloo: worldClient().client, llm: fake.llm }, { ...LONDON_BRIEF, audienceAnchors: [] }, {
      architecture: "parallel",
      runVersion: "test",
      anchors: { anchors, source: "model_hypothesis", from: "parallel-v2 (crash:v15+parallel:v2)" },
    });
    expect(fake.calls.some((c) => c.system.startsWith("Suggest audience anchors") || c.system.startsWith("Suggest broader"))).toBe(false);
    expect(state.plan!.anchors.map((a) => a.id)).toEqual([W.anchorA.id, W.anchorB.id]);
    expect(state.parallel).toMatchObject({ anchorSource: "model_hypothesis", config: { anchorsFrozenFrom: "parallel-v2 (crash:v15+parallel:v2)" } });
    expect(state.assumptions.join(" ")).toMatch(/Audience anchors frozen from parallel-v2/);
  });
});
