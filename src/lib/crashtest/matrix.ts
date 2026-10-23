import { nameKey } from "@/lib/engine/stats";
import type { QlooEntity } from "@/lib/qloo";
import { unverifiableRules } from "./constraints";
import type { IntentContract } from "./intent";
import { fitsBrief, isFoodAndDrink, ruledOut, stem, venueFormat } from "./repair";
import { avoidedMatch, centralityFlag, hostTier, mainstreamFlag, neighborhoodFit, type Centroid, type RoleCheck } from "./screens";
import {
  SLOTS,
  SLOT_LABEL,
  type CandidatePlan,
  type ClaimStance,
  type Component,
  type ComponentAssessment,
  type ComponentState,
  type DimensionScore,
  type EvidenceClaim,
  type EvidenceDimension,
  type EvidenceMatrix,
  type EvidenceSource,
  type LaunchBrief,
  type ParallelResult,
  type Slot,
} from "./types";
import { EVIDENCE_RUBRIC_VERSION } from "./version";

/**
 * The evidence matrix: every candidate plan's evaluation restated as structured claims, each
 * pointing at ledger records, at a declared rule, or both. Deterministic and pure. A claim
 * supports, contradicts, or is unknown; unknown is never folded into either. Qloo evidence
 * (affinity, locality, coherence) and logical rules (format, role, brand fit) are separate
 * claims with separate sources, so a reader can tell which is which.
 */

/** Every rule a claim may cite. A logical or constraint claim without one of these is a bug. */
export const RULES = {
  "R-hard-exclude": "A choice the brief's hard constraints exclude by name breaks the brief.",
  "R-lock": "A choice the brief fixes must stay exactly as given.",
  "R-user-choice": "A choice the user named is user intent: it stays unless the evidence contradicts it.",
  "R-hard-constraints": "Every machine-checkable hard constraint is checked in code.",
  "R-unverifiable-rule": "A hard rule code can't check is shown to a person, never assumed met.",
  "R-entity-resolution": "A choice must resolve to the intended Qloo entity (namesakes excluded) to be tested.",
  "R-qloo-audience": "Audience affinity in Qloo under the shared anchors, in the launch city.",
  "R-qloo-local": "Local relevance from the city's own lists and Qloo's origin data.",
  "R-qloo-coherence": "Affinity with the plan's other choices, in the launch city.",
  "R-venue-format": "A venue must be filed in Qloo as a kind of place that can host the launch.",
  "R-venue-in-market": "A venue must be in the launch city's country.",
  "R-feasibility-unverified": "Capacity, availability, opening hours and willingness to take part are not in Qloo and are never assumed.",
  "R-not-self": "The collaboration brand can't be the launching brand itself.",
  "R-ruled-out-phrase": "A choice whose Qloo description matches a phrase a hard rule rules out breaks the brief.",
  "R-brief-terms": "A partner brand shows brief fit when Qloo's description shares the product's or attributes' terms.",
  "R-artist-type": "The music act must be an artist in Qloo.",
  "R-direction-attributes": "The creative direction should carry the brand's stated attributes.",
  "R-no-duplicate": "No two choices may be the same entity.",
  "R-non-circular": "An audience anchor used as a choice is tested against the other anchors only.",
  "R-mainstream": "A top-0.5% mainstream default is noted for a person; it ranks plans only when the brief asks for distinctiveness.",
  "R-coverage": "How much of the plan Qloo could measure: confidence, kept apart from quality.",
  "R-anchor-hypothesis": "Model-suggested audience anchors are hypotheses a person should confirm.",
  "R-user-considered": "A choice the user was only considering is a weaker statement of preference than a named choice.",
  "R-host-tier": "A venue should be a kind of place the brief's event format calls for, not merely one that can host something.",
  "R-neighborhood": "A venue Qloo files under, or near, the neighbourhood the brief names fits it; far from it doesn't. Without either it is unknown.",
  "R-distinct-requested": "When the brief asks for independent, local or non-generic choices, a top-0.5% mainstream default counts against it.",
  "R-product-central": "A headline-scale act or an arena-scale room can make the product an afterthought.",
  "R-avoided-quality": "A choice Qloo describes with something the brief says to avoid counts against it.",
  "R-role-check": "The agent's model read the candidate's Qloo facts against the job in the brief: a structured screen, not Qloo evidence.",
} as const;
export type RuleId = keyof typeof RULES;

export interface MatrixContext {
  brief: LaunchBrief;
  city: string;
  /** Full Qloo records of the plans' entities, for the logical rules (tags, descriptions). */
  facts: Map<string, QlooEntity>;
  anchorSource: ParallelResult["anchorSource"];
  /** Ledger records that resolved an entity, to cite for entity correctness. */
  resolutionEvidence: (entityId: string) => string[];
  /** evidence:v2: the brief-intent contract behind the brief-aware screens. */
  contract?: IntentContract;
  /** evidence:v2: structured role readings, keyed by entity ID (see roleKey). */
  roleChecks?: Map<string, RoleCheck>;
  /** evidence:v2: where the named neighbourhood's venues are, when Qloo returned coordinates. */
  neighborhood?: Centroid | null;
}

/** The key a role reading is stored under: the entity, else the slot and label. */
export const roleKey = (c: Pick<Component, "slot" | "label" | "entity">) => c.entity?.id ?? `${c.slot}:${c.label.toLowerCase()}`;

const SOURCE_OF: Record<"audience" | "local" | "coherence", EvidenceSource> = {
  audience: "qloo_affinity",
  local: "qloo_locality",
  coherence: "qloo_coherence",
};
const RULE_OF: Record<"audience" | "local" | "coherence", RuleId> = {
  audience: "R-qloo-audience",
  local: "R-qloo-local",
  coherence: "R-qloo-coherence",
};

/** A Qloo dimension as a claim. Missing evidence stays unknown; only evidence against is a contradiction. */
function qlooStance(d: DimensionScore, a: ComponentAssessment): { stance: ClaimStance; strength: EvidenceClaim["strength"] } {
  if (d.score === undefined) {
    // Measured and nothing came back: against the choice only when the evaluator says it is contradicted.
    if (d.evidenceIds.length && a.contradicted && d.key === "audience") return { stance: "contradicts", strength: "moderate" };
    return { stance: "unknown", strength: "unknown" };
  }
  if (d.key === "local") {
    if (d.score >= 0.95) return { stance: "supports", strength: "strong" };
    if (d.score >= 0.6) return { stance: "supports", strength: "moderate" };
    if (d.score >= 0.4) return { stance: "unknown", strength: "thin" };
    return { stance: "contradicts", strength: d.score <= 0.1 ? "strong" : "moderate" };
  }
  if (d.score >= 0.8) return { stance: "supports", strength: "strong" };
  if (d.score >= 0.6) return { stance: "supports", strength: "moderate" };
  return { stance: "unknown", strength: "thin" };
}

const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3);

function claimsFor(c: CandidatePlan, ctx: MatrixContext): { claims: EvidenceClaim[]; hard: string[]; states: Partial<Record<Slot, ComponentState>> } {
  const claims: EvidenceClaim[] = [];
  const hard: string[] = [];
  const states: Partial<Record<Slot, ComponentState>> = {};
  const { brief } = ctx;
  const id = c.candidateId;
  const add = (
    slot: Slot | undefined,
    dimension: EvidenceDimension,
    key: string,
    claim: string,
    stance: ClaimStance,
    source: EvidenceSource,
    strength: EvidenceClaim["strength"],
    extra: { evidenceIds?: string[]; ruleId?: RuleId; limitations?: string[] } = {},
  ) =>
    claims.push({
      claimId: `${id}/${slot ?? "plan"}/${key}`,
      candidateId: id,
      slot,
      dimension,
      claim,
      stance,
      source,
      strength,
      evidenceIds: extra.evidenceIds ?? [],
      ruleId: extra.ruleId,
      limitations: extra.limitations ?? [],
    });
  const anchorLimit = ctx.anchorSource === "model_hypothesis" ? ["The audience anchors are model-suggested hypotheses, not named by the user."] : [];
  const anchors = new Set(c.plan.anchors.map((a) => a.id));
  const ownBrand = brief.brandName ? nameKey(brief.brandName) : null;
  const banned = ruledOut(brief);
  const food = isFoodAndDrink(brief.productCategory);

  // ---- user intent and constraints ----
  for (const choice of brief.existingChoices) {
    const comp = c.plan.components.find((x) => x.slot === choice.slot);
    const locked = brief.constraints.some((k) => k.kind === "hard" && k.lockSlot === choice.slot);
    const kept = comp?.origin === "user_provided";
    if (locked && !kept) hard.push(`${SLOT_LABEL[choice.slot]}: the brief fixes "${choice.name}", and this plan doesn't keep it.`);
    // evidence:v2: how firmly the brief asks for it (locked, named, or only considered).
    const considered = !locked && ctx.contract?.choices.find((x) => x.slot === choice.slot)?.strength === "considered";
    add(
      choice.slot,
      "constraint",
      "user-intent",
      kept
        ? `Keeps "${choice.name}", which the brief ${locked ? "names and fixes" : considered ? "was considering" : "names"}.`
        : `Replaces "${choice.name}", which the brief ${considered ? "was only considering" : "names"}.`,
      kept ? "supports" : "contradicts",
      "user",
      locked ? "strong" : considered ? "thin" : "moderate",
      { ruleId: locked ? "R-lock" : considered ? "R-user-considered" : "R-user-choice" },
    );
  }
  const violations = c.evaluation?.hardConstraintViolations ?? [];
  hard.push(...violations);
  add(
    undefined,
    "constraint",
    "hard-constraints",
    violations.length ? `Breaks ${violations.length} hard constraint(s): ${violations.join("; ")}` : "Breaks none of the brief's machine-checkable hard constraints.",
    violations.length ? "contradicts" : "supports",
    "constraint",
    "strong",
    { ruleId: "R-hard-constraints" },
  );
  for (const rule of unverifiableRules(brief.constraints))
    add(undefined, "constraint", `unverifiable:${nameKey(rule)}`, `The hard rule "${rule}" can't be checked by code for any choice.`, "unknown", "constraint", "unknown", {
      ruleId: "R-unverifiable-rule",
      limitations: ["Needs a person to confirm."],
    });
  if (ctx.anchorSource === "model_hypothesis")
    add(undefined, "coverage", "anchors", "Every audience test uses model-suggested anchors.", "unknown", "logical_rubric", "unknown", {
      ruleId: "R-anchor-hypothesis",
      limitations: anchorLimit,
    });

  // ---- per component ----
  let measured = 0;
  for (const comp of c.plan.components) {
    const slot = comp.slot;
    const a = c.evaluation?.components.find((x) => x.slot === slot);
    const fact = comp.entity ? ctx.facts.get(comp.entity.id) : undefined;
    const user = comp.origin === "user_provided";
    let slotHard = false;

    // Entity correctness.
    if (comp.resolution === "resolved")
      add(
        slot,
        "entity",
        "resolution",
        comp.entity ? `Resolved to Qloo's ${comp.entity.name}${comp.entity.shortDescription ? ` (${comp.entity.shortDescription})` : ""}.` : `Mapped onto Qloo's words: ${comp.tags.map((t) => t.name).join(", ")}.`,
        "supports",
        "entity_metadata",
        "moderate",
        { evidenceIds: comp.entity ? ctx.resolutionEvidence(comp.entity.id) : [], ruleId: "R-entity-resolution" },
      );
    else
      add(
        slot,
        "entity",
        "resolution",
        comp.resolution === "ambiguous"
          ? `Qloo's only "${comp.label}" is a different one (${comp.note ?? "a namesake"}), so it couldn't be tested.`
          : `"${comp.label}" isn't in Qloo: no evidence either way.`,
        "unknown",
        "entity_metadata",
        "unknown",
        { ruleId: "R-entity-resolution", limitations: ["Unknown is not a failure: kept and flagged."] },
      );

    // Qloo cultural evidence, from the deterministic evaluation.
    for (const d of a?.dimensions ?? []) {
      if (d.key === "distinct") continue;
      const { stance, strength } = qlooStance(d, a!);
      if (d.score !== undefined) measured++;
      const limitations = [...(d.key === "audience" ? anchorLimit : [])];
      if (d.key === "audience" && comp.entity && anchors.has(comp.entity.id)) limitations.push(RULES["R-non-circular"]);
      add(slot, d.key, d.key, `${comp.label}: ${d.explanation}`, stance, SOURCE_OF[d.key], strength, { evidenceIds: d.evidenceIds, ruleId: RULE_OF[d.key], limitations });
      if (d.key === "local" && slot === "event_place" && d.score !== undefined && d.score <= 0.1) {
        if (user) states[slot] = "needs_human";
        else {
          hard.push(`${SLOT_LABEL[slot]} "${comp.label}" isn't in ${ctx.city}'s country.`);
          slotHard = true;
        }
        add(slot, "constraint", "in-market", `${comp.label} isn't in ${ctx.city}'s country.`, "contradicts", "qloo_locality", "strong", { evidenceIds: d.evidenceIds, ruleId: "R-venue-in-market" });
      }
    }
    const dup = a?.dimensions.find((d) => d.key === "distinct");
    if (dup?.score === 0)
      add(slot, "coherence", "duplicate", `${comp.label} repeats another choice.`, "contradicts", "logical_rubric", "strong", { ruleId: "R-no-duplicate" });

    // Logical brief and role fit.
    if (slot === "event_place" && fact) {
      const f = venueFormat(fact.tags.map((t) => t.id), food);
      add(
        slot,
        "role_fit",
        "format",
        f === "can_host"
          ? `${comp.label} is filed as a kind of place that can host a launch.`
          : f === "unsuitable"
            ? `${comp.label} is filed as a kind of place that can't host a launch (lodging, transport or medical).`
            : `Qloo's categories for ${comp.label} don't say whether it can host a launch.`,
        f === "can_host" ? "supports" : f === "unsuitable" ? "contradicts" : "unknown",
        "logical_rubric",
        f === "unknown" ? "unknown" : "moderate",
        { ruleId: "R-venue-format" },
      );
    }
    // evidence:v2: brief-aware screens, the same for every track's plans.
    const k = ctx.contract;
    if (k && fact) {
      if (slot === "event_place") {
        const tier = hostTier(fact.tags.map((t) => t.id), k, food);
        if (tier !== "unsuitable")
          add(
            slot,
            "role_fit",
            "host-tier",
            tier === "preferred"
              ? `${comp.label} is the kind of place the brief's format calls for (${k.formats.map((f) => f.phrase).slice(0, 3).join(", ") || "an event"}).`
              : tier === "possible"
                ? `${comp.label} can host an event, but isn't the kind of place the brief's format calls for.`
                : `Qloo doesn't say what kind of place ${comp.label} is.`,
            tier === "preferred" ? "supports" : "unknown",
            "logical_rubric",
            tier === "preferred" ? "moderate" : "thin",
            { ruleId: "R-host-tier" },
          );
        const hood = k.neighborhoods[0];
        if (hood) {
          const n = neighborhoodFit(fact, ctx.neighborhood ?? null, hood.value);
          add(
            slot,
            "local",
            "neighborhood",
            n.fit === "near"
              ? n.named
                ? `Qloo places ${comp.label} in ${hood.value}, which the brief names ("${hood.phrase}").`
                : `${comp.label} is ${n.km!.toFixed(1)} km from ${hood.value}, which the brief names ("${hood.phrase}").`
              : n.fit === "far"
                ? `${comp.label} is ${n.km!.toFixed(1)} km from ${hood.value}, which the brief names ("${hood.phrase}").`
                : `Whether ${comp.label} is in ${hood.value} can't be told from Qloo's coordinates.`,
            n.fit === "near" ? "supports" : n.fit === "far" ? "contradicts" : "unknown",
            "qloo_locality",
            n.fit === "unknown" ? "unknown" : "moderate",
            { ruleId: "R-neighborhood", evidenceIds: ctx.neighborhood ? [ctx.neighborhood.evidenceId] : [] },
          );
        }
      }
      const central = centralityFlag(slot, fact, k);
      if (central) add(slot, "role_fit", "central", `${comp.label}: ${central}.`, "contradicts", "logical_rubric", "thin", { ruleId: "R-product-central" });
      const avoided = avoidedMatch(fact, k);
      if (avoided)
        add(slot, "role_fit", "avoided", `Qloo describes ${comp.label} with "${avoided}", which the brief says to avoid ("${k.negative.find((n) => n.value.toLowerCase().includes(avoided))?.phrase ?? avoided}").`, "contradicts", "logical_rubric", "thin", {
          ruleId: "R-avoided-quality",
        });
    }
    const role = ctx.roleChecks?.get(roleKey(comp));
    if (role)
      add(
        slot,
        "role_fit",
        "role-check",
        `${comp.label}: ${role.reason}`,
        role.verdict === "fits" ? "supports" : role.verdict === "wrong" ? "contradicts" : "unknown",
        "logical_rubric",
        role.verdict === "doubtful" ? "thin" : "moderate",
        { ruleId: "R-role-check", evidenceIds: [role.evidenceId], limitations: ["A model's reading of the facts shown, not Qloo evidence."] },
      );
    if (role && !role.central && !centralityFlag(slot, fact, k ?? ({ formats: [] } as unknown as IntentContract)))
      add(slot, "role_fit", "role-central", `${comp.label} may overshadow the product (model reading).`, "contradicts", "logical_rubric", "thin", {
        ruleId: "R-role-check",
        evidenceIds: [role.evidenceId],
        limitations: ["A model's reading of the facts shown, not Qloo evidence."],
      });

    if (slot === "event_place")
      add(slot, "feasibility", "unverified", `Capacity, availability and willingness of ${comp.label} to host are unverified.`, "unknown", "logical_rubric", "unknown", {
        ruleId: "R-feasibility-unverified",
        limitations: ["Needs a person to confirm with the venue."],
      });
    if (slot === "brand_collaboration") {
      if (ownBrand && nameKey(comp.label) === ownBrand) {
        hard.push(`The collaboration brand is the launching brand itself.`);
        slotHard = true;
        add(slot, "role_fit", "not-self", `${comp.label} is the launching brand, not a collaborator.`, "contradicts", "logical_rubric", "strong", { ruleId: "R-not-self" });
      }
      if (fact) {
        const fit = fitsBrief(fact, brief, { requireAttributes: true });
        const rule = fitsBrief(fact, brief, { requireAttributes: false });
        if (!rule.ok) {
          if (user) states[slot] = "needs_human";
          else {
            hard.push(`${SLOT_LABEL[slot]} "${comp.label}" ${rule.why}.`);
            slotHard = true;
          }
          add(slot, "constraint", "ruled-out", `${comp.label} ${rule.why}.`, "contradicts", "logical_rubric", "strong", { ruleId: "R-ruled-out-phrase" });
        } else
          add(
            slot,
            "role_fit",
            "brief-terms",
            fit.ok ? `Qloo's description of ${comp.label} shares terms with the product or its attributes.` : `Qloo's description of ${comp.label} doesn't show terms from the product or its attributes.`,
            fit.ok ? "supports" : "unknown",
            "logical_rubric",
            fit.ok ? "thin" : "unknown",
            { ruleId: "R-brief-terms" },
          );
      }
    }
    if (slot === "artist_music" && comp.entity)
      add(
        slot,
        "role_fit",
        "artist-type",
        comp.entity.type === "urn:entity:artist" ? `${comp.label} is a music artist in Qloo.` : `${comp.label} isn't filed as an artist in Qloo.`,
        comp.entity.type === "urn:entity:artist" ? "supports" : "contradicts",
        "entity_metadata",
        "moderate",
        { ruleId: "R-artist-type" },
      );
    if (slot === "creative_direction") {
      // Compared by stem: "minimalism" carries "minimalist".
      const text = new Set(words([comp.label, ...comp.tags.map((t) => t.name)].join(" ")).map(stem));
      const attrs = brief.brandAttributes.flatMap(words);
      const ruled = comp.tags.find((t) => banned.some((p) => p.includes(t.name.toLowerCase()) || t.name.toLowerCase().includes(p)));
      if (ruled) {
        if (user) states[slot] = "needs_human";
        else {
          hard.push(`Creative direction uses "${ruled.name}", which a hard rule rules out.`);
          slotHard = true;
        }
        add(slot, "constraint", "ruled-out", `The direction uses "${ruled.name}", which a hard rule rules out.`, "contradicts", "logical_rubric", "strong", { ruleId: "R-ruled-out-phrase" });
      }
      if (attrs.length) {
        const shared = attrs.filter((w) => text.has(stem(w)));
        add(
          slot,
          "role_fit",
          "attributes",
          shared.length ? `The direction carries the brand attribute(s): ${[...new Set(shared)].join(", ")}.` : `The direction doesn't name the brand's attributes (${brief.brandAttributes.join(", ")}).`,
          shared.length ? "supports" : "unknown",
          "logical_rubric",
          shared.length ? "moderate" : "unknown",
          { ruleId: "R-direction-attributes" },
        );
      }
    }
    if (comp.entity && comp.entity.popularity !== null) {
      const mainstream = comp.entity.popularity >= 0.995;
      // evidence:v2: a mainstream default counts against a choice only when the brief asks for distinctiveness.
      const requested = ctx.contract?.wantsDistinctive ?? false;
      add(
        slot,
        "distinctiveness",
        "mainstream",
        mainstream ? `${comp.label} is a top-0.5% mainstream name in Qloo${requested ? ", and the brief asks for independent or non-generic choices" : ""}.` : `${comp.label} isn't a top-0.5% mainstream default.`,
        mainstream ? (requested && mainstreamFlag(comp.entity.popularity, ctx.contract!) ? "contradicts" : "unknown") : "supports",
        "entity_metadata",
        "thin",
        { ruleId: requested ? "R-distinct-requested" : "R-mainstream" },
      );
    }

    // Layer 6: what a person should make of it.
    if (!states[slot])
      states[slot] = slotHard || a?.status === "constraint_conflict"
        ? "rejected"
        : comp.resolution !== "resolved"
          ? user
            ? "needs_human"
            : "unverified"
          : a?.contradicted
            ? "conflicting"
            : a?.status === "supported"
              ? "supported"
              : (a?.dimensions ?? []).some((d) => d.key !== "distinct" && d.score !== undefined)
                ? "plausible_thin"
                : "unverified";
  }

  const checks = c.plan.components.length * 3;
  const coverage = checks ? measured / checks : 0;
  add(
    undefined,
    "coverage",
    "coverage",
    `Qloo measured ${measured} of ${checks} checks (audience, local, coherence for ${c.plan.components.length} choice(s)); ${SLOTS.length - c.plan.components.length} slot(s) open.`,
    coverage >= 0.6 ? "supports" : "unknown",
    "logical_rubric",
    coverage >= 0.8 ? "strong" : coverage >= 0.6 ? "moderate" : coverage > 0 ? "thin" : "unknown",
    { ruleId: "R-coverage", limitations: coverage < 0.6 ? ["Thin coverage means uncertainty, not failure."] : [] },
  );
  return { claims, hard: [...new Set(hard)], states };
}

export function buildEvidenceMatrix(candidates: CandidatePlan[], ctx: MatrixContext): EvidenceMatrix {
  const m: EvidenceMatrix = {
    rubricVersion: EVIDENCE_RUBRIC_VERSION,
    candidateIds: candidates.map((c) => c.candidateId),
    claims: [],
    coverageByCandidate: {},
    completenessByCandidate: {},
    hardFailures: {},
    componentStates: {},
  };
  for (const c of candidates) {
    const { claims, hard, states } = claimsFor(c, ctx);
    m.claims.push(...claims);
    m.hardFailures[c.candidateId] = hard;
    m.componentStates[c.candidateId] = states;
    m.completenessByCandidate[c.candidateId] = c.plan.components.length / SLOTS.length;
    const cov = claims.find((x) => x.claimId === `${c.candidateId}/plan/coverage`)!;
    const n = cov.claim.match(/measured (\d+) of (\d+)/);
    m.coverageByCandidate[c.candidateId] = n && Number(n[2]) ? Number(n[1]) / Number(n[2]) : 0;
  }
  return m;
}

const WEIGHT: Record<EvidenceClaim["strength"], number> = { strong: 1, moderate: 1, thin: 0.5, unknown: 0 };
const net = (claims: EvidenceClaim[], dims: EvidenceDimension[]) =>
  claims
    .filter((c) => dims.includes(c.dimension))
    .reduce((s, c) => s + (c.stance === "supports" ? WEIGHT[c.strength] : c.stance === "contradicts" ? -Math.max(WEIGHT[c.strength], 0.5) : 0), 0);

/** How much keeping (or replacing) a user's unlocked choice weighs in brief fit: named 0.5, only considered 0.25. */
const PREFERENCE: Partial<Record<RuleId, number>> = { "R-user-choice": 0.5, "R-user-considered": 0.25 };

/**
 * The decision policy (evidence:v2) as a vector, compared left to right:
 *   1. hard failures; 2. explicit locks kept; 3. completeness; 4. role and brief fit (with the
 *   user's unlocked choices as weighted preferences); 5. audience support, counted per choice so
 *   one exceptional affinity can't make up for weak ones; 6. locality and neighbourhood;
 *   7. cross-component coherence; 8. distinctiveness; 9. evidence coverage, as confidence only.
 */
export function evidenceVector(m: EvidenceMatrix, candidateId: string): number[] {
  const mine = m.claims.filter((c) => c.candidateId === candidateId);
  const intent = mine.filter((c) => c.claimId.endsWith("/user-intent"));
  const locks = intent.filter((c) => c.ruleId === "R-lock");
  const preference = intent.reduce((s, c) => s + (PREFERENCE[c.ruleId as RuleId] ?? 0) * (c.stance === "supports" ? 1 : c.stance === "contradicts" ? -1 : 0), 0);
  const audience = mine.filter((c) => c.dimension === "audience" && c.slot);
  const choices = new Set(mine.filter((c) => c.dimension === "entity" && c.slot).map((c) => c.slot));
  const supportedAudience = new Set(audience.filter((c) => c.stance === "supports").map((c) => c.slot));
  return [
    -(m.hardFailures[candidateId]?.length ?? 0),
    locks.filter((c) => c.stance === "supports").length - locks.filter((c) => c.stance === "contradicts").length,
    m.completenessByCandidate[candidateId] ?? 0,
    net(mine, ["role_fit"]) + preference,
    -(choices.size - supportedAudience.size),
    net(mine, ["local"]),
    net(mine, ["coherence"]),
    // Distinctiveness ranks plans only when the brief asks for it (R-distinct-requested).
    net(mine.filter((c) => c.ruleId === "R-distinct-requested"), ["distinctiveness", "diversity"]),
    m.coverageByCandidate[candidateId] ?? 0,
  ];
}

export function compareVectors(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (Math.abs(d) > 1e-9) return d;
  }
  return 0;
}

/** Candidates best first under the decision policy; ties keep the given order. */
export function evidenceOrder(m: EvidenceMatrix, ids: string[]): string[] {
  return [...ids].sort((a, b) => compareVectors(evidenceVector(m, b), evidenceVector(m, a)));
}

/** The claims of one candidate, for a slot or the whole plan. */
export const claimsOf = (m: EvidenceMatrix, candidateId: string, slot?: Slot) =>
  m.claims.filter((c) => c.candidateId === candidateId && (slot === undefined || c.slot === slot));

/** Components of a plan as one line each, for prompts and reports. */
export const componentLine = (c: Component) =>
  `${SLOT_LABEL[c.slot]}: ${c.label}${c.tags.length && c.slot === "creative_direction" ? ` (${c.tags.map((t) => t.name).join(", ")})` : ""}`;
