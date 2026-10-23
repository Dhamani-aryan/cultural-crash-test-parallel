import { SLOT_LABEL, type Constraint, type LaunchBriefInput } from "@/lib/crashtest/types";
import type { BriefPatch } from "./types";

/**
 * Apply clarification patches to the structured brief, deterministically. The user's original
 * message (sourceText) is never edited: a clarification becomes a machine-checked lock or
 * exclusion where one exists, otherwise an explicit constraint every track sees. Every patch
 * leaves an audit line; an "assumption" patch changes nothing and is only recorded.
 */

/** LaunchBriefSchema allows at most this many constraints; beyond it a clarification is recorded, not enforced. */
const MAX_CONSTRAINTS = 8;

/** Words the brief-intent contract reads as each event format (see FORMAT_PATTERNS). */
const FORMAT_WORDS: Record<string, string> = {
  pop_up: "a pop-up",
  showroom: "a showroom",
  exhibition: "an exhibition",
  listening_party: "a listening party",
  party: "a launch party",
  festival: "a festival",
  store_opening: "a store opening",
  screening: "a screening",
  workshop: "a workshop",
  live_music: "a live performance",
  food_and_drink: "a tasting dinner",
  bar: "a cocktail bar",
  community: "a community gathering",
  product_drop: "a product drop",
};

export interface PatchResult {
  brief: LaunchBriefInput;
  /** What each patch did, for the audit and the transcript. */
  applied: { patch: BriefPatch; effect: string }[];
  assumptions: string[];
  /** Left open on purpose (an unresolved identity): the result must be provisional. */
  provisional: string[];
}

export function applyPatches(input: LaunchBriefInput, patches: BriefPatch[]): PatchResult {
  const brief: LaunchBriefInput = structuredClone(input);
  const constraints: Constraint[] = [...(brief.constraints ?? [])];
  let choices = [...(brief.existingChoices ?? [])];
  const applied: PatchResult["applied"] = [];
  const assumptions: string[] = [];
  const provisional: string[] = [];
  let n = constraints.filter((c) => c.id.startsWith("clarify-")).length;
  const add = (kind: "hard" | "soft", description: string, extra: Partial<Constraint> = {}) => {
    // The same clarification twice is one constraint.
    if (constraints.some((c) => c.description === description)) return "already recorded";
    if (constraints.length >= MAX_CONSTRAINTS) {
      assumptions.push(`${description} (recorded, not enforced: the brief already has ${MAX_CONSTRAINTS} rules)`);
      return "recorded only: the brief's rule limit is reached";
    }
    constraints.push({ id: `clarify-${++n}`, kind, description, ...extra });
    return `added a ${kind} rule: ${description}`;
  };
  const unlock = (slot: string) => {
    const before = constraints.length;
    for (let i = constraints.length - 1; i >= 0; i--) if (constraints[i].lockSlot === slot) constraints.splice(i, 1);
    return before !== constraints.length;
  };

  for (const p of patches) {
    let effect: string;
    switch (p.kind) {
      case "choice_strength": {
        const label = SLOT_LABEL[p.slot].toLowerCase();
        if (!choices.some((c) => c.slot === p.slot)) choices.push({ slot: p.slot, name: p.name });
        if (p.strength === "locked") {
          effect = constraints.some((c) => c.lockSlot === p.slot) ? "already locked" : add("hard", `Keep the ${label}: ${p.name}`, { lockSlot: p.slot });
        } else if (p.strength === "example") {
          unlock(p.slot);
          choices = choices.filter((c) => c.slot !== p.slot);
          effect = add("soft", `${p.name} was given as an example of the ${label} wanted, not as a choice`);
        } else {
          const unlocked = unlock(p.slot);
          effect = add("soft", `${p.name} is ${p.strength === "preferred" ? "preferred, but open to stronger alternatives" : "only being considered; explore alternatives"}`);
          if (unlocked) effect = `removed the lock; ${effect}`;
        }
        break;
      }
      case "geography":
        effect =
          p.strictness === "required"
            ? add("hard", `The venue must be in ${p.place}`)
            : p.strictness === "nearby"
              ? add("soft", `A venue in or near ${p.place} is preferred; elsewhere is acceptable if it is clearly stronger`)
              : add("soft", `${p.place} is not required: anywhere in the city is acceptable`);
        break;
      case "event_format":
        effect = add("soft", `The launch is ${FORMAT_WORDS[p.format] ?? p.format}`);
        break;
      case "priority": {
        const exclude = p.keep.match(/^exclude (.+)$/);
        const use = p.keep.match(/^use (.+)$/);
        if (exclude) {
          choices = choices.filter((c) => c.name.toLowerCase() !== exclude[1].toLowerCase());
          effect = `dropped the named ${exclude[1]}: the exclusion stands`;
        } else if (use) {
          for (const c of constraints) if (c.excludeNames) c.excludeNames = c.excludeNames.filter((x) => x.toLowerCase() !== use[1].toLowerCase());
          for (let i = constraints.length - 1; i >= 0; i--) if (constraints[i].excludeNames && !constraints[i].excludeNames!.length) constraints.splice(i, 1);
          effect = `removed ${use[1]} from the exclusions: the named choice stands`;
        } else effect = add("soft", `Priority: ${p.keep} comes before ${p.over}`);
        break;
      }
      case "identity":
        if (p.meaning === "unresolved") {
          const text = `${p.name} stays unresolved: it isn't measured as Qloo's namesake, and a person should confirm who is meant`;
          provisional.push(text);
          assumptions.push(text);
          effect = "left unresolved and flagged";
        } else
          effect = add(
            "soft",
            p.meaning === "as_described_by_user"
              ? `${p.name} is the one${p.country ? ` from ${p.country}` : " the brief describes"}, not Qloo's namesake`
              : `${p.name} is the one Qloo knows by that name`,
          );
        break;
      case "quality":
        effect = add(p.polarity === "required" ? "hard" : "soft", p.polarity === "avoid" ? `Avoid: ${p.quality}` : `${p.polarity === "required" ? "Required" : "Preferred"}: ${p.quality}`);
        break;
      case "rule_meaning":
        effect = add("soft", `"${p.rule}" means: ${p.meaning}`);
        break;
      case "assumption":
        assumptions.push(p.text);
        effect = "recorded as an assumption";
        break;
    }
    applied.push({ patch: p, effect });
  }
  brief.constraints = constraints;
  brief.existingChoices = choices;
  return { brief, applied, assumptions, provisional };
}
