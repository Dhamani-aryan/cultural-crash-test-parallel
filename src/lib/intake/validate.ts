import type { Constraint, LaunchBriefInput } from "@/lib/crashtest/types";
import { SLOT_LABEL } from "@/lib/crashtest/types";
import { marketById, TARGET_MARKETS } from "@/lib/markets";
import { nameKey } from "@/lib/engine/stats";
import type { CriticalField, IntakeBrief, IntakeState } from "./types";

/**
 * Deterministic completeness. The model never decides whether a brief is complete or whether a
 * run may start; these functions do, on the client for display and on the server for real.
 */

/** The supported market a city name in the text refers to, if any. */
export function marketFromText(cityText: string): string | null {
  const k = nameKey(cityText);
  if (!k) return null;
  const m = TARGET_MARKETS.find(
    (x) =>
      nameKey(x.label) === k ||
      nameKey(x.qlooLocation) === k ||
      k.includes(nameKey(x.label)) ||
      (x.locationAliases ?? []).some((alias) => nameKey(alias) === k),
  );
  if (m) return m.id;
  // "Bushwick, Brooklyn": a district with a known area of exactly one supported city in it.
  const within = marketsFromText(cityText);
  return within.length === 1 ? within[0] : null;
}

/** All supported markets named in a longer message. Used only when exactly one is unambiguous. */
export function marketsFromText(text: string): string[] {
  const k = nameKey(text);
  if (!k) return [];
  return TARGET_MARKETS.filter((market) =>
    [market.label, market.qlooLocation, ...(market.locationAliases ?? [])].some((name) =>
      k.includes(nameKey(name)),
    ),
  ).map((market) => market.id);
}

/** Audience counts only once the user wrote it, or picked or confirmed a suggestion. */
export function audienceConfirmed(state: Pick<IntakeState, "brief" | "origins">): boolean {
  return (
    state.brief.audienceDescription.trim().length >= 3 &&
    state.origins.audienceDescription !== "model_suggested"
  );
}

export function cityConflict(brief: IntakeBrief): boolean {
  if (!brief.cityText || !brief.marketId) return false;
  const fromText = marketFromText(brief.cityText);
  // A city the text names that isn't the selected one, or isn't supported at all, needs the
  // user to settle it before research.
  return fromText !== brief.marketId;
}

export function missingFields(
  state: Pick<IntakeState, "brief" | "origins"> & { delegated?: boolean },
): CriticalField[] {
  const b = state.brief;
  // Once the user hands the rest over, only what can't be assumed is required: what they sell
  // and the city. Everything else the assistant filled in is listed as an assumption.
  if (state.delegated) {
    const missing: CriticalField[] = [];
    if (cityConflict(b)) missing.push("cityConflict");
    if (b.productCategory.trim().length < 2) missing.push("productCategory");
    if (!marketById(b.marketId)) missing.push("marketId");
    if (b.audienceDescription.trim().length < 3) missing.push("audience");
    return missing;
  }
  const missing: CriticalField[] = [];
  // The city comes first: the rest of the questions can depend on it.
  if (cityConflict(b)) missing.push("cityConflict");
  if (b.productCategory.trim().length < 2) missing.push("productCategory");
  if (b.launchGoal.trim().length < 2) missing.push("launchGoal");
  if (!marketById(b.marketId)) missing.push("marketId");
  if (!audienceConfirmed(state)) missing.push("audience");
  // Brand character improves the analysis but is not a reason to trap a usable campaign brief in
  // intake. When it is absent, the review records a transparent assumption and lets the user edit
  // it before generating recommendations.
  return missing;
}

export const MISSING_LABEL: Record<CriticalField, string> = {
  productCategory: "What you sell",
  launchGoal: "What the launch is",
  marketId: "Which city",
  audience: "Who it's for (confirmed by you)",
  brandContext: "What the brand stands for (an attribute, value or differentiator)",
  cityConflict: "The city: your text and the selector disagree",
};

/** Recompute everything derived; never trust a client's flags. */
export function refresh(state: IntakeState): IntakeState {
  const missingCriticalFields = missingFields(state);
  const confirmed = state.confirmed && missingCriticalFields.length === 0;
  return { ...state, missingCriticalFields, confirmed, readyToRun: confirmed };
}

/**
 * The confirmed intake as a crash-test brief. Locks become hard lock constraints, exclusions
 * become machine-checked exclusions, other rules are carried as text.
 */
export function toLaunchBrief(
  state: IntakeState,
  depth: "quick" | "thorough" = "thorough",
): LaunchBriefInput {
  const b = state.brief;
  const constraints: Constraint[] = [];
  for (const c of b.choices.filter((x) => x.locked))
    constraints.push({
      id: `lock-${c.slot}`,
      kind: "hard",
      lockSlot: c.slot,
      description: `Keep the ${SLOT_LABEL[c.slot].toLowerCase()}: ${c.name}`,
    });
  if (b.exclude.length)
    constraints.push({
      id: "exclude",
      kind: "hard",
      excludeNames: b.exclude,
      description: `Never use: ${b.exclude.join(", ")}`,
    });
  b.otherRules.forEach((r, i) =>
    constraints.push({ id: `rule-${i}`, kind: "hard", description: r }),
  );
  return {
    brandName: b.brandName || undefined,
    productCategory: b.productCategory,
    launchGoal: b.launchGoal,
    sourceText:
      state.messages
        .filter((message) => message.role === "user")
        .map((message) => message.text.trim())
        .filter(Boolean)
        .join("\n")
        .slice(0, 4000) || undefined,
    marketId: b.marketId,
    audienceDescription: b.audienceDescription,
    // Suggested anchors are hypotheses, not user commitments. Let the planner propose and, if
    // necessary, broaden measurable anchors; explicit user anchors remain protected.
    audienceAnchors: state.origins.audienceAnchors === "model_suggested" ? [] : b.audienceAnchors,
    brandAttributes: b.brandAttributes,
    budgetBand: b.budgetBand || undefined,
    existingChoices: b.choices.map(({ slot, name }) => ({ slot, name })),
    constraints,
    depth,
    exploreUserChoices: b.exploreUserChoices,
    website: b.website || undefined,
  };
}

/** Words that would mean inferring a sensitive trait about people. Suggestions containing them are dropped. */
const SENSITIVE =
  /\b(race|racial|ethnic\w*|religio\w*|muslim|christian|jewish|hindu|sikh|buddhist|gay|lesbian|queer|lgbt\w*|trans(gender)?|sexual\w*|disab\w*|illness|health condition|diagnos\w*|pregnan\w*|politic\w*|liberal|conservative|left-wing|right-wing|immigra\w*|caste|income bracket|low-income|poor|wealthy)\b/i;

export function infersSensitiveTrait(text: string): boolean {
  return SENSITIVE.test(text);
}

/**
 * An intake built straight from a structured brief (home-page examples): every field counts as
 * the user's, choices keep their locks, and the user still has to confirm before a run.
 */
export function intakeFromBrief(
  brief: LaunchBriefInput,
  text: string,
  intakeId: string,
): IntakeState {
  const locked = new Set(
    (brief.constraints ?? []).flatMap((c) => (c.kind === "hard" && c.lockSlot ? [c.lockSlot] : [])),
  );
  const b: IntakeBrief = {
    brandName: brief.brandName ?? "",
    productCategory: brief.productCategory,
    launchGoal: brief.launchGoal,
    marketId: brief.marketId,
    cityText: "",
    audienceDescription: brief.audienceDescription,
    audienceAnchors: brief.audienceAnchors ?? [],
    brandAttributes: brief.brandAttributes ?? [],
    budgetBand: brief.budgetBand ?? "",
    website: brief.website ?? "",
    choices: (brief.existingChoices ?? []).map((c) => ({ ...c, locked: locked.has(c.slot) })),
    exclude: (brief.constraints ?? []).flatMap((c) => c.excludeNames ?? []),
    otherRules: (brief.constraints ?? [])
      .filter((c) => !c.lockSlot && !c.excludeNames?.length)
      .map((c) => c.description),
    exploreUserChoices: brief.exploreUserChoices ?? true,
  };
  const origins = Object.fromEntries(Object.keys(b).map((k) => [k, "user_supplied" as const]));
  const now = new Date().toISOString();
  return refresh({
    intakeId,
    mode: "validate_plan",
    messages: [
      { id: "u1", role: "user", text, createdAt: now },
      {
        id: "a2",
        role: "assistant",
        text: "Here's the example as a brief. Check it, edit anything, then confirm.",
        createdAt: now,
      },
    ],
    brief: b,
    origins,
    missingCriticalFields: [],
    assumptions: [],
    audienceHypotheses: [],
    chips: [{ label: "Generate recommendations", action: "confirm" }],
    clarificationTurns: 0,
    delegated: false,
    confirmed: false,
    readyToRun: false,
  });
}
