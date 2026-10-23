import { createHash } from "node:crypto";
import { z } from "zod";
import { generateStructured } from "@/lib/llm/structured";
import type { LlmClient } from "@/lib/llm/types";
import type { Market } from "@/lib/markets";
import type { GatherContext } from "./gather";
import {
  briefText,
  buildPlan,
  directionVocabulary,
  draftPlan,
  mapDirection,
  resolveAnchors,
  resolveEntityComponent,
  type Draft,
} from "./plan";
import { repairDirection, repairEntity, type DraftTrial, type RepairProposal } from "./repair";
import {
  SLOTS,
  SLOT_LABEL,
  type Component,
  type ComponentAssessment,
  type ComponentSource,
  type CulturalPlan,
  type EntityRef,
  type LaunchBrief,
  type OpenSlot,
  type Slot,
} from "./types";

/**
 * The three independent tracks of the parallel architecture. Each generator receives only what
 * it is allowed to see, so independence holds by construction rather than by convention:
 *
 * - Track U materialises exactly what the user supplied; open slots stay `not_specified`.
 * - Track L is the model alone. `generateLlmDraft` takes the frozen brief and the market and no
 *   Qloo client, so it cannot read Qloo results, candidate lists or another track's plan. Its
 *   names are resolved afterwards by the same entity resolution every track uses.
 * - Track A is evidence-first. It never receives Track L. Its names come only from screened Qloo
 *   candidates or from the user's own (separately resolved) choices; the model only chooses among
 *   screened candidates and phrases the direction from Qloo's own words.
 */

// ---------- the frozen brief ----------

/** JSON with object keys sorted, so equal briefs give equal fingerprints. */
function stable(v: unknown): string {
  return JSON.stringify(v, (_, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object") {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

export interface FrozenBrief {
  brief: Readonly<LaunchBrief>;
  fingerprint: string;
}

/** An immutable copy of the confirmed brief, identified by a fingerprint of its content. */
export function freezeBrief(brief: LaunchBrief): FrozenBrief {
  const copy = deepFreeze(structuredClone(brief));
  return { brief: copy, fingerprint: createHash("sha256").update(stable(copy)).digest("hex").slice(0, 16) };
}

// ---------- shared measurement anchors ----------

const hypothesisSchema = z.object({
  anchors: z
    .array(z.object({ name: z.string(), country: z.string() }))
    .describe("3-4 established brands or music artists whose fans match the described audience"),
});

export const ANCHOR_HYPOTHESIS_SYSTEM =
  "Suggest audience anchors for measurement only: 3-4 established brands or music artists whose fans match the audience described. Use real names exactly as usually written and give each one's country. They must stand for the audience, not for the launch venue, a collaborator or the launching brand.";

/**
 * The audience every track is measured against. The user's anchors when they named some (never
 * substituted); otherwise model-suggested hypotheses from the brief alone, shown as such. Shared
 * so that all three plans are scored on the same audience.
 */
export async function measurementAnchors(input: {
  llm: LlmClient;
  ctx: GatherContext;
  brief: LaunchBrief;
}): Promise<{ anchors: EntityRef[]; source: "user" | "model_hypothesis"; notes: string[] }> {
  const { llm, ctx, brief } = input;
  if (brief.audienceAnchors.length) {
    const r = await resolveAnchors({ llm, ctx, brief, names: brief.audienceAnchors });
    return { anchors: r.anchors, source: "user", notes: r.notes };
  }
  const { data } = await generateStructured(llm, {
    schema: hypothesisSchema,
    system: ANCHOR_HYPOTHESIS_SYSTEM,
    prompt: briefText(brief, ctx.market),
    label: "anchors:hypothesis",
  });
  const names = data.anchors.slice(0, 4);
  const r = await resolveAnchors({ llm, ctx, brief, names: names.map((a) => a.name), countries: names.map((a) => a.country) });
  return {
    anchors: r.anchors,
    source: "model_hypothesis",
    notes: [
      `No audience anchors were given, so model-suggested anchors (${r.anchors.map((a) => a.name).join(", ") || "none found"}) stand for the audience in every track's tests. Please confirm they fit.`,
      ...r.notes,
    ],
  };
}

// ---------- where the user's named choices are from ----------

const countriesSchema = z.object({
  choices: z.array(z.object({ name: z.string(), country: z.string() })).describe("each named act or brand, with the country it is from"),
});

export const CHOICE_COUNTRIES_SYSTEM =
  "For each music act or brand named below, say which country it is from, so the right one is looked up when names collide (two acts called the same thing). Use the brief's city as context. Copy each name exactly. If you don't know, give an empty country.";

/**
 * The country of each act or brand the user named, from the brief alone, so the user's choices
 * get the same namesake protection as every other name ("Divine" the Mumbai rapper, not the
 * American performer). Shared, and resolved once: every track sees the same entity for them.
 */
export async function userChoiceCountries(llm: LlmClient, brief: LaunchBrief, market: Market): Promise<Map<string, string>> {
  const named = brief.existingChoices.filter((c) => c.slot === "artist_music" || c.slot === "brand_collaboration");
  if (!named.length) return new Map();
  const { data } = await generateStructured(llm, {
    schema: countriesSchema,
    system: CHOICE_COUNTRIES_SYSTEM,
    prompt: `City: ${market.label}\nNamed:\n${named.map((c) => `- ${c.name}`).join("\n")}`,
    label: "choices:countries",
  });
  return new Map(data.choices.filter((c) => c.country.trim()).map((c) => [c.name.trim().toLowerCase(), c.country.trim()]));
}

// ---------- a track's output ----------

export interface TrackPlan {
  plan: CulturalPlan;
  open: OpenSlot[];
  sources: Partial<Record<Slot, ComponentSource>>;
  assumptions: string[];
}

const lockedSlot = (brief: LaunchBrief, slot: Slot) => brief.constraints.some((c) => c.kind === "hard" && c.lockSlot === slot);
const orderSlots = (components: Component[]) => SLOTS.flatMap((s) => components.filter((c) => c.slot === s));

// ---------- Track U ----------

/** Exactly what the user supplied, resolved like any other choice. Nothing is filled in. */
export async function buildUserTrack(input: {
  llm: LlmClient;
  ctx: GatherContext;
  brief: LaunchBrief;
  anchors: EntityRef[];
  /** Name (lower case) → country, for namesake protection (see userChoiceCountries). */
  countries?: Map<string, string>;
}): Promise<TrackPlan> {
  const { llm, ctx, brief, anchors } = input;
  const components: Component[] = [];
  const assumptions: string[] = [];
  for (const choice of brief.existingChoices) {
    const meta = { origin: "user_provided" as const, locked: lockedSlot(brief, choice.slot) };
    if (choice.slot === "creative_direction") {
      let direction: Component = { slot: choice.slot, label: choice.name, ...meta, resolution: "not_found", entity: null, tags: [], placeCategory: null };
      if (anchors.length) {
        const vocab = await directionVocabulary(ctx, anchors.map((a) => a.id));
        const mapped = await mapDirection(llm, choice.name, vocab);
        direction = { ...direction, tags: mapped.tags, resolution: mapped.tags.length ? "resolved" : "not_found" };
        if (mapped.note) assumptions.push(`Your creative direction: ${mapped.note}`);
      }
      components.push(direction);
    } else {
      components.push(
        await resolveEntityComponent(ctx.client, choice.slot, choice.name, ctx.market, meta, undefined, input.countries?.get(choice.name.trim().toLowerCase())),
      );
    }
  }
  ctx.ledger.add({
    purpose: "Resolve your own choices to Qloo entities",
    queryKind: "search",
    sanitizedRequest: { queries: brief.existingChoices.map((c) => c.name) },
    qlooEntityIds: components.flatMap((c) => (c.entity ? [c.entity.id] : [])),
    results: components.flatMap((c) => (c.entity ? [{ id: c.entity.id, name: c.entity.name, type: c.entity.type ?? undefined }] : [])),
    resultCount: components.filter((c) => c.entity).length,
    coverageStatus: !components.length ? "empty" : components.every((c) => c.resolution === "resolved") ? "usable" : "partial",
    warnings: components.filter((c) => c.resolution !== "resolved").map((c) => `"${c.label}" couldn't be resolved in Qloo; it is kept as your choice and flagged.`),
  });
  const given = new Set(components.map((c) => c.slot));
  return {
    plan: { anchors, components: orderSlots(components) },
    open: SLOTS.filter((s) => !given.has(s)).map((slot) => ({ slot, state: "not_specified" as const, reason: "You didn't specify this." })),
    sources: Object.fromEntries(components.map((c) => [c.slot, "user"])),
    assumptions,
  };
}

// ---------- Track L ----------

/**
 * The model alone, from the frozen brief. No Qloo client is passed in: this is the LLM-only
 * baseline, and it can't see Qloo, the agent plan or any adjudication.
 */
export function generateLlmDraft(llm: LlmClient, frozen: FrozenBrief, market: Market): Promise<Draft> {
  return draftPlan(llm, frozen.brief as LaunchBrief, market);
}

/** Resolve the LLM draft with the same entity resolution as every other track, measured on the shared anchors. */
export async function resolveLlmTrack(input: {
  llm: LlmClient;
  ctx: GatherContext;
  brief: LaunchBrief;
  draft: Draft;
  anchors: EntityRef[];
  /** The shared namesake countries for the user's named choices (see userChoiceCountries). */
  countries?: Map<string, string>;
}): Promise<TrackPlan> {
  // A user's named act or brand the draft keeps is resolved with the same country every track
  // uses, not the draft's own reading, so it is never tested as a different namesake here.
  const shared = (name: string) => input.countries?.get(name.trim().toLowerCase());
  const draft: Draft = {
    ...input.draft,
    countries: {
      anchors: input.draft.countries?.anchors ?? [],
      artist: shared(input.draft.artist) ?? input.draft.countries?.artist ?? "",
      brand: shared(input.draft.brand) ?? input.draft.countries?.brand ?? "",
    },
  };
  const { plan, notes } = await buildPlan({ ...input, draft, origin: "agent_proposed" });
  const user = new Set(input.brief.existingChoices.map((c) => c.slot));
  return {
    plan,
    open: [],
    sources: Object.fromEntries(plan.components.map((c) => [c.slot, user.has(c.slot) ? "user" : "llm"])),
    assumptions: [
      ...input.draft.assumptions,
      ...(input.brief.audienceAnchors.length ? [] : [`The LLM read the audience as fans of ${input.draft.anchors.join(", ")} (its own reading; every track is measured on the shared anchors).`]),
      ...notes,
    ],
  };
}

// ---------- Track A ----------

const ENTITY_ORDER = ["artist_music", "brand_collaboration", "event_place"] as const;

const openAssessment = (slot: Slot): ComponentAssessment => ({
  slot,
  label: "",
  status: "unresolved",
  coverage: "insufficient",
  dimensions: [],
  finding: "Open slot: nothing chosen yet.",
  contradicted: false,
});

const placeholder = (slot: Slot): Component => ({
  slot,
  label: "",
  origin: "agent_proposed",
  locked: false,
  resolution: "not_found",
  entity: null,
  tags: [],
  placeCategory: null,
});

export interface AgentTrack extends TrackPlan {
  /** Ranked screened picks per slot, for building complete alternatives. */
  picks: Partial<Record<Slot, RepairProposal[]>>;
  trials: DraftTrial[];
}

/**
 * The evidence-first plan. Keeps the user's own (resolved) choices; fills every other slot from
 * Qloo retrieval, after the deterministic screens (constraints, identity, city and country,
 * venue format, locality, role and brief fit, duplicates) have run, with the model choosing only
 * among the screened candidates. Slots are filled in a fixed order so later retrieval can use the
 * earlier picks for plan coherence. A slot nothing passes for is left open, not forced.
 */
export async function generateAgentTrack(input: {
  llm: LlmClient;
  ctx: GatherContext;
  brief: LaunchBrief;
  anchors: EntityRef[];
  /** The user's choices as Track U resolved them. */
  user: Component[];
}): Promise<AgentTrack> {
  const { llm, ctx, brief, anchors } = input;
  let components = [...input.user];
  const sources: Partial<Record<Slot, ComponentSource>> = Object.fromEntries(components.map((c) => [c.slot, "user"]));
  const open: OpenSlot[] = [];
  const picks: AgentTrack["picks"] = {};
  const trials: DraftTrial[] = [];
  const has = (slot: Slot) => components.some((c) => c.slot === slot);
  const planWith = (extra: Component[]) => ({ anchors, components: orderSlots([...components, ...extra]) });

  for (const slot of ENTITY_ORDER) {
    if (has(slot)) continue;
    const r = await repairEntity({
      llm,
      ctx,
      brief,
      plan: planWith([placeholder(slot)]),
      slot,
      assessment: openAssessment(slot),
      rejected: [],
      initial: true,
    });
    trials.push(...r.trials);
    if (!r.proposals.length) {
      const why = ctx.ledger.records.at(-1)?.warnings[0];
      open.push({ slot, state: "abstained", reason: why ?? `No Qloo candidate for the ${SLOT_LABEL[slot].toLowerCase()} passed the screens.` });
      continue;
    }
    picks[slot] = r.proposals.map((p) => ({ ...p, after: { ...p.after, origin: "agent_proposed" } }));
    components.push(picks[slot]![0].after);
    sources[slot] = "agent";
  }

  if (!has("creative_direction")) {
    const p = anchors.length
      ? await repairDirection({ llm, ctx, brief, plan: planWith([placeholder("creative_direction")]), assessment: openAssessment("creative_direction"), initial: true })
      : null;
    if (p) {
      const after = { ...p.after, origin: "agent_proposed" as const, locked: false };
      picks.creative_direction = [{ ...p, after }];
      components.push(after);
      sources.creative_direction = "agent";
    } else {
      open.push({ slot: "creative_direction", state: "abstained", reason: "Qloo returned no aesthetic or tone words for this audience here." });
    }
  }
  components = orderSlots(components);
  return {
    plan: { anchors, components },
    open,
    sources,
    picks,
    trials,
    assumptions: open.map((o) => `${SLOT_LABEL[o.slot]} left open: ${o.reason}`),
  };
}

/**
 * Complete alternatives to the agent's first pick: each swaps one slot to its next-ranked
 * screened candidate. Bounded; every alternative is evaluated as a whole plan by the caller.
 */
export function agentAlternatives(track: AgentTrack, max: number): CulturalPlan[] {
  const out: CulturalPlan[] = [];
  for (const slot of SLOTS) {
    const ranked = track.picks[slot];
    if (!ranked || ranked.length < 2) continue;
    for (const alt of ranked.slice(1)) {
      if (out.length >= max) return out;
      out.push({ ...track.plan, components: track.plan.components.map((c) => (c.slot === slot ? alt.after : c)) });
    }
  }
  return out;
}
