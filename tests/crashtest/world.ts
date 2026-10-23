import { nameKey } from "@/lib/engine/stats";
import type { LlmClient } from "@/lib/llm/types";
import type { InsightsInput, InsightsResult, InsightsTag, QlooClient, QlooEntity } from "@/lib/qloo";
import { entity, tag } from "../engine/helpers";

/**
 * A small synthetic Qloo world for crash-test runs (names are made up; no real responses).
 * London audience of two streetwear anchors; a US rapper the audience doesn't follow there,
 * a local rapper it does, a local brand, a venue, and aesthetic tags.
 */

const T = {
  artist: "urn:entity:artist",
  brand: "urn:entity:brand",
  place: "urn:entity:place",
};

export const W = {
  anchorA: entity("a1", { name: "Northcap", type: T.brand }),
  anchorB: entity("a2", { name: "Deckhouse", type: T.brand }),
  usRapper: entity("us1", { name: "Big Tex", type: T.artist, shortDescription: "American rapper.", popularity: 0.999 }),
  localRapper: entity("uk1", { name: "Grey Lane", type: T.artist, shortDescription: "British rapper from Northampton." }),
  canalEcho: entity("uk2", { name: "Canal Echo", type: T.artist, shortDescription: "English DJ and producer." }),
  otherUs: entity("us2", { name: "Coast Kid", type: T.artist, shortDescription: "American singer." }),
  localBrand: entity("b1", { name: "Mossgrove", type: T.brand, shortDescription: "Streetwear label" }),
  altBrand: entity("b2", { name: "Fieldnote", type: T.brand, shortDescription: "Fieldnote is a British workwear label." }),
  venue: entity("p1", {
    name: "Yard Market",
    type: T.place,
    geocode: { city: "London", metro: null, countryCode: "GB", latitude: null, longitude: null },
    tags: [tag("urn:tag:category:place:event_venue", "urn:tag:category:place", "Event venue")],
  }),
};

const tagsOf = (names: string[]): InsightsTag[] =>
  names.map((n, i) => ({
    id: `urn:tag:aesthetic_property:qloo:${nameKey(n)}`,
    name: n,
    subtype: "urn:tag:aesthetic_property:qloo",
    popularity: 0.9,
    affinity: 0.99 - i * 0.01,
    rank: i + 1,
  }));

export interface WorldOptions {
  /** Artists the repair query returns (default: the local rapper, then another US act). */
  artistCandidates?: QlooEntity[];
  /** Fail every Insights call with this error. */
  insightsError?: Error;
  /** Kinds no Qloo list returns at all (neither the audience lists nor the city's own list). */
  noCandidates?: ("artist" | "brand")[];
}

export function worldClient(opts: WorldOptions = {}) {
  const calls: InsightsInput[] = [];
  const all = Object.values(W);
  const anchors = new Set([W.anchorA.id, W.anchorB.id]);
  const asResult = (es: QlooEntity[], tags: InsightsTag[] = []): InsightsResult => ({
    entities: es.map((e, i) => ({
      ...e,
      rank: i + 1,
      affinity: 0.98 - i * 0.01,
      affinityRank: null,
      explainability: { [W.anchorA.id]: 0.6, [W.anchorB.id]: 0.4 },
    })),
    tags,
    aggregateExplainability: null,
    durationMs: null,
  });

  const client: QlooClient = {
    async searchEntities({ query, types }) {
      const q = nameKey(query.replace(/ London$/, ""));
      return all
        .filter((e) => nameKey(e.name) === q && (!types || types.includes(e.type ?? "")))
        .map((e, i) => ({ ...e, rank: i + 1 }));
    },
    async getEntities(ids) {
      return all.filter((e) => ids.includes(e.id));
    },
    async getInsights(input) {
      calls.push(input);
      if (opts.insightsError) throw opts.insightsError;
      const loc = input.signalLocationQuery ?? input.filterLocationQuery;
      if (input.filterType === "urn:tag") {
        if (!input.signalEntities?.length) return asResult([]);
        if (loc === "London") return asResult([], tagsOf(["Industrial", "Utilitarian", "Monochrome"]));
        if (loc === "New York City") return asResult([], tagsOf(["Playful", "Pastel Colors", "Industrial"]));
        return asResult([], tagsOf(["Classic"]));
      }
      // Scoring single entities: the US rapper is never returned under London's signal.
      if (input.resultEntities) {
        return asResult(all.filter((e) => input.resultEntities!.includes(e.id) && e !== W.usRapper));
      }
      const kind = input.filterType === T.artist ? "artist" : input.filterType === T.brand ? "brand" : "place";
      if (kind !== "place" && opts.noCandidates?.includes(kind)) return asResult([]);
      const exclude = new Set(input.excludeEntities ?? []);
      if (input.signalEntities?.length) {
        if (loc !== "London") return asResult([]);
        const pool =
          input.filterType === T.artist
            ? (opts.artistCandidates ?? [W.localRapper, W.otherUs])
            : input.filterType === T.brand
              ? [W.localBrand, W.altBrand]
              : [W.venue];
        return asResult(pool.filter((e) => !exclude.has(e.id) && !anchors.has(e.id)));
      }
      // Location-only city lists for the locality checks.
      if ((input.page ?? 1) > 1) return asResult([]);
      if (loc === "London") {
        if (input.filterType === T.artist) return asResult([W.localRapper]);
        if (input.filterType === T.brand) return asResult([W.localBrand, W.altBrand]);
        return asResult([W.venue]);
      }
      if (loc === "New York City" && input.filterType === T.artist) return asResult([W.usRapper, W.otherUs]);
      return asResult([]);
    },
    async getDemographics() {
      return [];
    },
    async searchTags() {
      return [];
    },
    async compareProfiles() {
      throw new Error("not used");
    },
  };
  return { client, calls };
}

/** A fake model that answers each step of a crash test by recognising its system prompt. */
/**
 * A fake blind judge that decides only from the claims it is shown: each plan scores +1 per
 * supporting claim and -1 per contradicting one; the best plan wins, equal plans tie. It never
 * looks at position, so a fair adjudicator should reach the same verdict in both orders.
 */
export function evidenceJudge(prompt: string) {
  const score = new Map<string, number>();
  const claims = new Map<string, string[]>();
  for (const line of prompt.split("\n")) {
    const plan = line.match(/^Plan (\S+)/);
    if (plan) score.set(plan[1], 0);
    const claim = line.match(/^\s+((\S+)\.\d+) · [^·]+ · (supports|contradicts|unknown)/);
    if (claim) {
      const [, id, blind, stance] = claim;
      score.set(blind, (score.get(blind) ?? 0) + (stance === "supports" ? 1 : stance === "contradicts" ? -1 : 0));
      if (stance === "supports") claims.set(blind, [...(claims.get(blind) ?? []), id]);
    }
  }
  const ranked = [...score].sort((a, b) => b[1] - a[1]);
  if (ranked.length < 2 || ranked[0][1] === ranked[1][1])
    return { verdict: "tie", winner: null, decisive: [], counter: [], dimensionWinners: [], rationale: "The claims don't separate the plans." };
  const winner = ranked[0][0];
  return { verdict: "winner", winner, decisive: (claims.get(winner) ?? []).slice(0, 3), counter: [], dimensionWinners: [], rationale: `Plan ${winner} has more supporting claims.` };
}

export function worldLlm(
  over: {
    draft?: Record<string, unknown>;
    pick?: string | string[];
    reason?: string;
    propose?: string[];
    /** The blind judge's answer for a prompt (default: the evidence-only fake judge). */
    judge?: (prompt: string, call: number) => unknown;
    /** Anchor hypotheses when the brief names none. */
    anchors?: { name: string; country: string }[];
    /** The country the model gives for every act or brand the user named. */
    choiceCountry?: string;
    /** The structured role check's reading of a candidate, by label (default: fits, keeps the product central). */
    roles?: Record<string, { verdict: "fits" | "doubtful" | "wrong"; central?: boolean; reason?: string }>;
  } = {},
) {
  const prompts: string[] = [];
  /** Every call with its system prompt, to check what each step was shown. */
  const calls: { system: string; prompt: string }[] = [];
  let judgeCalls = 0;
  const llm: LlmClient = {
    provider: "fake",
    model: "fake",
    async generateText({ system, prompt }) {
      prompts.push(prompt);
      calls.push({ system, prompt });
      const reply = (x: unknown) => ({ text: typeof x === "string" ? x : JSON.stringify(x), usage: null, model: "fake", ms: 1 });
      if (system.startsWith("You compare anonymous launch plans"))
        return reply(over.judge ? over.judge(prompt, judgeCalls++) : evidenceJudge(prompt));
      if (system.startsWith("For each music act or brand named below"))
        return reply({
          choices: prompt
            .split("\n")
            .filter((l) => l.startsWith("- "))
            .map((l) => ({ name: l.slice(2), country: over.choiceCountry ?? "United Kingdom" })),
        });
      if (system.startsWith("Suggest broader, established audience anchors"))
        return reply({ anchors: [{ name: "Northcap", country: "United Kingdom" }, { name: "Deckhouse", country: "United Kingdom" }] });
      if (system.startsWith("Suggest audience anchors for measurement only"))
        return reply({ anchors: over.anchors ?? [{ name: "Northcap", country: "United Kingdom" }, { name: "Deckhouse", country: "United Kingdom" }] });
      if (system.startsWith("You are a brand strategist"))
        return reply({
          anchors: ["Northcap", "Deckhouse"],
          artist: "Big Tex",
          brand: "Mossgrove",
          venue: "Yard Market",
          venueCategory: "event_venue",
          direction: "Industrial and utilitarian",
          assumptions: ["Assumed a one-weekend event."],
          ...over.draft,
        });
      if (system.startsWith("Turn a description of a product launch"))
        return reply({
          brandName: "Test Label",
          productCategory: "Streetwear",
          launchGoal: "Pop-up launch",
          audienceDescription: "Streetwear fans in London",
          audienceAnchors: ["Northcap", "Deckhouse"],
          brandAttributes: ["understated"],
          budgetBand: "",
          choices: [{ slot: "artist_music", name: "Big Tex" }],
          keep: [],
          exclude: ["Mossgrove"],
          otherRules: [],
        });
      if (system.startsWith("Map a creative direction"))
        return reply({ tags: ["Industrial", "Utilitarian"], note: "Close match." });
      if (system.startsWith("You are a cultural strategist who lives in")) return reply({ names: over.propose ?? [] });
      if (system.startsWith("You repair one weak choice")) {
        const ids = over.pick === undefined ? [W.localRapper.id] : [over.pick].flat();
        if (ids[0] === "none") return reply({ choices: [], none: over.reason ?? "None fits." });
        return reply({
          choices: ids.map((id) => ({ id, reason: over.reason ?? "Ranks first for this audience in London and is from here.", expectedEffect: "Audience affinity found." })),
        });
      }
      if (system.startsWith("Revise a launch's creative direction") || system.startsWith("Write a launch's creative direction"))
        return reply({ tags: ["Industrial"], direction: "Industrial", reason: "Top here.", expectedEffect: "Supported." });
      if (system.startsWith("You screen candidates for one job")) {
        // Every candidate fits unless the test reads it otherwise; ids are copied from the prompt.
        return reply({
          candidates: prompt
            .split("\n")
            .map((l) => l.match(/^(c\d+): (.+?)(?: — |$)/))
            .filter((m): m is RegExpMatchArray => !!m)
            .map(([, id, label]) => {
              const r = over.roles?.[label];
              return { id, verdict: r?.verdict ?? "fits", central: r?.central ?? true, reason: r?.reason ?? (r?.verdict === "wrong" ? `${label} can't do this job.` : `${label} can do this job.`) };
            }),
        });
      }
      if (system.startsWith("Write a 2-3 sentence")) return reply("Verdict from the recorded facts.");
      throw new Error(`no scripted reply for: ${system.slice(0, 50)}`);
    },
  };
  return { llm, prompts, calls };
}

export const LONDON_BRIEF = {
  brandName: "Test Label",
  productCategory: "Streetwear",
  launchGoal: "Pop-up launch",
  marketId: "london",
  audienceDescription: "Streetwear fans in London",
  audienceAnchors: ["Northcap", "Deckhouse"],
  depth: "quick" as const,
};

/**
 * Add made-up entities to the synthetic world: each ranks above the world's own in every list of
 * its type for London (audience and city lists), is scored like any other, and resolves by name.
 * `places` answers location queries for a named neighbourhood ("Shoreditch, London").
 */
export function withExtras(client: QlooClient, extras: QlooEntity[], places: Record<string, QlooEntity[]> = {}): QlooClient {
  const result = (es: QlooEntity[]): InsightsResult => ({
    entities: es.map((e, i) => ({ ...e, rank: i + 1, affinity: 0.99 - i * 0.01, affinityRank: null, explainability: null })),
    tags: [],
    aggregateExplainability: null,
    durationMs: null,
  });
  return {
    ...client,
    async searchEntities(input) {
      const q = nameKey(input.query.replace(/ London$/, ""));
      const own = extras.filter((e) => nameKey(e.name) === q && (!input.types || input.types.includes(e.type ?? ""))).map((e, i) => ({ ...e, rank: i + 1 }));
      return [...own, ...(await client.searchEntities(input))];
    },
    async getEntities(ids) {
      return [...extras.filter((e) => ids.includes(e.id)), ...(await client.getEntities(ids))];
    },
    async getInsights(input) {
      const loc = input.signalLocationQuery ?? input.filterLocationQuery ?? "";
      if (places[loc]) return result(places[loc]);
      const base = await client.getInsights(input);
      if (input.resultEntities) {
        const own = extras.filter((e) => input.resultEntities!.includes(e.id));
        return { ...base, entities: [...result(own).entities, ...base.entities].map((e, i) => ({ ...e, rank: i + 1 })) };
      }
      if (loc !== "London" || (input.page ?? 1) > 1 || input.filterType === "urn:tag") return base;
      const own = extras.filter((e) => e.type === input.filterType && !(input.excludeEntities ?? []).includes(e.id));
      return { ...base, entities: [...result(own).entities, ...base.entities].map((e, i) => ({ ...e, rank: i + 1, affinity: 0.99 - i * 0.01 })) };
    },
  };
}
