import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { RunResult } from "@/components/run-result";
import {
  BEAM_WIDTH,
  beamSearch,
  neighborhoodCentroid,
  planFingerprint,
  runEvidenceAgent,
  weakestSlot,
  type PoolCandidate,
  type Proxy,
} from "@/lib/crashtest/agent";
import { evaluatePlan } from "@/lib/crashtest/evaluate";
import { gatherEvidence, type GatherContext } from "@/lib/crashtest/gather";
import { compileIntent } from "@/lib/crashtest/intent";
import { BudgetExceeded, createLedger } from "@/lib/crashtest/ledger";
import {
  buildEvidenceMatrix,
  compareVectors,
  evidenceVector,
  type MatrixContext,
} from "@/lib/crashtest/matrix";
import { parallelView, toParallelMarkdown } from "@/lib/crashtest/parallel-view";
import { toRef } from "@/lib/crashtest/plan";
import { runCrashTest } from "@/lib/crashtest/run";
import { neighborhoodFit, type RoleCheck } from "@/lib/crashtest/screens";
import {
  LaunchBriefSchema,
  SLOTS,
  type CandidatePlan,
  type Component,
  type CulturalPlan,
  type LaunchBriefInput,
  type RunState,
  type Slot,
} from "@/lib/crashtest/types";
import { PARALLEL_VERSION } from "@/lib/crashtest/version";
import { marketById } from "@/lib/markets";
import type { QlooEntity } from "@/lib/qloo";
import { FROZEN, frozenFiles, isFrozen } from "../../eval/frozen";
import { outputRefusal } from "../../eval/output-guard";
import { entity, tag } from "../engine/helpers";
import { LONDON_BRIEF, W, withExtras, worldClient, worldLlm, type WorldOptions } from "./world";

type LlmOver = Parameters<typeof worldLlm>[0];

async function run(
  brief: LaunchBriefInput = LONDON_BRIEF,
  over: LlmOver = {},
  world: WorldOptions = {},
  extras: QlooEntity[] = [],
  places: Record<string, QlooEntity[]> = {},
  limits = {},
) {
  const fake = worldLlm(over);
  const state = await runCrashTest(
    { qloo: withExtras(worldClient(world).client, extras, places), llm: fake.llm },
    brief,
    {
      architecture: "parallel",
      blindId: (n) => `P${n}`,
      runVersion: "test",
      limits,
    },
  );
  return { state, p: state.parallel!, calls: fake.calls };
}
const cand = (s: RunState, id: string) => s.parallel!.candidates.find((c) => c.candidateId === id)!;
const label = (c: CandidatePlan, slot: Slot) =>
  c.plan.components.find((x) => x.slot === slot)?.label;
const agentPlans = (s: RunState) => s.parallel!.candidates.filter((c) => c.track === "agent");

const geo = (lat: number, lon: number) => ({
  city: "London",
  metro: null,
  countryCode: "GB",
  latitude: lat,
  longitude: lon,
});
const venue = (id: string, name: string, category: string, at = geo(51.5, -0.1)) =>
  entity(id, {
    name,
    type: "urn:entity:place",
    geocode: at,
    tags: [tag(`urn:tag:category:place:${category}`, "urn:tag:category:place", category)],
  });

describe("v3: the agent is independent of the user's unlocked choices", () => {
  it("a fully specified but unlocked user plan can differ from the agent's", async () => {
    const choices = [
      { slot: "artist_music" as const, name: "Big Tex" },
      { slot: "brand_collaboration" as const, name: "Fieldnote" },
      { slot: "event_place" as const, name: "Yard Market" },
      { slot: "creative_direction" as const, name: "Industrial" },
    ];
    const { state, p } = await run(
      {
        ...LONDON_BRIEF,
        sourceText:
          "We're considering Big Tex for music, maybe Fieldnote as a partner, possibly at Yard Market, with an industrial look.",
        existingChoices: choices,
      },
      { choiceCountry: "United States" },
    );
    // The user's plan is exactly what was given.
    expect(cand(state, "user").plan.components.map((c) => c.label)).toEqual(
      choices.map((c) => c.name),
    );
    // Each unlocked choice was only a candidate in the agent's pool, beside Qloo's.
    for (const c of choices.slice(0, 3))
      expect(p.agent!.pools.find((r) => r.name === c.name)).toMatchObject({
        source: "user",
        outcome: "pool",
      });
    expect(p.agent!.pools.some((r) => r.slot === "artist_music" && r.source === "qloo")).toBe(true);
    // Big Tex isn't followed by this audience here; the agent's own plan replaces him.
    expect(planFingerprint(cand(state, "agent").plan)).not.toBe(
      planFingerprint(cand(state, "user").plan),
    );
    expect(label(cand(state, "agent"), "artist_music")).toBe("Grey Lane");
    expect(cand(state, "agent").sources.artist_music).toBe("agent");
  });

  it("explicit locks survive every pooled bundle, challenge and the final plan", async () => {
    const { state, p } = await run(
      {
        ...LONDON_BRIEF,
        existingChoices: [{ slot: "artist_music", name: "Big Tex" }],
        constraints: [
          { id: "c1", description: "Keep Big Tex", kind: "hard", lockSlot: "artist_music" },
        ],
      },
      { choiceCountry: "United States" },
    );
    // A locked slot isn't pooled at all, and is never the target of a challenge.
    expect(p.agent!.pools.filter((r) => r.slot === "artist_music")).toEqual([]);
    for (const r of p.agent!.rounds) expect(r.hypothesis?.slot).not.toBe("artist_music");
    expect(agentPlans(state).length).toBeGreaterThan(1);
    for (const c of p.candidates)
      expect(c.plan.components.find((x) => x.slot === "artist_music")).toMatchObject({
        label: "Big Tex",
        locked: true,
        origin: "user_provided",
      });
    expect(state.plan!.components.find((c) => c.slot === "artist_music")).toMatchObject({
      label: "Big Tex",
      locked: true,
    });
  });

  it("weakestSlot never names a locked slot, even when it is the only weakness", () => {
    const c = {
      candidateId: "x",
      plan: {
        anchors: [],
        components: [
          {
            slot: "artist_music",
            label: "A",
            origin: "user_provided",
            locked: true,
            resolution: "resolved",
            entity: null,
            tags: [],
            placeCategory: null,
          },
        ],
      },
      open: [],
    } as unknown as CandidatePlan;
    const m = {
      claims: [
        {
          candidateId: "x",
          slot: "artist_music",
          dimension: "audience",
          stance: "contradicts",
          claimId: "x/a",
          claim: "No.",
        },
      ],
    } as unknown as ReturnType<typeof buildEvidenceMatrix>;
    expect(weakestSlot(c, m, new Set<Slot>(["artist_music"]))).toBeNull();
    expect(weakestSlot(c, m, new Set<Slot>())).toMatchObject({
      slot: "artist_music",
      claimIds: ["x/a"],
    });
  });

  it("a user's choice Qloo doesn't know stays unknown, even when the model reads it as wrong", async () => {
    const { state, p } = await run(
      {
        ...LONDON_BRIEF,
        existingChoices: [{ slot: "brand_collaboration", name: "Hackney Clay Collective" }],
      },
      { roles: { "Hackney Clay Collective": { verdict: "wrong" } } },
    );
    expect(label(cand(state, "user"), "brand_collaboration")).toBe("Hackney Clay Collective");
    // Never dropped as a failure: a doubtful candidate that stays in the pool.
    expect(p.agent!.pools.find((r) => r.name === "Hackney Clay Collective")).toMatchObject({
      outcome: "pool",
      screens: { role: "doubtful", brief: "unknown" },
    });
    // The user's plan's entity claim stays unknown; the model's reading is labelled as one.
    expect(
      p.matrix.claims.find(
        (c) =>
          c.candidateId === "user" && c.slot === "brand_collaboration" && c.dimension === "entity",
      )!.stance,
    ).toBe("unknown");
    const role = p.matrix.claims.find(
      (c) => c.candidateId === "user" && c.ruleId === "R-role-check",
    )!;
    expect(role).toMatchObject({
      source: "logical_rubric",
      limitations: ["A model's reading of the facts shown, not Qloo evidence."],
    });
    expect(p.matrix.componentStates.user.brand_collaboration).toBe("needs_human");
  });
});

describe("v3: screens", () => {
  it("a high-affinity venue in the wrong role loses to a plausible host", async () => {
    const hotel = venue("h1", "Grand Hall Hotel", "hotel");
    const diner = venue("d1", "Corner Diner", "restaurant");
    const { state, p } = await run(
      LONDON_BRIEF,
      { roles: { "Corner Diner": { verdict: "wrong" } } },
      {},
      [hotel, diner],
    );
    // Both outrank Yard Market for this audience...
    const pool = (n: string) => p.agent!.pools.find((r) => r.name === n)!;
    expect(pool("Grand Hall Hotel").views.audience).toBeLessThan(
      pool("Yard Market").views.audience!,
    );
    expect(pool("Corner Diner").views.audience).toBeLessThan(pool("Yard Market").views.audience!);
    // ...but a hotel can't host (deterministic), and the role check reads the diner as wrong.
    expect(pool("Grand Hall Hotel")).toMatchObject({ outcome: "dropped: wrong role" });
    expect(pool("Grand Hall Hotel").screens.notes).toContain("host: unsuitable");
    expect(pool("Corner Diner")).toMatchObject({ outcome: "dropped: wrong role" });
    expect(pool("Corner Diner").screens.notes).toContain("role check: wrong");
    for (const c of agentPlans(state)) expect(label(c, "event_place")).toBe("Yard Market");
  });

  it("a mainstream default counts against a choice only when the brief asks for distinctiveness", async () => {
    const mega = entity("mb", {
      name: "Megabrand",
      type: "urn:entity:brand",
      shortDescription: "Global sportswear brand",
      popularity: 0.999,
    });
    const plain = await run(LONDON_BRIEF, {}, {}, [mega]);
    const indie = await run(
      {
        ...LONDON_BRIEF,
        sourceText: "A pop-up for an independent label, not another generic brand tie-in.",
      },
      {},
      {},
      [mega],
    );
    const claim = (s: RunState, id: string) =>
      s.parallel!.matrix.claims.find(
        (c) =>
          c.candidateId === id &&
          c.slot === "brand_collaboration" &&
          c.dimension === "distinctiveness",
      )!;
    const megaPlan = (s: RunState) =>
      agentPlans(s).find((c) => label(c, "brand_collaboration") === "Megabrand")!;

    // Without the request it's only noted, and the agent may keep the top-affinity brand.
    expect(plain.p.agent!.contract.wantsDistinctive).toBe(false);
    expect(claim(plain.state, megaPlan(plain.state).candidateId)).toMatchObject({
      stance: "unknown",
      ruleId: "R-mainstream",
    });
    expect(plain.p.agent!.pools.find((r) => r.name === "Megabrand")!.screens.distinct).toBe("pass");
    expect(label(cand(plain.state, "agent"), "brand_collaboration")).toBe("Megabrand");

    // With it, the same brand counts against the plan, and comparable evidence goes the other way.
    expect(indie.p.agent!.contract.wantsDistinctive).toBe(true);
    expect(claim(indie.state, megaPlan(indie.state).candidateId)).toMatchObject({
      stance: "contradicts",
      ruleId: "R-distinct-requested",
    });
    // A soft screen: flagged and still tested, never dropped as a failure.
    expect(indie.p.agent!.pools.find((r) => r.name === "Megabrand")).toMatchObject({
      outcome: "pool",
      screens: { distinct: "flag" },
    });
    expect(label(cand(indie.state, "agent"), "brand_collaboration")).toBe("Mossgrove");
  });

  it("applies neighbourhood fit only when Qloo's coordinates support it", async () => {
    const near = venue("n1", "Near Hall", "event_venue", geo(51.524, -0.078));
    const far = venue("f1", "Far Hall", "event_venue", geo(51.4, -0.3));
    const brief = { ...LONDON_BRIEF, sourceText: "A pop-up in Shoreditch." };
    const shops = Array.from({ length: 6 }, (_, i) =>
      entity(`s${i}`, {
        name: `Shop ${i}`,
        type: "urn:entity:place",
        geocode: geo(51.523 + i * 0.001, -0.077 - i * 0.001),
      }),
    );
    // Any track's plan with that venue: the rule is the same for every plan.
    const hoodClaim = (s: RunState, name: string) => {
      const c = s.parallel!.candidates.find((x) => label(x, "event_place") === name)!;
      return s.parallel!.matrix.claims.find(
        (x) => x.candidateId === c.candidateId && x.ruleId === "R-neighborhood",
      )!;
    };

    // With venues Qloo places in Shoreditch: near supports, far contradicts, and the agent picks near.
    const located = await run(brief, { draft: { venue: "Far Hall" } }, {}, [far, near], {
      "Shoreditch, London": shops,
    });
    expect(located.p.agent!.contract.neighborhoods.map((n) => n.value)).toEqual(["Shoreditch"]);
    expect(hoodClaim(located.state, "Near Hall")).toMatchObject({
      stance: "supports",
      source: "qloo_locality",
    });
    expect(hoodClaim(located.state, "Far Hall")).toMatchObject({ stance: "contradicts" });
    expect(label(cand(located.state, "agent"), "event_place")).toBe("Near Hall");

    // Without them, nothing is near or far: unknown, and Qloo's own ranking stands.
    const unlocated = await run(brief, { draft: { venue: "Far Hall" } }, {}, [far, near]);
    for (const n of ["Near Hall", "Far Hall"])
      expect(hoodClaim(unlocated.state, n)).toMatchObject({
        stance: "unknown",
        strength: "unknown",
      });
    expect(unlocated.p.agent!.pools.find((r) => r.name === "Far Hall")!.screens.locality).not.toBe(
      "flag",
    );
    expect(label(cand(unlocated.state, "agent"), "event_place")).toBe("Far Hall");

    // Qloo filing a venue under the named neighbourhood is evidence on its own, without a centroid.
    const labelled = venue("l1", "Label Hall", "event_venue", {
      ...geo(51.5, -0.1),
      latitude: null,
      longitude: null,
      neighborhood: "Shoreditch",
    } as never);
    const named = await run(brief, {}, {}, [far, labelled]);
    expect(hoodClaim(named.state, "Label Hall")).toMatchObject({
      stance: "supports",
      claim: expect.stringMatching(/Qloo places Label Hall in Shoreditch/),
    });
    expect(named.p.agent!.pools.find((r) => r.name === "Label Hall")!.screens.notes).toContain(
      "Qloo places it in Shoreditch",
    );
    expect(label(cand(named.state, "agent"), "event_place")).toBe("Label Hall");
  });

  it("reads a neighbourhood label as near, 2–6 km as outside, and a different label alone as never against it", () => {
    const at = (lat: number | null, lon: number | null, neighborhood: string | null = null) => ({
      geocode: {
        city: "London",
        metro: null,
        countryCode: "GB",
        latitude: lat,
        longitude: lon,
        neighborhood,
      },
    });
    const c = { name: "Shoreditch", lat: 51.524, lon: -0.078, count: 6, evidenceId: "e" };
    expect(neighborhoodFit(at(null, null, "Shoreditch"), null, "Shoreditch")).toMatchObject({
      fit: "near",
      named: true,
      km: null,
    });
    expect(neighborhoodFit(at(null, null, "Dalston"), null, "Shoreditch")).toMatchObject({
      fit: "unknown",
      named: false,
    });
    expect(neighborhoodFit(at(51.525, -0.079), c, "Shoreditch")).toMatchObject({
      fit: "near",
      named: false,
    });
    expect(neighborhoodFit(at(51.4, -0.3, "Dalston"), c, "Shoreditch").fit).toBe("far");
    // 2–6 km away is outside the neighbourhood, never local.
    expect(neighborhoodFit(at(51.55, -0.12), c, "Shoreditch").fit).toBe("outside");
    // A label match wins over distance: Qloo says it is there.
    expect(neighborhoodFit(at(51.4, -0.3, "shoreditch"), c, "Shoreditch").fit).toBe("near");
  });
});

describe("v3: a named neighbourhood is part of the brief", () => {
  it("ranks a venue in it above a better-liked venue outside it, which no longer passes as local", async () => {
    // Top for the audience, but 4 km from Shoreditch.
    const liked = venue("o1", "Liked Hall", "event_venue", geo(51.5, -0.13));
    // Found only through the neighbourhood list, with no audience affinity at all.
    const inside = venue("i1", "Inside Hall", "event_venue", geo(51.5245, -0.0785));
    const shops = Array.from({ length: 5 }, (_, i) =>
      entity(`s${i}`, {
        name: `Shop ${i}`,
        type: "urn:entity:place",
        geocode: geo(51.523 + i * 0.001, -0.077 - i * 0.001),
      }),
    );
    // The LLM's own plan names the better-liked venue, so the same rule is seen on it.
    const { state, p } = await run(
      { ...LONDON_BRIEF, sourceText: "A pop-up in Shoreditch." },
      { draft: { venue: "Liked Hall" } },
      {},
      [liked],
      { "Shoreditch, London": [inside, ...shops] },
    );
    const pool = (n: string) => p.agent!.pools.find((r) => r.name === n)!;
    expect(pool("Liked Hall").views.audience).toBe(1);
    expect(pool("Inside Hall").views.audience).toBeUndefined();
    expect(pool("Liked Hall").screens).toMatchObject({ hood: "outside", locality: "flag" });
    expect(pool("Inside Hall").screens).toMatchObject({ hood: "near", locality: "pass" });
    expect(label(cand(state, "agent"), "event_place")).toBe("Inside Hall");
    // Screened and kept in reserve, not dropped; with venues in Shoreditch to compose, the beam
    // doesn't spend complete-plan tests on one outside it.
    expect(["pool", "reserve"]).toContain(pool("Liked Hall").outcome);
    expect(label(cand(state, "llm"), "event_place")).toBe("Liked Hall");
    expect(
      p.matrix.claims.find((c) => c.candidateId === "llm" && c.ruleId === "R-neighborhood"),
    ).toMatchObject({
      stance: "contradicts",
      strength: "thin",
      claim: expect.stringMatching(/outside the neighbourhood the brief names/),
    });
  });

  it("counts the neighbourhood with brief fit in the plan order, above audience support", () => {
    const claim = (
      candidateId: string,
      ruleId: string | undefined,
      dimension: string,
      stance: string,
      strength = "moderate",
    ) => ({
      candidateId,
      slot: "event_place",
      ruleId,
      dimension,
      stance,
      strength,
      claimId: `${candidateId}/${dimension}/${ruleId}`,
      claim: "",
      evidenceIds: [],
      limitations: [],
    });
    const m = {
      claims: [
        claim("in", undefined, "entity", "supports"),
        claim("in", "R-neighborhood", "local", "supports"),
        claim("in", undefined, "audience", "contradicts"),
        claim("out", undefined, "entity", "supports"),
        claim("out", "R-neighborhood", "local", "contradicts", "thin"),
        claim("out", undefined, "audience", "supports"),
        claim("out", undefined, "local", "supports"),
      ],
      hardFailures: { in: [], out: [] },
      completenessByCandidate: { in: 1, out: 1 },
      coverageByCandidate: { in: 0.5, out: 1 },
    } as unknown as ReturnType<typeof buildEvidenceMatrix>;
    const [vi, vo] = [evidenceVector(m, "in"), evidenceVector(m, "out")];
    expect(vi[3]).toBe(0);
    expect(vo[3]).toBe(-1);
    expect(vi[5]).toBe(1);
    expect(vo[5]).toBe(-0.5);
    // City locality (level 8) no longer counts the neighbourhood claim.
    expect(vo[7]).toBe(1);
    expect(compareVectors(vi, vo)).toBeGreaterThan(0);
  });
});

describe("v3: where the named neighbourhood is", () => {
  const market = marketById("london")!;
  const contract = compileIntent(
    LaunchBriefSchema.parse({ ...LONDON_BRIEF, sourceText: "A pop-up in Shoreditch." }),
    market,
    { names: [], source: "none" },
  );
  const place = (i: number, lat: number, lon: number, country = "GB") =>
    entity(`v${i}`, {
      name: `V${i}`,
      type: "urn:entity:place",
      geocode: { city: "London", metro: null, countryCode: country, latitude: lat, longitude: lon },
    });
  const locality = (id: string, lat: number, lon: number, aka: string) => ({
    ...entity(id, {
      name: "Shoreditch",
      type: "urn:entity:locality",
      akas: [aka],
      geocode: { city: null, metro: null, countryCode: null, latitude: lat, longitude: lon },
    }),
    rank: 1,
  });
  const centroid = (venues: QlooEntity[], localities: ReturnType<typeof locality>[]) => {
    const client = {
      ...worldClient().client,
      getInsights: async () => ({
        entities: venues.map((e, i) => ({
          ...e,
          rank: i + 1,
          affinity: null,
          affinityRank: null,
          explainability: null,
        })),
        tags: [],
        aggregateExplainability: null,
        durationMs: null,
      }),
      searchEntities: async () => localities,
    };
    const ledger = createLedger(() => 0);
    return neighborhoodCentroid({ client, ledger, market }, contract).then((c) => ({
      c,
      record: ledger.records.at(-1)!,
    }));
  };
  // Five venues around Covent Garden, the way popular venues can skew a neighbourhood query.
  const skewed = [0, 1, 2, 3, 4].map((i) => place(i, 51.511 + i * 0.001, -0.123 - i * 0.001));

  it("prefers Qloo's locality record in this city that agrees with the venues", async () => {
    const { c, record } = await centroid(skewed, [
      locality("loc-us", 40.0, -75.0, "Shoreditch, Pennsylvania, United States"),
      locality("loc-uk", 51.5245, -0.0781, "Shoreditch, London, England, United Kingdom"),
    ]);
    expect(c).toMatchObject({ lat: 51.5245, lon: -0.0781, count: 5 });
    expect(record).toMatchObject({ qlooEntityIds: ["loc-uk"], coverageStatus: "usable" });
    expect(record.purpose).toMatch(/Qloo's locality record/);
  });

  it("falls back to the venues' median when no locality is in this city, or one disagrees with them", async () => {
    for (const locs of [
      [locality("loc-us", 40.0, -75.0, "Shoreditch, Pennsylvania, United States")],
      [locality("loc-far", 51.2, -0.5, "Shoreditch, London")],
    ]) {
      const { c, record } = await centroid(skewed, locs);
      expect(c!.lat).toBeCloseTo(51.513, 6);
      expect(c!.lon).toBeCloseTo(-0.125, 6);
      expect(record.purpose).toMatch(/the venues Qloo places there/);
    }
  });

  it("is unknown without five located venues or a matching locality, and ignores venues abroad", async () => {
    const abroad = [0, 1, 2, 3, 4].map((i) => place(i, 51.5, -0.1, "US"));
    expect((await centroid(abroad, [])).c).toBeNull();
    expect((await centroid(skewed.slice(0, 4), [])).c).toBeNull();
    // A matching locality is enough on its own.
    expect(
      (
        await centroid(skewed.slice(0, 4), [
          locality("loc-uk", 51.5245, -0.0781, "Shoreditch, London"),
        ])
      ).c,
    ).toMatchObject({ lat: 51.5245, count: 4 });
  });
});

// ---------- complete-plan search ----------

const ZERO: Proxy = {
  hard: 0,
  lock: 0,
  roleBad: 0,
  briefBad: 0,
  hood: 0,
  doubt: 0,
  weakAudience: 0,
  audience: 0,
  local: 0,
  distinct: 0,
};
const pc = (slot: Slot, name: string, proxy: Partial<Proxy>): PoolCandidate => ({
  slot,
  component: {
    slot,
    label: name,
    origin: "agent_proposed",
    locked: false,
    resolution: "resolved",
    entity: null,
    tags: [],
    placeCategory: null,
  } as Component,
  entity: null,
  source: "qloo",
  views: {},
  evidenceIds: [],
  lanes: [],
  screens: {
    role: "pass",
    locality: "unknown",
    brief: "pass",
    distinct: "pass",
    central: "pass",
    notes: [],
  },
  proxy: { ...ZERO, ...proxy },
});

describe("v3: bounded complete-plan search", () => {
  it("keeps at most the beam width of bundles, never the full product, and never one entity twice", () => {
    const pools = new Map<Slot, PoolCandidate[]>(
      (["artist_music", "brand_collaboration", "event_place"] as Slot[]).map((s) => [
        s,
        Array.from({ length: 6 }, (_, i) => pc(s, `${s}-${i}`, { audience: 1 - i / 10 })),
      ]),
    );
    pools
      .get("brand_collaboration")!
      .unshift(pc("brand_collaboration", "artist_music-0", { audience: 2 }));
    const beam = beamSearch(pools, 4);
    expect(beam).toHaveLength(4);
    expect(BEAM_WIDTH).toBe(6);
    for (const b of beam) {
      expect(b.map((x) => x.slot)).toEqual(["artist_music", "brand_collaboration", "event_place"]);
      expect(new Set(b.map((x) => x.component.label)).size).toBe(3);
    }
    // A slot with an empty pool stays open rather than ending the search.
    pools.set("event_place", []);
    expect(beamSearch(pools, 2).every((b) => b.length === 2)).toBe(true);
  });

  it("chooses the stronger complete plan over the top-ranked individual candidate", async () => {
    // Coast Kid ranks first for the audience, but the whole plan with Grey Lane tests better.
    const { state, p } = await run(
      LONDON_BRIEF,
      {},
      { artistCandidates: [W.otherUs, W.localRapper] },
    );
    const top = p
      .agent!.pools.filter((r) => r.slot === "artist_music")
      .sort((a, b) => (a.views.audience ?? 99) - (b.views.audience ?? 99))[0];
    expect(top.name).toBe("Coast Kid");
    expect(agentPlans(state).some((c) => label(c, "artist_music") === "Coast Kid")).toBe(true);
    expect(label(cand(state, "agent"), "artist_music")).toBe("Grey Lane");
    // Chosen among the beam's complete plans, not by a later substitution.
    expect(p.agent!.rounds.every((r) => !r.accepted)).toBe(true);
    expect(p.agent!.bundlesTested).toBe(agentPlans(state).length);
  });

  it("rejects a substitution that gains affinity but loses brief or role fit", async () => {
    // With a beam of one, the agent starts from Coast Kid; Grey Lane tests better on Qloo, but the role check doubts it.
    const { state, p } = await run(
      LONDON_BRIEF,
      { roles: { "Grey Lane": { verdict: "doubtful" } } },
      { artistCandidates: [W.otherUs, W.localRapper] },
      [],
      {},
      { beamWidth: 1 },
    );
    expect(p.config!.beamWidth).toBe(1);
    const [round] = p.agent!.rounds;
    expect(round.hypothesis).toMatchObject({ slot: "artist_music" });
    expect(round.hypothesis!.claimIds.length).toBeGreaterThan(0);
    const [attempt] = round.attempts;
    expect(attempt).toMatchObject({
      kind: "challenge",
      accepted: false,
      rejectionCode: "brief_fit_lost",
    });
    expect(attempt.retest!.supportedAfter).toBeGreaterThan(attempt.retest!.supportedBefore);
    expect(label(cand(state, "agent"), "artist_music")).toBe("Coast Kid");
    expect(p.agent!.stop).toBe("no_improvement");
  });

  it("stops when a substitution leads back to a plan already tested", async () => {
    // The unknown user brand is the weakest choice; its first alternative is a bundle the beam already tested.
    const { p } = await run({
      ...LONDON_BRIEF,
      existingChoices: [{ slot: "brand_collaboration", name: "Hackney Clay Collective" }],
    });
    expect(p.agent!.stop).toBe("repeated_plan");
    expect(p.agent!.rounds.at(-1)!.attempts.at(-1)).toMatchObject({
      accepted: false,
      rejectionCode: "repeated_plan",
    });
    const prints = agentPlans({ parallel: p } as RunState).map((c) => planFingerprint(c.plan));
    expect(new Set(prints).size).toBe(prints.length);
  });
});

describe("v3: the budget", () => {
  async function agentWith(evaluations: number) {
    const brief = LaunchBriefSchema.parse(LONDON_BRIEF);
    const market = marketById("london")!;
    const client = worldClient().client;
    const ctx: GatherContext = { client, ledger: createLedger(() => 0), market };
    const anchors = [toRef(W.anchorA), toRef(W.anchorB)];
    const contract = compileIntent(brief, market, {
      names: anchors.map((a) => a.name),
      source: "user",
    });
    const facts = new Map<string, QlooEntity>();
    const roleChecks = new Map<string, RoleCheck>();
    const mctx: MatrixContext = {
      brief,
      city: market.label,
      facts,
      anchorSource: "user",
      contract,
      roleChecks,
      neighborhood: null,
      resolutionEvidence: () => [],
    };
    let used = 0;
    let n = 0;
    const evaluate = async (plan: CulturalPlan) => {
      if (used >= evaluations) throw new BudgetExceeded(used);
      used++;
      for (const e of await client.getEntities(
        plan.components.flatMap((c) => (c.entity ? [c.entity.id] : [])),
      ))
        facts.set(e.id, e);
      return evaluatePlan({
        plan,
        evidence: await gatherEvidence(ctx, plan),
        constraints: brief.constraints,
        city: market.label,
        iteration: 0,
      });
    };
    return runEvidenceAgent({
      llm: worldLlm().llm,
      ctx,
      brief,
      contract,
      anchors,
      countries: new Map(),
      neighborhood: null,
      roleChecks,
      facts,
      evaluate,
      matrix: (c) => buildEvidenceMatrix(c, mctx),
      newIds: () => ({ candidateId: `agent-b${++n}`, blindId: `B${n}` }),
      briefFingerprint: "f",
      rounds: 2,
    });
  }

  it("returns the best fully evaluated plan, and says the budget stopped it", async () => {
    const full = await agentWith(99);
    expect(full.tested.length).toBeGreaterThan(2);
    const cut = await agentWith(2);
    expect(cut.record.stop).toBe("budget");
    expect(cut.tested).toHaveLength(2);
    // Every returned plan was evaluated whole, and the chosen one is among them.
    expect(cut.tested.map((t) => planFingerprint(t.plan))).toContain(planFingerprint(cut.plan));
    expect(cut.evaluation.components.map((c) => c.slot)).toEqual(
      cut.plan.components.map((c) => c.slot),
    );
  });

  it("never invents a plan when nothing could be evaluated", async () => {
    await expect(agentWith(0)).rejects.toBeInstanceOf(BudgetExceeded);
  });
});

describe("v3: honest outcomes and versions", () => {
  const firstShown = (prompt: string) => {
    const first = prompt.match(/^Plan (\S+)/m)![1];
    return {
      verdict: "winner",
      winner: first,
      decisive: [`${first}.1`],
      counter: [],
      dimensionWinners: [],
      rationale: "First plan.",
    };
  };

  it("presents an unstable verdict as a provisional plan, never as the best plan", async () => {
    const { state, p } = await run(LONDON_BRIEF, { judge: firstShown });
    expect(p.verdict).toMatchObject({
      verdict: "unstable",
      stable: false,
      decidedBy: "evidence_order",
      provisional: true,
    });
    const view = parallelView(state)!;
    expect(view.summary).toMatchObject({ provisional: true, headline: "Provisional plan" });
    expect(view.summary.stability).toMatch(/a person should review it/);
    const html = renderToStaticMarkup(createElement(RunResult, { state }));
    expect(html).toContain("Provisional plan:");
    expect(html).not.toContain("Best complete plan");
    expect(toParallelMarkdown(state)).toContain("**Provisional plan:**");

    // A recording from before the flag existed reads the same way.
    const old = structuredClone(state);
    delete (old.parallel!.verdict as { provisional?: boolean }).provisional;
    expect(parallelView(old)!.summary.headline).toBe("Provisional plan");

    const stable = await run();
    expect(stable.p.verdict).toMatchObject({ stable: true, provisional: false });
    expect(parallelView(stable.state)!.summary.headline).toBe("Best complete plan");
  });

  it("records the v3 architecture and what fixed the run's behaviour", async () => {
    const { p } = await run();
    expect(PARALLEL_VERSION).toBe("parallel:v6");
    expect(p.architectureVersion).toBe("parallel:v6");
    expect(p.config).toMatchObject({
      contractVersion: "contract:v1",
      screensVersion: "screens:v6",
      beamWidth: BEAM_WIDTH,
      challengeRounds: 2,
      model: "fake",
    });
    expect(p.config!.promptsFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(p.agent!.bundlesTested).toBeGreaterThan(0);
    for (const s of SLOTS.filter((s) => s !== "creative_direction"))
      expect(p.agent!.pools.some((r) => r.slot === s)).toBe(true);
  });
});

describe("v3: frozen evaluation artifacts", () => {
  const guard = (
    directory: string,
    summaryFile: string,
    existing: string[] = [],
    runVersion = "crash:v15+parallel:v6",
  ) => outputRefusal({ directory, summaryFile, runVersion, frozen: isFrozen, existing });

  it("never writes into a frozen baseline", () => {
    expect(
      guard("eval/out/scenario-runs-parallel-v2", "eval/out/scenario-summary-parallel-v2.json"),
    ).toMatch(/frozen baseline/);
    expect(guard("eval/out/scenario-runs", "eval/out/scenario-summary.json")).toMatch(
      /frozen baseline/,
    );
    expect(
      guard("eval/out/scenario-runs-parallel-v3", "eval/out/scenario-summary-parallel-v2.json"),
    ).toMatch(/scenario-summary-parallel-v2\.json is a frozen baseline/);
    expect(isFrozen("eval\\out\\scenario-runs-parallel-v2\\accessories-mumbai.json")).toBe(true);
    expect(isFrozen("eval/out/scenario-intake.json")).toBe(true);
    expect(isFrozen("eval/out/scenario-runs-parallel-v2b")).toBe(false);
  });

  it("never mixes another architecture's runs into a directory", () => {
    expect(
      guard("eval/out/scenario-runs-sentinel", "eval/out/scenario-summary-sentinel.json", [
        "crash:v15+parallel:v2",
      ]),
    ).toMatch(/holds runs from crash:v15\+parallel:v2/);
    expect(
      guard("eval/out/scenario-runs-sentinel", "eval/out/scenario-summary-sentinel.json", [
        "crash:v15+parallel:v6",
      ]),
    ).toBeNull();
    expect(
      guard("eval/out/scenario-runs-sentinel", "eval/out/scenario-summary-sentinel.json"),
    ).toBeNull();
  });

  it("registers both baselines with their commits and versions", () => {
    expect(FROZEN["parallel-v2"]).toMatchObject({
      commit: "40aa69d",
      runVersion: "crash:v15+parallel:v2",
    });
    expect(FROZEN.sequential).toMatchObject({ commit: "e217f3f", runVersion: "crash:v15" });
    expect(
      frozenFiles(
        "parallel-v2",
        () => ["a.json", "b.json"],
        () => true,
      ),
    ).toEqual([
      "eval/out/scenario-runs-parallel-v2/a.json",
      "eval/out/scenario-runs-parallel-v2/b.json",
      "eval/out/scenario-summary-parallel-v2.json",
    ]);
  });
});
