import { z } from "zod";
import { cityList } from "@/lib/engine/equivalents";
import { mapLimit, nameKey } from "@/lib/engine/stats";
import { generateStructured } from "@/lib/llm/structured";
import type { LlmClient } from "@/lib/llm/types";
import type { Market } from "@/lib/markets";
import type { InsightsInput, QlooEntity } from "@/lib/qloo";
import { fitConcerns } from "@/lib/operational/gate";
import type { OperationalResearchClient } from "@/lib/operational/types";
import { BudgetExceeded } from "./ledger";
import type { GatherContext } from "./gather";
import { judgeHybrid } from "./hybrid";
import type { IntentContract } from "./intent";
import { itemsFrom, sanitizeInsights } from "./ledger";
import { compareVectors, evidenceVector, roleKey } from "./matrix";
import { briefText, categoryOf, directionVocabulary, findInMarket, findPlace, mapDirection, resolveEntityComponent, toRef } from "./plan";
import { briefTerms, categoryOfVenue, fitsBrief, isFoodAndDrink, repairDirection, screen, type DraftTrial } from "./repair";
import { PRESTIGE, avoidedMatch, brandRole, centralityFlag, distanceKm, mainstreamFlag, neighborhoodFit, preferredCategories, selectionHostTier, type Centroid, type RoleCheck } from "./screens";
import {
  SLOTS,
  SLOT_LABEL,
  SLOT_TYPE,
  type AgentRecord,
  type CandidatePlan,
  type CandidateView,
  type Component,
  type ComponentAssessment,
  type ComponentSource,
  type CulturalPlan,
  type EntityRef,
  type EvidenceMatrix,
  type HybridAttempt,
  type ImprovementRound,
  type LaunchBrief,
  type OpenSlot,
  type PlanEvaluation,
  type PoolRecord,
  type Slot,
} from "./types";

/**
 * The single evidence agent (parallel:v3). One agent, no sub-agents: it pools candidates from
 * several Qloo views per slot, screens them against the brief-intent contract, composes complete
 * plans by bounded beam search, evaluates each complete plan with the same rubric as every track,
 * and then challenges its own weakest choice for a bounded number of rounds. It receives the
 * frozen brief, the shared anchors, the contract and the brief's locks. It never sees the LLM's
 * plan, and it doesn't start from the user's plan: a locked user choice is mandatory, an unlocked
 * one is just another candidate (a stated preference).
 */

export const VIEW_SIZE = 25;
/** Candidates composed into bundles per slot, and kept in reserve for the challenge loop. */
export const POOL_SIZE = 6;
export const RESERVE_SIZE = 12;
export const BEAM_WIDTH = 6;
/** Candidates per slot the structured role check reads. */
export const ROLE_CHECK_SIZE = 10;
/** How far around a confirmed neighbourhood's point its venues are pooled. */
export const NEIGHBORHOOD_RADIUS_M = 2000;
export const CHALLENGE_ROUNDS = { quick: 2, thorough: 3 } as const;
/** How many of its top venues the agent checks on the web before choosing (one search each). */
export const WEB_CHECK_VENUES = 3;

type EntitySlot = Exclude<Slot, "creative_direction">;
type Lane = PoolRecord["lanes"][number];

/** A candidate's standing before any plan is tested, as additive parts (see bundleVector). */
export interface Proxy {
  hard: number;
  lock: number;
  /** A choice the brief names plainly (not fixed, not only considered): kept unless it concretely can't do the job (parallel:v9). */
  named: number;
  roleBad: number;
  briefBad: number;
  /** In (+1), outside (-0.5) or far from (-1) a neighbourhood the brief names: brief fit, ranked above affinity. */
  hood: number;
  /** Role doubts and centrality flags, net of the user's stated preference for it. */
  doubt: number;
  weakAudience: number;
  audience: number;
  local: number;
  distinct: number;
}

export interface PoolCandidate {
  slot: Slot;
  component: Component;
  entity: QlooEntity | null;
  source: "qloo" | "user";
  views: Partial<Record<CandidateView, number>>;
  evidenceIds: string[];
  lanes: Lane[];
  screens: PoolRecord["screens"];
  proxy: Proxy;
}

const ZERO: Proxy = { hard: 0, lock: 0, named: 0, roleBad: 0, briefBad: 0, hood: 0, doubt: 0, weakAudience: 0, audience: 0, local: 0, distinct: 0 };

/** A partial or complete bundle's search order: the v3 plan-comparison order, on pre-test facts only. */
export function bundleVector(parts: Proxy[]): number[] {
  const s = parts.reduce((a, p) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k as keyof Proxy] + p[k as keyof Proxy]])) as unknown as Proxy, { ...ZERO });
  // Requested distinctiveness ranks with brief fit, above affinity (screens:v4).
  return [-s.hard, s.lock, s.named, -s.roleBad, -s.briefBad, s.hood, -s.distinct, -s.doubt, -s.weakAudience, s.audience, s.local];
}

const sameEntity = (a: Component, b: Component) => (a.entity && b.entity ? a.entity.id === b.entity.id : nameKey(a.label) === nameKey(b.label));

/**
 * Bounded beam search over complete plans: slot by slot, extend each partial bundle with each
 * pooled candidate, keep the best `width` by bundleVector. Never the full Cartesian product.
 * A slot with an empty pool stays open.
 */
export function beamSearch(pools: Map<Slot, PoolCandidate[]>, width = BEAM_WIDTH): PoolCandidate[][] {
  let beam: PoolCandidate[][] = [[]];
  for (const slot of SLOTS) {
    const pool = pools.get(slot) ?? [];
    if (!pool.length) continue;
    const next: PoolCandidate[][] = [];
    for (const partial of beam) for (const c of pool) if (!partial.some((p) => sameEntity(p.component, c.component))) next.push([...partial, c]);
    if (!next.length) continue;
    // Stable: equal bundles keep the order they were built in.
    beam = next
      .map((b, i) => ({ b, i, v: bundleVector(b.map((x) => x.proxy)) }))
      .sort((x, y) => compareVectors(y.v, x.v) || x.i - y.i)
      .slice(0, width)
      .map((x) => x.b);
  }
  return beam;
}

/** The plan's fingerprint: which entity (or label and tags) fills each slot. */
export const planFingerprint = (p: CulturalPlan) =>
  SLOTS.map((s) => {
    const c = p.components.find((x) => x.slot === s);
    return c ? `${s}=${c.entity?.id ?? c.label.toLowerCase()}|${c.tags.map((t) => t.id).sort().join(",")}` : `${s}=open`;
  }).join(";");

// ---------- the structured role check ----------

const roleSchema = z.object({
  candidates: z.array(
    z.object({
      id: z.string().describe("the candidate's id, copied exactly"),
      verdict: z.enum(["fits", "doubtful", "wrong"]),
      central: z.boolean().describe("false when the candidate would make the launch about itself instead of the product"),
      reason: z.string().describe("one short sentence citing the facts given"),
    }),
  ),
});

export const ROLE_SYSTEM =
  "You screen candidates for one job in a product launch plan. For each candidate, say whether it can credibly do that job for this brief (fits, doubtful or wrong), and whether it keeps the product central. \"wrong\" is only for a concrete reason it cannot do this kind of job: it is not that kind of entity (not a performer, not a brand, not a place that hosts events), it is the launching brand itself, it breaks a rule the brief states, or the facts given show it is the wrong kind of establishment for the event. Taste, audience fit, fame and how well it matches the brand's style are measured elsewhere: at most \"doubtful\", never \"wrong\". A choice the brief itself names is the marketer's own and is \"wrong\" only for one of those concrete reasons. Use only the brief and the facts given for each candidate. Never claim availability, size, prices, attendance or sales. One short reason each.";

const JOB: Record<EntitySlot, string> = {
  artist_music: "the music act for the launch event",
  brand_collaboration: "an external brand to collaborate with on the launch (never the launching brand itself)",
  event_place: "the venue that hosts the launch event",
};

const factLine = (e: QlooEntity) =>
  [
    e.shortDescription,
    e.tags
      .filter((t) => /category:place|genre/.test(t.id))
      .map((t) => t.name ?? t.id.split(":").at(-1))
      .slice(0, 5)
      .join(", "),
    e.geocode?.city ? `in ${e.geocode.city}` : "",
  ]
    .filter(Boolean)
    .join("; ");

/** One structured model call per slot: does each candidate do the job, and keep the product central? */
export async function checkRoles(
  llm: LlmClient,
  ctx: GatherContext,
  brief: LaunchBrief,
  contract: IntentContract,
  slot: EntitySlot,
  items: { key: string; label: string; entity: QlooEntity | null }[],
): Promise<Map<string, RoleCheck>> {
  const out = new Map<string, RoleCheck>();
  if (!items.length) return out;
  const alias = new Map(items.map((x, i) => [`c${i + 1}`, x]));
  const { data } = await generateStructured(llm, {
    schema: roleSchema,
    system: ROLE_SYSTEM,
    prompt: [
      briefText(brief, ctx.market),
      contract.formats.length ? `Event: ${contract.formats.map((f) => f.phrase).join(", ")}` : "",
      contract.negative.length ? `The brief avoids: ${contract.negative.map((n) => n.phrase).join("; ")}` : "",
      `Job: ${JOB[slot]}.`,
      `Candidates:\n${[...alias].map(([id, x]) => `${id}: ${x.label}${x.entity ? ` — ${factLine(x.entity)}` : " — not in Qloo; no facts"}`).join("\n")}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    label: `screen:${slot}`,
  });
  const record = ctx.ledger.add({
    purpose: `Structured role check: can each candidate be ${JOB[slot]}?`,
    queryKind: "review",
    sanitizedRequest: { slot, candidates: items.map((x) => x.label) },
    qlooEntityIds: items.flatMap((x) => (x.entity ? [x.entity.id] : [])),
    results: data.candidates.flatMap((c) => {
      const x = alias.get(c.id.trim());
      return x ? [{ id: x.entity?.id ?? x.key, name: `${x.label}: ${c.verdict}${c.central ? "" : ", overshadows the product"}` }] : [];
    }),
    resultCount: data.candidates.length,
    coverageStatus: data.candidates.length ? "usable" : "empty",
    warnings: [],
  });
  for (const c of data.candidates) {
    const x = alias.get(c.id.trim());
    if (x) out.set(x.key, { verdict: c.verdict, central: c.central, reason: c.reason, evidenceId: record.evidenceId });
  }
  return out;
}

// ---------- the agent's own proposals ----------

/** Names the agent proposes for an open slot; each must still resolve in Qloo and pass every screen. */
export const PROPOSAL_SIZE = 5;

const proposalSchema = z.object({
  names: z.array(z.string()).max(PROPOSAL_SIZE).describe("real, currently operating names, most suitable first"),
});

export const PROPOSAL_SYSTEM =
  "You suggest candidates for one job in a product launch plan in one city. Name real, specific, currently operating candidates that a strong local strategist would shortlist for this brief: the right kind of place or act for the stated event, in the area the brief names when it names one, and suited to the audience. Names only, most suitable first. They will be checked against Qloo and screened; do not invent names.";

/**
 * For a slot the brief leaves open, one bounded model call proposes up to PROPOSAL_SIZE names
 * (parallel:v9). Each is resolved in Qloo in this city; unresolved names are dropped, and the rest
 * enter the pool as one more view, screened exactly like Qloo's own candidates. The agent never
 * sees the LLM track's plan.
 */
async function proposeForSlot(input: AgentInput, slot: EntitySlot): Promise<QlooEntity[]> {
  const { ctx, brief, contract } = input;
  const { data } = await generateStructured(input.llm, {
    schema: proposalSchema,
    system: PROPOSAL_SYSTEM,
    prompt: [
      briefText(brief, ctx.market),
      contract.neighborhoods.length ? `Area named in the brief: ${contract.neighborhoods.map((n) => n.value).join(", ")}` : "",
      contract.formats.length ? `Event: ${contract.formats.map((f) => f.phrase).join(", ")}` : "",
      contract.negative.length ? `The brief avoids: ${contract.negative.map((n) => n.phrase).join("; ")}` : "",
      `Job: ${JOB[slot]} in ${ctx.market.label}.`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    label: `propose:${slot}`,
  });
  const names = [...new Set(data.names.map((n) => n.trim()).filter(Boolean))].slice(0, PROPOSAL_SIZE);
  const found = await mapLimit(names, 3, async (name) => {
    try {
      return slot === "event_place" ? await findPlace(ctx.client, name, ctx.market) : await findInMarket(ctx.client, name, [slot === "artist_music" ? "artist" : "brand"], ctx.market);
    } catch (err) {
      if (err instanceof BudgetExceeded) throw err;
      return null;
    }
  });
  const entities = found.filter((e): e is QlooEntity => !!e);
  ctx.ledger.add({
    purpose: `The agent's own ${SLOT_LABEL[slot].toLowerCase()} proposals for the open slot, resolved in Qloo`,
    queryKind: "search",
    sanitizedRequest: { slot, proposed: names },
    qlooEntityIds: entities.map((e) => e.id),
    results: names.map((n, i) => ({ id: found[i]?.id ?? n, name: `${n}: ${found[i] ? `found as ${found[i]!.displayName}` : "not found in Qloo"}` })),
    resultCount: entities.length,
    coverageStatus: entities.length ? "usable" : "empty",
    warnings: [],
  });
  return entities;
}

// ---------- pooling ----------

export interface AgentInput {
  llm: LlmClient;
  ctx: GatherContext;
  brief: LaunchBrief;
  contract: IntentContract;
  anchors: EntityRef[];
  /** Name (lower case) → country, for the user's named acts and brands. */
  countries: Map<string, string>;
  neighborhood: Centroid | null;
  /** Shared role readings; the agent adds its own. */
  roleChecks: Map<string, RoleCheck>;
  /** Full Qloo records, shared with the evidence matrix. */
  facts: Map<string, QlooEntity>;
  evaluate(plan: CulturalPlan): Promise<PlanEvaluation>;
  matrix(candidates: CandidatePlan[]): EvidenceMatrix;
  newIds(): { candidateId: string; blindId: string };
  briefFingerprint: string;
  rounds: number;
  beamWidth?: number;
  /** Optional cited web fit check for the agent's own top venues (parallel:v11). */
  operational?: OperationalResearchClient;
  signal?: AbortSignal;
}

const DOMAIN: Record<EntitySlot, "artist" | "brand" | "place"> = { artist_music: "artist", brand_collaboration: "brand", event_place: "place" };

/** A named choice the screens show concretely can't do its job: a hard failure, or the role check's "wrong". */
const cantDoJob = (s: PoolRecord["screens"]) => s.role === "fail" || s.notes.includes("role check: wrong");

function proxyOf(c: Omit<PoolCandidate, "proxy">, strength: "locked" | "preferred" | "considered" | undefined): Proxy {
  const s = c.screens;
  const rank = c.views.audience ?? c.views.combined;
  return {
    hard: s.role === "fail" && s.notes.some((n) => n.startsWith("hard:")) ? 1 : 0,
    lock: strength === "locked" ? 1 : 0,
    named: c.source === "user" && strength === "preferred" && !cantDoJob(s) ? 1 : 0,
    roleBad: s.role === "fail" ? 1 : 0,
    briefBad: s.brief === "fail" ? 1 : s.brief === "flag" ? 0.5 : 0,
    hood: s.hood === "near" ? 1 : s.hood === "outside" ? -0.5 : s.hood === "far" ? -1 : 0,
    doubt: (s.role === "doubtful" ? 1 : 0) + (s.central === "flag" ? 0.5 : 0) - (strength === "preferred" ? 0.5 : strength === "considered" ? 0.25 : 0),
    weakAudience: rank === undefined ? 1 : 0,
    audience: rank === undefined ? 0 : Math.max(0, 1 - (rank - 1) / VIEW_SIZE),
    local: s.locality === "pass" ? 1 : s.locality === "fail" ? -1 : 0,
    distinct: s.distinct === "flag" ? 1 : 0,
  };
}

/** Screen one entity candidate with the shared screens; the role check is applied afterwards. */
async function screenEntity(
  input: AgentInput,
  slot: EntitySlot,
  e: QlooEntity,
  locality: Map<string, { local: boolean; why: string }>,
): Promise<PoolRecord["screens"]> {
  const { brief, contract, ctx } = input;
  const food = isFoodAndDrink(brief.productCategory);
  const notes: string[] = [];
  let role = "pass";
  if (slot === "artist_music" && e.type !== "urn:entity:artist") role = "fail";
  if (slot === "brand_collaboration" && brief.brandName && nameKey(e.displayName) === nameKey(brief.brandName)) {
    role = "fail";
    notes.push("hard: the launching brand itself");
  }
  if (slot === "brand_collaboration" && role !== "fail") {
    // Qloo's own tags say whether it is a product brand at all (screens:v4).
    const b = brandRole(e);
    if (b.kind === "institution") role = "fail";
    if (b.kind === "not_product") role = "doubtful";
    if (b.kind !== "product") notes.push(`brand: ${b.kind === "institution" ? "an institution, not a brand" : b.kind === "not_product" ? "not a product brand" : "Qloo doesn't say"}${b.genres.length ? ` (${b.genres.join(", ")})` : ""}`);
  }
  if (slot === "event_place") {
    const tier = selectionHostTier(e.tags.map((t) => t.id), contract, food);
    if (tier === "unsuitable") role = "fail";
    else if (tier !== "preferred") role = "doubtful";
    notes.push(`host: ${tier}`);
    if (e.geocode?.countryCode && e.geocode.countryCode.toUpperCase() !== ctx.market.country) {
      role = "fail";
      notes.push(`hard: not in ${ctx.market.label}'s country`);
    }
  }
  const l = locality.get(e.id);
  let local = l ? (l.local ? "pass" : l.why === "from another country" ? "flag" : "unknown") : "unknown";
  let hood: PoolRecord["screens"]["hood"];
  if (slot === "event_place") {
    const n = neighborhoodFit(e, input.neighborhood, contract.neighborhoods[0]?.value);
    hood = n.fit;
    // Outside a neighbourhood the brief names is never local, whatever the city list says.
    if (n.fit === "near") local = "pass";
    if (n.fit === "far" || n.fit === "outside") local = "flag";
    if (n.named) notes.push(`Qloo places it in ${contract.neighborhoods[0]?.value}`);
    if (n.km !== null) notes.push(`${n.km.toFixed(1)} km from ${contract.neighborhoods[0]?.value}`);
  }
  const ruled = fitsBrief(e, brief, { requireAttributes: false });
  const terms = slot === "brand_collaboration" && briefTerms(brief).size ? fitsBrief(e, brief, { requireAttributes: true }) : { ok: true };
  const avoided = avoidedMatch(e, contract);
  const briefScreen = !ruled.ok ? "fail" : avoided ? "flag" : terms.ok ? "pass" : "unknown";
  if (!ruled.ok) notes.push(`hard: ${ruled.why}`);
  if (avoided) notes.push(`avoided: ${avoided}`);
  const central = centralityFlag(slot, e, contract);
  if (central) notes.push(central);
  if (!ruled.ok) role = "fail";
  return {
    role,
    locality: local,
    hood,
    brief: briefScreen,
    distinct: mainstreamFlag(e.popularity, contract) ? "flag" : "pass",
    central: central ? "flag" : "pass",
    notes,
  };
}

async function entityPool(input: AgentInput, slot: EntitySlot, fixed: Component[], user: { component: Component; strength: "locked" | "preferred" | "considered" } | null, records: PoolRecord[], trials: DraftTrial[]) {
  const { ctx, contract, brief, anchors } = input;
  const place = slot === "event_place";
  const food = isFoodAndDrink(brief.productCategory);
  const categories = place ? preferredCategories(contract, food) : [];
  const banned = new Set(
    [...brief.constraints.flatMap((c) => (c.kind === "hard" ? (c.excludeNames ?? []) : [])), ...anchors.map((a) => a.name), brief.brandName ?? "", ...fixed.map((f) => f.label)]
      .filter(Boolean)
      .map(nameKey),
  );
  const views: { view: CandidateView; entities: QlooEntity[]; evidenceId: string }[] = [];
  const ask = async (view: CandidateView, purpose: string, q: InsightsInput) => {
    const r = await ctx.client.getInsights(q);
    const rec = ctx.ledger.add({
      purpose,
      queryKind: "insights",
      sanitizedRequest: sanitizeInsights(q),
      qlooEntityIds: q.signalEntities ?? [],
      results: itemsFrom(r),
      resultCount: r.entities.length,
      coverageStatus: r.entities.length >= 10 ? "usable" : r.entities.length ? "partial" : "empty",
      warnings: [],
    });
    views.push({ view, entities: r.entities, evidenceId: rec.evidenceId });
  };
  const what = SLOT_LABEL[slot].toLowerCase();
  const base: InsightsInput = {
    filterType: SLOT_TYPE[slot],
    signalEntities: anchors.map((a) => a.id),
    signalLocationQuery: place ? undefined : ctx.market.qlooLocation,
    filterLocationQuery: place ? ctx.market.qlooLocation : undefined,
    filterTags: categories.length ? categories : undefined,
    filterTagsOperator: categories.length ? "union" : undefined,
    take: VIEW_SIZE,
  };
  const others = fixed.flatMap((f) => (f.entity ? [f.entity.id] : []));
  const asks: Promise<void>[] = [ask("audience", `Pool ${what} candidates for this audience in ${ctx.market.label}`, base)];
  if (others.length) asks.push(ask("combined", `Pool ${what} candidates for this audience with the plan's fixed choices`, { ...base, signalEntities: [...base.signalEntities!, ...others] }));
  // Venues in the named neighbourhood: around its confirmed point when known (a text query like
  // "Bushwick, New York City" returns the city's landmarks), else by name.
  if (place && contract.neighborhoods[0]) {
    const hood = input.neighborhood;
    asks.push(
      ask(
        "neighborhood",
        `Pool venues in ${contract.neighborhoods[0].value}, which the brief names`,
        hood
          ? { ...base, filterLocationQuery: undefined, extraParams: { "filter.location": `POINT(${hood.lon} ${hood.lat})`, "filter.location.radius": NEIGHBORHOOD_RADIUS_M } }
          : { ...base, filterLocationQuery: `${contract.neighborhoods[0].value}, ${ctx.market.qlooLocation}` },
      ),
    );
  }
  // An open slot also gets the agent's own proposals, verified in Qloo like every other view.
  if (!user)
    asks.push(
      proposeForSlot(input, slot).then((entities) => {
        views.push({ view: "proposals", entities, evidenceId: ctx.ledger.records.at(-1)!.evidenceId });
      }),
    );
  await Promise.all(asks);
  const top = (await cityList(ctx.client, DOMAIN[slot], ctx.market.qlooLocation, categories)).slice(0, VIEW_SIZE);
  const localRec = ctx.ledger.add({
    purpose: `${ctx.market.label}'s own top list for ${what}s`,
    queryKind: "insights",
    sanitizedRequest: { "filter.type": SLOT_TYPE[slot], "location.query": ctx.market.qlooLocation, "filter.tags": categories },
    qlooEntityIds: [],
    results: top.slice(0, 8).map((e, i) => ({ id: e.id, name: e.displayName, rank: i + 1 })),
    resultCount: top.length,
    coverageStatus: top.length >= 10 ? "usable" : top.length ? "partial" : "empty",
    warnings: [],
  });
  views.push({ view: "local", entities: top, evidenceId: localRec.evidenceId });

  // Deduplicate by Qloo entity, keeping each candidate's rank in every view.
  const byId = new Map<string, { e: QlooEntity; views: Partial<Record<CandidateView, number>>; ids: Set<string> }>();
  for (const v of views)
    v.entities.forEach((e, i) => {
      if (banned.has(nameKey(e.name)) || banned.has(nameKey(e.displayName))) return;
      const x = byId.get(e.id) ?? { e, views: {}, ids: new Set<string>() };
      x.views[v.view] ??= i + 1;
      x.ids.add(v.evidenceId);
      byId.set(e.id, x);
    });
  const ordered = [...byId.values()].sort((a, b) => Math.min(...Object.values(a.views)) - Math.min(...Object.values(b.views))).slice(0, 40);
  const full = ordered.length ? await ctx.client.getEntities(ordered.map((x) => x.e.id)) : [];
  for (const f of full) input.facts.set(f.id, f);
  const entities = ordered.map((x) => ({ ...x, e: input.facts.get(x.e.id) ?? x.e }));
  const locality = await screen(ctx, DOMAIN[slot], place ? categories : [], entities.map((x) => x.e));
  const screenRec = ctx.ledger.add({
    purpose: `Screen ${what} candidates: locality, role, brief fit, distinctiveness and product centrality`,
    queryKind: "locality",
    sanitizedRequest: { candidates: entities.map((x) => x.e.id), contract: contract.version },
    qlooEntityIds: entities.map((x) => x.e.id),
    results: [],
    resultCount: entities.length,
    coverageStatus: entities.length ? "usable" : "empty",
    warnings: [],
  });

  const cands: Omit<PoolCandidate, "proxy">[] = [];
  for (const x of entities) {
    const screens = await screenEntity(input, slot, x.e, locality);
    cands.push({
      slot,
      component: {
        slot,
        label: x.e.displayName,
        origin: "agent_proposed",
        locked: false,
        resolution: "resolved",
        entity: toRef(x.e),
        tags: [],
        placeCategory: place ? (categoryOfVenue(x.e) ? categoryOf(x.e, "event_venue") : null) : null,
      },
      entity: x.e,
      source: "qloo",
      views: x.views,
      evidenceIds: [...x.ids, screenRec.evidenceId],
      lanes: [],
      screens,
    });
  }
  // The user's unlocked choice is a candidate like any other; Qloo not knowing it is unknown, never a failure.
  if (user) {
    const e = user.component.entity ? (input.facts.get(user.component.entity.id) ?? null) : null;
    const screens: PoolRecord["screens"] = e
      ? await screenEntity(input, slot, e, locality)
      : { role: "unknown", locality: "unknown", brief: "unknown", distinct: "pass", central: "unknown", notes: ["not in Qloo: unverified"] };
    // A soft role screen never drops a choice the user named; only the brief's hard rules do.
    if (screens.role === "fail" && !screens.notes.some((n) => n.startsWith("hard:"))) screens.role = "doubtful";
    const seen = cands.findIndex((c) => user.component.entity && c.component.entity?.id === user.component.entity.id);
    if (seen >= 0) cands.splice(seen, 1);
    cands.unshift({ slot, component: user.component, entity: e, source: "user", views: seen >= 0 ? entities.find((x) => x.e.id === e?.id)?.views ?? {} : {}, evidenceIds: [], lanes: [], screens });
  }

  // One structured role check over the strongest non-failed candidates (and the user's).
  const pre = cands
    .map((c) => ({ c, p: proxyOf(c, c.source === "user" ? user?.strength : undefined) }))
    .filter((x) => x.c.screens.role !== "fail" && x.c.screens.brief !== "fail")
    .sort((a, b) => compareVectors(bundleVector([b.p]), bundleVector([a.p])));
  const toCheck = pre.slice(0, ROLE_CHECK_SIZE).map((x) => x.c).filter((c) => !input.roleChecks.has(roleKey(c.component)));
  const checked = await checkRoles(input.llm, ctx, brief, contract, slot, toCheck.map((c) => ({ key: roleKey(c.component), label: c.component.label, entity: c.entity })));
  for (const [k, v] of checked) input.roleChecks.set(k, v);
  for (const c of cands) {
    const r = input.roleChecks.get(roleKey(c.component));
    if (!r) continue;
    if (r.verdict === "wrong" && c.screens.role !== "fail") c.screens.role = c.source === "user" ? "doubtful" : "fail";
    else if (r.verdict === "doubtful" && c.screens.role === "pass") c.screens.role = "doubtful";
    if (!r.central) c.screens.central = "flag";
    c.screens.notes.push(`role check: ${r.verdict}`);
  }

  const scored: PoolCandidate[] = cands.map((c) => ({ ...c, proxy: proxyOf(c, c.source === "user" ? user?.strength : undefined) }));
  for (const c of scored) {
    if (c.views.audience !== undefined) c.lanes.push("affinity");
    if (c.screens.locality === "pass") c.lanes.push("locality");
    if (c.screens.role === "pass" && c.screens.brief === "pass" && c.screens.central === "pass") c.lanes.push("brief_fit");
  }
  const viable = scored.filter((c) => c.screens.role !== "fail" && c.screens.brief !== "fail").sort((a, b) => compareVectors(bundleVector([b.proxy]), bundleVector([a.proxy])));
  // Diversify: the best two of each lane first, then the strongest remaining; the user's candidate always.
  const pool: PoolCandidate[] = viable.filter((c) => c.source === "user");
  // The two strongest of the agent's own proposals that passed every screen, then the lanes.
  for (const c of viable.filter((x) => x.views.proposals !== undefined).slice(0, 2)) if (!pool.includes(c) && pool.length < POOL_SIZE) pool.push(c);
  for (const lane of ["affinity", "locality", "brief_fit"] as Lane[])
    for (const c of viable.filter((x) => x.lanes.includes(lane)).slice(0, 2)) if (!pool.includes(c) && pool.length < POOL_SIZE) pool.push(c);
  for (const c of viable) if (!pool.includes(c) && pool.length < POOL_SIZE) pool.push(c);
  const reserve = viable.filter((c) => !pool.includes(c)).slice(0, RESERVE_SIZE);
  for (const c of scored) {
    const outcome = pool.includes(c) ? "pool" : reserve.includes(c) ? "reserve" : c.screens.role === "fail" ? "dropped: wrong role" : c.screens.brief === "fail" ? "dropped: breaks the brief" : "dropped: below the pool and reserve";
    records.push({ slot, name: c.component.label, entityId: c.component.entity?.id, source: c.source, views: c.views, lanes: c.lanes, screens: c.screens, outcome, evidenceIds: c.evidenceIds });
    trials.push({
      slot,
      name: c.component.label,
      entityId: c.component.entity?.id,
      source: c.source === "user" ? "llm_proposal" : "qloo_list",
      evidenceIds: c.evidenceIds,
      audienceRank: c.views.audience,
      views: c.views,
      localityResult: locality.get(c.component.entity?.id ?? "")?.why,
      briefFit: c.screens.brief === "pass" ? "pass" : c.screens.brief === "fail" ? "fail" : "unknown",
      screenedOutReason: outcome === "pool" ? undefined : outcome,
    });
  }
  return { pool, reserve };
}

async function directionPool(input: AgentInput, user: { component: Component; strength: "locked" | "preferred" | "considered" } | null, fixed: Component[]) {
  const { ctx, brief, anchors } = input;
  const pool: PoolCandidate[] = [];
  const as = (component: Component, source: "qloo" | "user", strength?: "locked" | "preferred" | "considered"): PoolCandidate => {
    const c = { slot: "creative_direction" as Slot, component, entity: null, source, views: {}, evidenceIds: [], lanes: [] as Lane[], screens: { role: "pass", locality: "unknown", brief: "unknown", distinct: "pass", central: "pass", notes: [] as string[] } };
    return { ...c, proxy: proxyOf(c, strength) };
  };
  if (user) pool.push(as(user.component, "user", user.strength));
  if (user?.strength !== "locked" && anchors.length) {
    const open: Component = { slot: "creative_direction", label: "", origin: "agent_proposed", locked: false, resolution: "not_found", entity: null, tags: [], placeCategory: null };
    const assessment: ComponentAssessment = { slot: "creative_direction", label: "", status: "unresolved", coverage: "insufficient", dimensions: [], finding: "Open slot.", contradicted: false };
    const p = await repairDirection({ llm: input.llm, ctx, brief, plan: { anchors, components: [...fixed, open] }, assessment, initial: true });
    if (p) pool.push({ ...as({ ...p.after, origin: "agent_proposed", locked: false }, "qloo"), evidenceIds: p.evidenceIds, lanes: ["affinity"], proxy: { ...ZERO, audience: 1 } });
  }
  return pool;
}

// ---------- the agent ----------

export interface AgentResult {
  plan: CulturalPlan;
  evaluation: PlanEvaluation;
  open: OpenSlot[];
  sources: Partial<Record<Slot, ComponentSource>>;
  assumptions: string[];
  /** Every complete plan it evaluated, the chosen one included. */
  tested: CandidatePlan[];
  trials: DraftTrial[];
  record: AgentRecord;
}

const ROUND_REASON: Record<string, string> = {
  hard_failure: "It breaks a hard rule of the brief.",
  constraint_conflict: "It breaks more hard constraints.",
  brief_fit_lost: "It loses brief or role fit the plan had.",
  plan_regression: "It costs a supported choice without removing a contradiction.",
  no_improvement: "The whole-plan re-test showed no material improvement.",
  repeated_plan: "It is a plan already tested.",
  generic_bundle: "It makes the plan a bundle of global prestige defaults with nothing local.",
};

/** The slot whose recorded claims are weakest, as a structured failure hypothesis (locked slots are never challenged). */
export function weakestSlot(c: CandidatePlan, m: EvidenceMatrix, locked: Set<Slot>): { slot: Slot; claimIds: string[]; statement: string } | null {
  let worst: { slot: Slot; score: number; claims: typeof m.claims } | null = null;
  for (const comp of c.plan.components) {
    if (locked.has(comp.slot)) continue;
    const claims = m.claims.filter((x) => x.candidateId === c.candidateId && x.slot === comp.slot && x.dimension !== "constraint" && x.dimension !== "feasibility" && x.dimension !== "entity");
    const against = claims.filter((x) => x.stance === "contradicts");
    const audienceOk = claims.some((x) => x.dimension === "audience" && x.stance === "supports");
    const score = -against.length * 2 - (audienceOk ? 0 : 1) + claims.filter((x) => x.stance === "supports").length * 0.1;
    if (against.length || !audienceOk) if (!worst || score < worst.score) worst = { slot: comp.slot, score, claims: against.length ? against : claims.filter((x) => x.dimension === "audience") };
  }
  for (const o of c.open) if (!locked.has(o.slot) && (!worst || -3 < worst.score)) worst = { slot: o.slot, score: -3, claims: [] };
  if (!worst) return null;
  const label = c.plan.components.find((x) => x.slot === worst!.slot)?.label;
  return {
    slot: worst.slot,
    claimIds: worst.claims.map((x) => x.claimId),
    statement: label
      ? `${SLOT_LABEL[worst.slot]} "${label}" is the weakest choice: ${worst.claims.map((x) => x.claim).slice(0, 2).join(" ") || "no audience support was found."}`
      : `${SLOT_LABEL[worst.slot]} is open.`,
  };
}

/**
 * What the agent's own screens say against a complete plan (screens:v4), for its selection only:
 * wrong or doubtful roles, generic defaults when the brief asks for distinctive choices, venues
 * outside the neighbourhood the brief names, and the whole-plan guard: two or more global prestige
 * defaults, or one with nothing local, make a narratively generic bundle. Locked choices are never
 * counted against a plan, and a choice the user named isn't counted as generic or outside.
 */
export function selectionFlags(plan: CulturalPlan, screensOf: (c: Component) => PoolRecord["screens"] | undefined, contract: IntentContract): SelectionFlags {
  const notes: SelectionFlags["notes"] = [];
  let role = 0;
  let intent = 0;
  let prestige = 0;
  let local = 0;
  for (const c of plan.components) {
    if (c.slot === "creative_direction" || c.locked) continue;
    const s = screensOf(c);
    if (!s) continue;
    const user = c.origin === "user_provided";
    if (s.role === "fail" || s.role === "doubtful") {
      role += s.role === "fail" ? 1 : 0.5;
      // Name the screen that actually raised the doubt, not a note that passed.
      const cause = [/^brand: /, /^host: (possible|unknown|unsuitable)/, /^role check: (doubtful|wrong)/].map((re) => s.notes.find((n) => re.test(n))).find(Boolean);
      notes.push({ slot: c.slot, label: c.label, why: cause ?? "its role is doubtful" });
    }
    if (!user && s.distinct === "flag") {
      intent += 1;
      notes.push({ slot: c.slot, label: c.label, why: "a top-0.5% mainstream default, and the brief asks for independent or non-generic choices" });
    }
    if (!user && s.brief === "flag") {
      intent += 1;
      notes.push({ slot: c.slot, label: c.label, why: s.notes.find((note) => note.startsWith("avoided:")) ?? "it matches a quality the brief asks to avoid" });
    }
    if (!user && (s.hood === "outside" || s.hood === "far")) {
      intent += 1;
      notes.push({ slot: c.slot, label: c.label, why: `outside ${contract.neighborhoods[0]?.value ?? "the neighbourhood the brief names"}` });
    }
    if (!user && (c.entity?.popularity ?? 0) >= PRESTIGE) prestige++;
    if (s.locality === "pass" || s.hood === "near") local++;
  }
  const guard = prestige >= 2 ? "two or more global prestige defaults" : prestige === 1 && local === 0 ? "a global prestige default and nothing local" : null;
  return { role, intent, guard, notes };
}

export interface SelectionFlags {
  role: number;
  intent: number;
  guard: string | null;
  notes: { slot: Slot; label: string; why: string }[];
}

/**
 * The agent's selection order, aligned with the final judge's first priority (parallel:v9): the
 * evidence vector's hard rules and locks, then keeping the choices the brief names (`named`, see
 * namedScore), then completeness, its own role screen, the whole-plan guard and the brief's
 * distinctiveness and neighbourhood intent, then the rest of the evidence vector (coverage last).
 */
export function agentKey(ev: number[], f: SelectionFlags, named = 0): number[] {
  return [...ev.slice(0, 2), named, ev[2], -f.role, f.guard ? -1 : 0, -f.intent, ...ev.slice(3)];
}

/**
 * How well a plan keeps the choices the brief names plainly: +1 for each one kept, -1 for each one
 * replaced, and nothing either way for one that concretely can't do its job. The judge ranks keeping
 * named choices first, so the agent does too. Locked choices are the lock rule's; choices the brief
 * was only considering stay a weighted preference inside the evidence vector, below brief fit.
 */
export function namedScore(plan: CulturalPlan, named: { component: Component; strength: "locked" | "preferred" | "considered"; cantDoJob: boolean }[]): number {
  let score = 0;
  for (const n of named) {
    if (n.strength !== "preferred" || n.cantDoJob) continue;
    const kept = plan.components.some((c) => c.slot === n.component.slot && sameEntity(c, n.component) && c.origin === "user_provided");
    score += kept ? 1 : -1;
  }
  return score;
}

export async function runEvidenceAgent(input: AgentInput): Promise<AgentResult> {
  const { contract, ctx } = input;
  const pools = new Map<Slot, PoolCandidate[]>();
  const reserves = new Map<Slot, PoolCandidate[]>();
  const records: PoolRecord[] = [];
  const trials: DraftTrial[] = [];
  const lockedSlots = new Set(contract.choices.filter((c) => c.strength === "locked").map((c) => c.slot));

  // The user's named choices, resolved by the agent itself (the same resolution every track uses).
  const userCands = new Map<Slot, { component: Component; strength: "locked" | "preferred" | "considered" }>();
  for (const choice of contract.choices) {
    const meta = { origin: "user_provided" as const, locked: choice.strength === "locked" };
    let component: Component;
    if (choice.slot === "creative_direction") {
      component = { slot: choice.slot, label: choice.name, ...meta, resolution: "not_found", entity: null, tags: [], placeCategory: null };
      if (input.anchors.length) {
        const mapped = await mapDirection(input.llm, choice.name, await directionVocabulary(ctx, input.anchors.map((a) => a.id)), ctx.directions);
        component = { ...component, tags: mapped.tags, resolution: mapped.tags.length ? "resolved" : "not_found" };
      }
    } else {
      component = await resolveEntityComponent(ctx.client, choice.slot, choice.name, ctx.market, meta, undefined, input.countries.get(choice.name.trim().toLowerCase()));
      if (component.entity) for (const f of await ctx.client.getEntities([component.entity.id])) input.facts.set(f.id, f);
    }
    userCands.set(choice.slot, { component, strength: choice.strength });
  }
  // Locked choices are mandatory and condition the rest of retrieval (coherence with them).
  const fixed = [...userCands.values()].filter((u) => u.strength === "locked").map((u) => u.component);
  for (const slot of ["artist_music", "brand_collaboration", "event_place"] as EntitySlot[]) {
    const u = userCands.get(slot) ?? null;
    if (u?.strength === "locked") {
      pools.set(slot, [{ slot, component: u.component, entity: u.component.entity ? (input.facts.get(u.component.entity.id) ?? null) : null, source: "user", views: {}, evidenceIds: [], lanes: [], screens: { role: "pass", locality: "unknown", brief: "unknown", distinct: "pass", central: "pass", notes: ["locked by the brief"] }, proxy: { ...ZERO, lock: 1 } }]);
      continue;
    }
    const { pool, reserve } = await entityPool(input, slot, fixed, u, records, trials);
    pools.set(slot, pool);
    reserves.set(slot, reserve);
  }
  const dir = userCands.get("creative_direction") ?? null;
  pools.set("creative_direction", dir?.strength === "locked" ? [{ slot: "creative_direction", component: dir.component, entity: null, source: "user", views: {}, evidenceIds: [], lanes: [], screens: { role: "pass", locality: "unknown", brief: "unknown", distinct: "pass", central: "pass", notes: ["locked by the brief"] }, proxy: { ...ZERO, lock: 1 } }] : await directionPool(input, dir, fixed));

  // Compose and test complete plans.
  const width = input.beamWidth ?? BEAM_WIDTH;
  const bundles = beamSearch(pools, width);
  const tested: CandidatePlan[] = [];
  const seen = new Set<string>();
  let stop: AgentRecord["stop"] = "round_limit";
  const sourcesOf = (b: PoolCandidate[]) => Object.fromEntries(b.map((x) => [x.slot, x.source === "user" ? "user" : "agent"])) as Partial<Record<Slot, ComponentSource>>;
  const openOf = (plan: CulturalPlan): OpenSlot[] =>
    SLOTS.filter((s) => !plan.components.some((c) => c.slot === s)).map((slot) => ({ slot, state: "abstained", reason: `No ${SLOT_LABEL[slot].toLowerCase()} candidate passed the screens.` }));
  const asCandidate = (plan: CulturalPlan, evaluation: PlanEvaluation, sources: CandidatePlan["sources"], parent?: string): CandidatePlan => ({
    ...input.newIds(),
    track: "agent",
    briefFingerprint: input.briefFingerprint,
    plan,
    open: openOf(plan),
    sources,
    evaluation,
    assumptions: [],
    parent,
    provenance: { qlooCalls: 0, llmCalls: 0, ms: 0, generatedAt: new Date().toISOString() },
  });
  for (const b of bundles) {
    const plan: CulturalPlan = { anchors: input.anchors, components: SLOTS.flatMap((s) => b.filter((x) => x.slot === s).map((x) => x.component)) };
    const fp = planFingerprint(plan);
    if (seen.has(fp)) continue;
    seen.add(fp);
    try {
      tested.push(asCandidate(plan, await input.evaluate(plan), sourcesOf(b)));
    } catch (err) {
      if (!(err instanceof BudgetExceeded) || !tested.length) throw err;
      stop = "budget";
      break;
    }
  }
  if (!tested.length) throw new Error("The agent couldn't compose any plan from its candidates.");
  // How the agent's own screens read each component, for selecting among complete plans.
  const screenBy = new Map<string, PoolRecord["screens"]>();
  for (const list of [...pools.values(), ...reserves.values()]) for (const c of list) screenBy.set(roleKey(c.component), c.screens);
  const flagsOf = (plan: CulturalPlan) => selectionFlags(plan, (c) => screenBy.get(roleKey(c)), contract);
  const named = [...userCands.values()].map((u) => {
    const sc = screenBy.get(roleKey(u.component));
    return { ...u, cantDoJob: !!sc && cantDoJob(sc) };
  });
  const keyOf = (m: EvidenceMatrix, c: CandidatePlan) => agentKey(evidenceVector(m, c.candidateId), flagsOf(c.plan), namedScore(c.plan, named));
  // A named choice the plan keeps isn't challenged unless it concretely can't do its job: the
  // judge would count replacing it against the plan, so the rounds go to the slots the agent filled.
  const protectedSlots = (plan: CulturalPlan) =>
    new Set([...lockedSlots, ...named.filter((n) => n.strength === "preferred" && !n.cantDoJob && plan.components.some((c) => c.slot === n.component.slot && c.origin === "user_provided")).map((n) => n.component.slot)]);
  const m0 = input.matrix(tested);
  let incumbent = [...tested].sort((a, b) => compareVectors(keyOf(m0, b), keyOf(m0, a)))[0];

  // The challenge loop: the weakest choice, one substitution, a whole-plan re-test.
  const rounds: ImprovementRound[] = [];
  const tried = new Set<string>(incumbent.plan.components.map((c) => `${c.slot}:${c.entity?.id ?? c.label}`));
  for (let r = 1; stop !== "budget" && r <= input.rounds; r++) {
    const m = input.matrix([incumbent]);
    // A choice the agent's own screens flag (wrong role, a generic default the brief asks to avoid,
    // outside the named neighbourhood) is challenged first; otherwise the weakest recorded claims.
    const guarded = protectedSlots(incumbent.plan);
    const flag = flagsOf(incumbent.plan).notes.find((n) => !guarded.has(n.slot));
    const weak = flag ? { slot: flag.slot, claimIds: [], statement: `${SLOT_LABEL[flag.slot]} "${flag.label}": ${flag.why}.` } : weakestSlot(incumbent, m, guarded);
    if (!weak) {
      stop = "no_weakness";
      break;
    }
    const round: ImprovementRound = { round: r, incumbent: incumbent.candidateId, challenges: [{ kind: "weak_evidence", candidateId: incumbent.candidateId, slot: weak.slot, detail: weak.statement, claimIds: weak.claimIds }], attempts: [], hypothesis: weak };
    rounds.push(round);
    const others = incumbent.plan.components.filter((c) => c.slot !== weak.slot);
    // The best-standing untried candidate for that slot.
    const alt = [...(pools.get(weak.slot) ?? []), ...(reserves.get(weak.slot) ?? [])]
      .filter((c) => !tried.has(`${c.slot}:${c.component.entity?.id ?? c.component.label}`) && !others.some((o) => sameEntity(o, c.component)))
      .sort((a, b) => compareVectors(bundleVector([b.proxy]), bundleVector([a.proxy])))[0];
    if (!alt) {
      stop = "no_alternative";
      break;
    }
    tried.add(`${alt.slot}:${alt.component.entity?.id ?? alt.component.label}`);
    const plan: CulturalPlan = { ...incumbent.plan, components: SLOTS.flatMap((s) => (s === weak.slot ? [alt.component] : incumbent.plan.components.filter((c) => c.slot === s))) };
    const fp = planFingerprint(plan);
    const ids = input.newIds();
    const base: Pick<HybridAttempt, "candidateId" | "parent" | "kind" | "slot"> = { candidateId: ids.candidateId, parent: incumbent.candidateId, kind: "challenge", slot: weak.slot };
    if (seen.has(fp)) {
      round.attempts.push({ ...base, accepted: false, rejectionCode: "repeated_plan", reason: ROUND_REASON.repeated_plan });
      stop = "repeated_plan";
      break;
    }
    seen.add(fp);
    let evaluation: PlanEvaluation;
    try {
      evaluation = await input.evaluate(plan);
    } catch (err) {
      if (!(err instanceof BudgetExceeded)) throw err;
      stop = "budget";
      break;
    }
    const cand: CandidatePlan = { ...asCandidate(plan, evaluation, { ...incumbent.sources, [weak.slot]: alt.source === "user" ? "user" : "agent" }, incumbent.candidateId), ...ids };
    tested.push(cand);
    const pair = input.matrix([incumbent, cand]);
    const fit = (id: string) => pair.claims.filter((x) => x.candidateId === id && x.stance === "supports" && (x.dimension === "role_fit" || x.ruleId === "R-neighborhood" || x.claimId.endsWith("/user-intent"))).length;
    const guard = judgeHybrid(incumbent.evaluation!, evaluation, pair.hardFailures[cand.candidateId] ?? [], { before: fit(incumbent.candidateId), after: fit(cand.candidateId) });
    // Material: better on the agent's selection order before the coverage level, not just more
    // coverage. Hard rules and lost brief fit always reject; the selection order replaces the plain
    // supported-choice count, so a distinctive choice can replace a better-liked generic one.
    const vi = keyOf(pair, incumbent).slice(0, -1);
    const vc = keyOf(pair, cand).slice(0, -1);
    const better = compareVectors(vc, vi) > 0;
    const generic = !!flagsOf(cand.plan).guard && !flagsOf(incumbent.plan).guard;
    const vetoed = guard.rejectionCode === "hard_failure" || guard.rejectionCode === "constraint_conflict" || guard.rejectionCode === "brief_fit_lost" ? guard.rejectionCode : undefined;
    const code = vetoed ?? (generic ? "generic_bundle" : better ? undefined : "no_improvement");
    round.attempts.push({ ...base, accepted: !code, rejectionCode: code, reason: code ? ROUND_REASON[code] : `${alt.component.label} replaces ${incumbent.plan.components.find((c) => c.slot === weak.slot)?.label ?? "the open slot"}: ${weak.statement}`, retest: guard.retest });
    if (code) {
      stop = "no_improvement";
      break;
    }
    round.accepted = cand.candidateId;
    incumbent = cand;
  }

  // Before committing, the agent checks its own top venues against cited web facts. It may move
  // only to another tested plan that is just as good on hard rules, locks, the user's named choices
  // and completeness, whose venue has fewer cited concerns.
  let webCheck: AgentRecord["webCheck"];
  if (input.operational && stop !== "budget") {
    const mAll = input.matrix(tested);
    const ranked = [...tested].sort((a, b) => compareVectors(keyOf(mAll, b), keyOf(mAll, a)));
    const top = keyOf(mAll, ranked[0]).slice(0, 4).join(",");
    const venueOf = (c: CandidatePlan) => c.plan.components.find((x) => x.slot === "event_place");
    const peers = ranked.filter((c) => keyOf(mAll, c).slice(0, 4).join(",") === top && venueOf(c));
    const first = venueOf(incumbent);
    const venues = [...new Set([first?.label, ...peers.map((c) => venueOf(c)!.label)].filter((v): v is string => !!v))].slice(0, WEB_CHECK_VENUES);
    if (first && first.origin !== "user_provided" && venues.length > 1) {
      try {
        const { checks } = await input.operational.verifyVenues({
          venues,
          city: ctx.market.label,
          area: contract.neighborhoods[0]?.value,
          brief: { productCategory: input.brief.productCategory, launchGoal: input.brief.launchGoal, audienceDescription: input.brief.audienceDescription, sourceText: input.brief.sourceText },
          signal: input.signal,
        });
        const checkOf = (label: string) => checks.find((c) => c.venue.trim().toLowerCase() === label.trim().toLowerCase());
        const cost = (c: CandidatePlan) => {
          const check = checkOf(venueOf(c)!.label);
          return check?.status === "verified_conflict" ? 99 : fitConcerns(check).length;
        };
        webCheck = { checks };
        ctx.ledger.add({
          purpose: "The agent's web check of its own top venues, before choosing",
          queryKind: "review",
          sanitizedRequest: { venues, area: contract.neighborhoods[0]?.value ?? null },
          qlooEntityIds: [],
          results: checks.map((c) => ({ id: c.venue, name: `${c.venue}: ${c.status === "verified_conflict" ? "conflict" : fitConcerns(c).join(", ") || "no cited concern"}` })),
          resultCount: checks.length,
          coverageStatus: checks.some((c) => c.sources.length) ? "usable" : "empty",
          warnings: [],
        });
        const mine = cost(incumbent);
        const better = peers.filter((c) => checkOf(venueOf(c)!.label)).find((c) => cost(c) < mine);
        if (mine > 0 && better) {
          const was = checkOf(first.label);
          webCheck.moved = {
            fromVenue: first.label,
            toVenue: venueOf(better)!.label,
            concerns: was?.status === "verified_conflict" ? [was.finding] : fitConcerns(was),
            note: was?.fit?.note ?? was?.finding ?? "",
          };
          incumbent = better;
        }
      } catch (err) {
        if (err instanceof BudgetExceeded) throw err;
        // The web check is optional: without it the agent keeps its own choice.
      }
    }
  }

  return {
    plan: incumbent.plan,
    evaluation: incumbent.evaluation!,
    open: incumbent.open,
    sources: incumbent.sources,
    assumptions: incumbent.open.map((o) => `${SLOT_LABEL[o.slot]} left open: ${o.reason}`),
    tested,
    trials,
    record: { contract, beamWidth: width, pools: records, bundlesTested: tested.length, rounds, stop, selection: flagsOf(incumbent.plan), webCheck },
  };
}

/**
 * A shared reading for the named neighbourhood. Qloo's own locality record gives the point when it
 * is in this city (its full name says so) and agrees with where Qloo places the area's venues
 * (within 15 km of their median); otherwise the median of those venues is used. Fewer than five
 * venues with coordinates and no such locality: unknown.
 */
export async function neighborhoodCentroid(ctx: GatherContext, contract: IntentContract): Promise<Centroid | null> {
  const hood = contract.neighborhoods[0];
  if (!hood) return null;
  const q: InsightsInput = { filterType: "urn:entity:place", filterLocationQuery: `${hood.value}, ${ctx.market.qlooLocation}`, take: 25 };
  const [r, places] = await Promise.all([
    ctx.client.getInsights(q),
    ctx.client.searchEntities({ query: hood.value, types: ["urn:entity:locality"], take: 5 }).catch((err) => {
      if (err instanceof BudgetExceeded) throw err;
      return [];
    }),
  ]);
  const pts = r.entities.flatMap((e) => (e.geocode?.latitude != null && e.geocode.longitude != null && e.geocode.countryCode?.toUpperCase() === ctx.market.country ? [{ lat: e.geocode.latitude, lon: e.geocode.longitude }] : []));
  // The median point resists a stray venue far away.
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const venues = pts.length >= 5 ? { lat: med(pts.map((p) => p.lat)), lon: med(pts.map((p) => p.lon)) } : null;
  const city = [ctx.market.label, ctx.market.qlooLocation].map((x) => x.toLowerCase());
  const locality = places.find(
    (e) =>
      nameKey(e.name) === nameKey(hood.value) &&
      e.geocode?.latitude != null &&
      e.geocode.longitude != null &&
      e.akas.some((a) => city.some((c) => a.toLowerCase().includes(c))) &&
      (!venues || distanceKm({ lat: e.geocode.latitude, lon: e.geocode.longitude }, venues) <= 15),
  );
  const at = locality ? { lat: locality.geocode!.latitude!, lon: locality.geocode!.longitude! } : venues;
  const rec = ctx.ledger.add({
    purpose: `Where ${hood.value} is ("${hood.phrase}"): ${locality ? "Qloo's locality record" : "the venues Qloo places there"}`,
    queryKind: "insights",
    sanitizedRequest: { ...sanitizeInsights(q), "locality.search": hood.value },
    qlooEntityIds: locality ? [locality.id] : [],
    results: [...(locality ? [{ id: locality.id, name: `${locality.name} (locality)` }] : []), ...itemsFrom(r)],
    resultCount: pts.length + (locality ? 1 : 0),
    coverageStatus: at ? "usable" : pts.length ? "partial" : "empty",
    warnings: at ? [] : [`Only ${pts.length} venue(s) with coordinates and no matching locality: neighbourhood fit is unknown.`],
  });
  if (!at) return null;
  return { name: hood.value, lat: at.lat, lon: at.lon, count: pts.length, evidenceId: rec.evidenceId };
}

/**
 * Places the brief only puts something "in" ("a café in Hackney", "in Bushwick, Brooklyn") become
 * neighbourhoods when Qloo has a locality of exactly that name in this city. A confirmed locality
 * that Qloo files under one of the brief's broader areas (Bushwick under Brooklyn) is the more
 * specific one and comes first. Anything Qloo doesn't confirm ("weavers in Bengal") is ignored.
 */
export async function confirmNeighborhoods(ctx: GatherContext, contract: IntentContract): Promise<IntentContract> {
  const mentions = contract.placeMentions ?? [];
  if (!mentions.length) return contract;
  const city = [ctx.market.label, ctx.market.qlooLocation].map((x) => x.toLowerCase());
  const found = await Promise.all(
    mentions.map(async (m) => {
      const places = await ctx.client.searchEntities({ query: m.value, types: ["urn:entity:locality"], take: 5 }).catch((err) => {
        if (err instanceof BudgetExceeded) throw err;
        return [];
      });
      const hit = places.find((e) => nameKey(e.name) === nameKey(m.value) && e.akas.some((a) => city.some((c) => a.toLowerCase().includes(c))));
      return { m, hit };
    }),
  );
  ctx.ledger.add({
    purpose: `Confirm the places the brief puts the launch in as ${ctx.market.label} localities`,
    queryKind: "search",
    sanitizedRequest: { query: mentions.map((m) => m.value), types: ["urn:entity:locality"] },
    qlooEntityIds: found.flatMap((f) => (f.hit ? [f.hit.id] : [])),
    results: found.map((f) => ({ id: f.hit?.id ?? f.m.value, name: `${f.m.value}: ${f.hit ? "a locality here" : "not confirmed"}` })),
    resultCount: found.filter((f) => f.hit).length,
    coverageStatus: found.some((f) => f.hit) ? "usable" : "empty",
    warnings: [],
  });
  const neighborhoods = [...contract.neighborhoods];
  for (const { m, hit } of found) {
    if (!hit) continue;
    const broader = neighborhoods.findIndex((n) => hit.akas.some((a) => a.toLowerCase().includes(n.value.toLowerCase())));
    if (broader >= 0) neighborhoods.splice(broader, 0, m);
    else neighborhoods.push(m);
  }
  return { ...contract, neighborhoods };
}

/** Role readings for components the agent didn't pool (the user's and the LLM's), so every plan is screened alike. */
export async function checkRemainingRoles(llm: LlmClient, ctx: GatherContext, brief: LaunchBrief, contract: IntentContract, plans: CulturalPlan[], roleChecks: Map<string, RoleCheck>, facts: Map<string, QlooEntity>) {
  const bySlot = new Map<EntitySlot, Map<string, { key: string; label: string; entity: QlooEntity | null }>>();
  for (const p of plans)
    for (const c of p.components) {
      if (c.slot === "creative_direction" || roleChecks.has(roleKey(c))) continue;
      const m = bySlot.get(c.slot) ?? new Map();
      m.set(roleKey(c), { key: roleKey(c), label: c.label, entity: c.entity ? (facts.get(c.entity.id) ?? null) : null });
      bySlot.set(c.slot, m);
    }
  await mapLimit([...bySlot], 3, async ([slot, items]) => {
    for (const [k, v] of await checkRoles(llm, ctx, brief, contract, slot, [...items.values()])) roleChecks.set(k, v);
  });
}

export type { Market };
