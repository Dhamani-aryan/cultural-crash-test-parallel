import { compileIntent, type IntentContract } from "@/lib/crashtest/intent";
import { SLOT_LABEL, type LaunchBrief, type Slot } from "@/lib/crashtest/types";
import type { Market } from "@/lib/markets";
import type { BriefPatch, Effects, IdentityFact, Resolution, Uncertainty } from "./types";

/**
 * Deterministic materiality checks. Each reads only the parsed brief, its intent contract and the
 * identity facts preflight gathered; none reads Qloo affinity, evidence strength or candidates.
 * Wording that settles a question ("booked", "considering", "around Bondi") resolves it without
 * asking; only a genuinely open, material decision becomes an uncertainty.
 */

const NONE: Effects = { eligibility: false, constraintState: false, eventRole: false, winnerOrder: false, identity: false };
const effects = (e: Partial<Effects>): Effects => ({ ...NONE, ...e });

/** Firm wording: the choice is fixed. */
const FIRM = /\b(must|booked|confirmed|already (?:booked|confirmed|secured|signed|agreed)|keep(?:ing)?|locked|fixed|non-negotiable|signed|secured|have to|has to)\b/i;
/** Tentative wording: the choice is only being considered. */
const TENTATIVE = /\b(consider(?:ing)?|possibly|potentially|hoping|hope to|might|maybe|perhaps|could|exploring|thinking (?:of|about)|open to (?:other|alternatives)|would love|ideally)\b/i;
/** Example wording: the name illustrates a kind, it isn't a choice. */
const EXAMPLE = /\b(for example|e\.g\.|such as|something like|someone like|a brand like|an artist like)\b/i;
/** Asking the agent to replace something. */
const REPLACE = /\b(find|suggest|look for|recommend|explore)\s+(?:us\s+)?(?:a\s+|an\s+)?(better|other|alternative|different|new)\b/i;
const SLOT_WORDS: Record<Slot, RegExp> = {
  artist_music: /\b(artist|act|performer|music|musician|dj|band|performance)\b/i,
  brand_collaboration: /\b(brand|collaborat\w*|partner)\b/i,
  event_place: /\b(venue|space|location|place|spot)\b/i,
  creative_direction: /\b(direction|concept|aesthetic|look)\b/i,
};
/** A neighbourhood the brief makes mandatory, or only a centre of gravity. */
const REQUIRED = /\b(must|only|has to|have to|needs? to|strictly|exclusively)\b/i;
const NEARBY = /\b(around|near|nearby|close to|or nearby|in or near|area|neighbourhood or nearby)\b/i;
const ANYWHERE = /\b(anywhere|any (?:part|area|neighbou?rhood)|wherever|location is flexible|flexible on (?:the )?location)\b/i;
const HEADLINE = /\b(headline|headliner|global (?:star|artist|act|name)|celebrity|famous|big[- ]name|star power|a-list)\b/i;
const NOT_DOMINATED = /\b(celebrity|dominat\w*|overshadow\w*|star[- ]led|about the (?:artist|act))\b/i;

/** The brief's own words around a match, for citing. */
const window = (text: string, at: number, before: number, after: number) => text.slice(Math.max(0, at - before), at + after);
const sentenceOf = (text: string, at: number) => {
  const start = Math.max(text.lastIndexOf(".", at - 1), text.lastIndexOf("!", at - 1), text.lastIndexOf("?", at - 1)) + 1;
  const ends = [".", "!", "?"].map((p) => text.indexOf(p, at)).filter((i) => i >= 0);
  return text.slice(start, ends.length ? Math.min(...ends) + 1 : text.length).trim();
};
const negated = (s: string) => /\b(not|no|never|without|rather than|instead of|avoid\w*|don't|do not)\b/i.test(s);

export interface Findings {
  uncertainties: Uncertainty[];
  resolutions: Resolution[];
}

export function detect(brief: LaunchBrief, market: Market, identities: IdentityFact[] = [], contract?: IntentContract): Findings {
  const k = contract ?? compileIntent(brief, market, { names: brief.audienceAnchors, source: brief.audienceAnchors.length ? "user" : "none" });
  const text = brief.sourceText ?? "";
  const out: Findings = { uncertainties: [], resolutions: [] };
  conflicts(brief, k, text, out);
  for (const f of identities) out.uncertainties.push(identity(f));
  choiceStrength(brief, text, out);
  geography(k, text, market, out);
  eventFormat(brief, k, out);
  // A conflict on a slot settles that slot's strength question: ask about the conflict only.
  const conflicted = new Set(out.uncertainties.filter((u) => u.reason === "conflict").flatMap((u) => u.affectedSlots));
  out.uncertainties = out.uncertainties.filter((u) => u.reason !== "choice_strength" || !u.affectedSlots.some((s) => conflicted.has(s)));
  return out;
}

// ---------- 1. conflicts ----------

function conflicts(brief: LaunchBrief, k: IntentContract, text: string, out: Findings) {
  // A choice the brief both fixes and asks to replace.
  for (const c of brief.existingChoices) {
    const at = text.toLowerCase().indexOf(c.name.toLowerCase());
    if (at < 0) continue;
    const near = window(text, at, 80, c.name.length + 40);
    const replace = [...text.matchAll(new RegExp(REPLACE.source, "gi"))].find((m) => SLOT_WORDS[c.slot].test(window(text, m.index!, 0, 60)));
    if (FIRM.test(near) && replace) {
      const firm = near.match(FIRM)![0];
      out.uncertainties.push({
        id: `conflict:keep-or-replace:${c.slot}`,
        reason: "conflict",
        what: `The brief fixes ${c.name} ("${firm}") and also asks for a ${SLOT_LABEL[c.slot].toLowerCase()} alternative.`,
        sourcePhrases: [near.trim(), window(text, replace.index!, 0, 60).trim()],
        affectedSlots: [c.slot],
        interpretations: [
          { label: `Keep ${c.name}; it is fixed`, consequence: "Locks the slot in every plan.", patches: [{ kind: "choice_strength", slot: c.slot, name: c.name, strength: "locked" }] },
          { label: "Look for a better option", consequence: `${c.name} becomes one candidate among others.`, patches: [{ kind: "choice_strength", slot: c.slot, name: c.name, strength: "preferred" }] },
        ],
        multi: false,
        effects: effects({ constraintState: true, eligibility: true }),
        safeDefault: { assumption: `${c.name} is kept as fixed, because the brief says "${firm}"; alternatives are shown for comparison only.`, patches: [{ kind: "choice_strength", slot: c.slot, name: c.name, strength: "locked" }], provisional: true },
        origin: "deterministic",
        confidence: "high",
        limitations: [],
        prompt: `You said ${c.name} is ${firm}, and also asked for a better ${SLOT_LABEL[c.slot].toLowerCase()}. Which comes first?`,
      });
    }
  }

  // A headline act wanted, and celebrity or domination avoided.
  const headline = [...text.matchAll(new RegExp(HEADLINE.source, "gi"))].find((m) => !negated(window(text, m.index!, 40, 0)));
  const avoid = k.negative.find((n) => NOT_DOMINATED.test(n.phrase));
  if (headline && avoid) {
    out.uncertainties.push({
      id: "conflict:headline-vs-product",
      reason: "conflict",
      what: "The brief asks for a headline name and also says the launch shouldn't be celebrity-led.",
      sourcePhrases: [sentenceOf(text, headline.index!), avoid.phrase],
      affectedSlots: ["artist_music"],
      interpretations: [
        { label: "A headline name matters most", consequence: "Headline-scale acts stay eligible.", patches: [{ kind: "priority", keep: headline[0], over: avoid.phrase }] },
        { label: "Keep the product at the centre", consequence: "Headline-scale acts count against a plan.", patches: [{ kind: "priority", keep: avoid.phrase, over: headline[0] }] },
      ],
      multi: false,
      effects: effects({ eligibility: true, constraintState: true }),
      safeDefault: { assumption: `The product stays central ("${avoid.phrase}"); a headline-scale act is flagged if it wins.`, patches: [{ kind: "priority", keep: avoid.phrase, over: headline[0] }], provisional: true },
      origin: "deterministic",
      confidence: "medium",
      limitations: [],
      prompt: "You want a headline name but don't want the launch to feel celebrity-led. Which matters more?",
    });
  }

  // A mandatory neighbourhood and "anywhere in the city".
  const hood = k.neighborhoods[0];
  if (hood) {
    const at = text.toLowerCase().indexOf(hood.value.toLowerCase());
    const strict = at >= 0 && REQUIRED.test(window(text, at, 40, 0));
    const broad = text.match(ANYWHERE);
    if (strict && broad) {
      out.uncertainties.push({
        id: "conflict:neighbourhood-vs-anywhere",
        reason: "conflict",
        what: `The brief requires ${hood.value} and also says anywhere is fine.`,
        sourcePhrases: [window(text, at, 40, hood.value.length).trim(), broad[0]],
        affectedSlots: ["event_place"],
        interpretations: [
          { label: `It must be in ${hood.value}`, consequence: "Venues outside it aren't eligible.", patches: [{ kind: "geography", place: hood.value, strictness: "required" }] },
          { label: `Anywhere in ${k.city.value} is fine`, consequence: "Any venue in the city is eligible.", patches: [{ kind: "geography", place: hood.value, strictness: "city" }] },
        ],
        multi: false,
        effects: effects({ eligibility: true }),
        safeDefault: { assumption: `${hood.value} is preferred, not required; a venue elsewhere is flagged if it wins.`, patches: [{ kind: "geography", place: hood.value, strictness: "nearby" }], provisional: true },
        origin: "deterministic",
        confidence: "high",
        limitations: [],
        prompt: `You mentioned ${hood.value} as a must, and also that anywhere is fine. Which should I follow?`,
      });
    }
  }

  // A choice the brief names and also excludes.
  const excluded = brief.constraints.flatMap((c) => (c.kind === "hard" ? (c.excludeNames ?? []) : []));
  for (const c of brief.existingChoices) {
    const hit = excluded.find((x) => x.trim().toLowerCase() === c.name.trim().toLowerCase());
    if (!hit) continue;
    out.uncertainties.push({
      id: `conflict:named-and-excluded:${c.slot}`,
      reason: "conflict",
      what: `${c.name} is both named as the ${SLOT_LABEL[c.slot].toLowerCase()} and excluded.`,
      sourcePhrases: [c.name],
      affectedSlots: [c.slot],
      interpretations: [
        { label: `Use ${c.name}`, consequence: "The exclusion is dropped.", patches: [{ kind: "priority", keep: `use ${c.name}`, over: `exclude ${c.name}` }] },
        { label: `Never use ${c.name}`, consequence: "The named choice is dropped.", patches: [{ kind: "priority", keep: `exclude ${c.name}`, over: `use ${c.name}` }] },
      ],
      multi: false,
      effects: effects({ eligibility: true, constraintState: true }),
      safeDefault: { assumption: `${c.name} is excluded: a hard exclusion wins over a named choice.`, patches: [{ kind: "priority", keep: `exclude ${c.name}`, over: `use ${c.name}` }], provisional: true },
      origin: "deterministic",
      confidence: "high",
      limitations: [],
      prompt: `You named ${c.name} and also asked never to use it. Should I use it?`,
    });
  }
}

// ---------- 2. identity ----------

function identity(f: IdentityFact): Uncertainty {
  const from = f.expectedCountry ? ` from ${f.expectedCountry}` : "";
  return {
    id: `identity:${f.slot}:${f.name.toLowerCase()}`,
    reason: "entity_identity",
    what: `Qloo's only "${f.name}" doesn't match the one the brief means${from}.`,
    sourcePhrases: [f.name],
    affectedSlots: [f.slot],
    interpretations: [
      { label: `${f.name}${from}`, consequence: "Kept as the user's choice and flagged: Qloo can't measure it.", patches: [{ kind: "identity", slot: f.slot, name: f.name, meaning: "as_described_by_user", country: f.expectedCountry }] },
      { label: `${f.name}: ${f.qlooDescription}`, consequence: "Measured as the entity Qloo knows.", patches: [{ kind: "identity", slot: f.slot, name: f.name, meaning: "qloo_match" }] },
    ],
    multi: false,
    effects: effects({ identity: true }),
    // Never silently pick a namesake: delegating keeps it unresolved and flagged.
    safeDefault: { assumption: `"${f.name}" stays unresolved and flagged for a person: it isn't measured as Qloo's namesake.`, patches: [{ kind: "identity", slot: f.slot, name: f.name, meaning: "unresolved" }], provisional: true },
    origin: "deterministic",
    confidence: "high",
    limitations: ["The expected country comes from the brief or the model's reading of it."],
    prompt: `Which ${f.name} do you mean?`,
  };
}

// ---------- 3. choice strength ----------

function choiceStrength(brief: LaunchBrief, text: string, out: Findings) {
  for (const c of brief.existingChoices) {
    const locked = brief.constraints.some((x) => x.kind === "hard" && x.lockSlot === c.slot);
    const at = text.toLowerCase().indexOf(c.name.toLowerCase());
    // Without the user's own words, the structured brief's lock state is the answer.
    if (locked || at < 0) continue;
    const before = window(text, at, 80, 0);
    const near = window(text, at, 80, c.name.length + 40);
    const cite = near.trim();
    const settle = (strength: "locked" | "considered" | "example", because: string) => out.resolutions.push({ patches: [{ kind: "choice_strength", slot: c.slot, name: c.name, strength }], because, sourcePhrase: cite });
    if (EXAMPLE.test(before)) settle("example", `"${before.match(EXAMPLE)![0]}" makes ${c.name} an example, not a choice.`);
    else if (FIRM.test(near) && !TENTATIVE.test(before)) settle("locked", `"${near.match(FIRM)![0]}" fixes ${c.name}.`);
    else if (TENTATIVE.test(before)) settle("considered", `"${before.match(TENTATIVE)![0]}" makes ${c.name} a choice under consideration.`);
    else
      out.uncertainties.push({
        id: `strength:${c.slot}`,
        reason: "choice_strength",
        what: `The brief names ${c.name} without saying whether it is fixed or open to alternatives.`,
        sourcePhrases: [cite],
        affectedSlots: [c.slot],
        interpretations: [
          { label: `${c.name} is fixed`, consequence: "Locked in every plan.", patches: [{ kind: "choice_strength", slot: c.slot, name: c.name, strength: "locked" }] },
          { label: `Preferred, but open to better options`, consequence: "Kept unless another plan is clearly stronger.", patches: [{ kind: "choice_strength", slot: c.slot, name: c.name, strength: "preferred" }] },
          { label: "Just an idea; explore alternatives", consequence: "One candidate among others.", patches: [{ kind: "choice_strength", slot: c.slot, name: c.name, strength: "considered" }] },
        ],
        multi: false,
        effects: effects({ constraintState: true }),
        safeDefault: { assumption: `${c.name} is treated as preferred, not fixed; a plan that replaces it says why.`, patches: [{ kind: "choice_strength", slot: c.slot, name: c.name, strength: "preferred" }], provisional: false },
        origin: "deterministic",
        confidence: "medium",
        limitations: [],
        prompt: `Is ${c.name} fixed, or open to alternatives?`,
      });
  }
}

// ---------- 4. geography ----------

function geography(k: IntentContract, text: string, market: Market, out: Findings) {
  const hood = k.neighborhoods[0];
  if (!hood || out.uncertainties.some((u) => u.id === "conflict:neighbourhood-vs-anywhere")) return;
  const at = text.toLowerCase().indexOf(hood.value.toLowerCase());
  const before = at >= 0 ? window(text, at, 40, 0) : hood.phrase;
  const cite = at >= 0 ? window(text, at, 40, hood.value.length).trim() : hood.phrase;
  const patch = (strictness: "required" | "nearby" | "city"): BriefPatch[] => [{ kind: "geography", place: hood.value, strictness }];
  if (REQUIRED.test(before)) out.resolutions.push({ patches: patch("required"), because: `"${before.match(REQUIRED)![0]}" makes ${hood.value} required.`, sourcePhrase: cite });
  else if (NEARBY.test(before) || NEARBY.test(hood.phrase)) out.resolutions.push({ patches: patch("nearby"), because: `"${(before.match(NEARBY) ?? hood.phrase.match(NEARBY))![0]}" makes ${hood.value} a centre, not a boundary.`, sourcePhrase: cite });
  else
    out.uncertainties.push({
      id: `geography:${hood.value.toLowerCase()}`,
      reason: "geography",
      what: `The brief places the launch in ${hood.value} without saying how strict that is.`,
      sourcePhrases: [cite],
      affectedSlots: ["event_place"],
      interpretations: [
        { label: `It must be in ${hood.value}`, consequence: "Venues outside it aren't eligible.", patches: patch("required") },
        { label: "Nearby is acceptable", consequence: "Venues close to it are eligible; it is preferred.", patches: patch("nearby") },
        { label: `Anywhere in ${market.label} is acceptable`, consequence: "Any venue in the city is eligible.", patches: patch("city") },
      ],
      multi: false,
      effects: effects({ eligibility: true }),
      safeDefault: { assumption: `${hood.value} is treated as preferred, not mandatory; a venue elsewhere is flagged if it wins.`, patches: patch("nearby"), provisional: false },
      origin: "deterministic",
      confidence: "medium",
      limitations: [],
      prompt: `How strict is the ${hood.value} location?`,
    });
}

// ---------- 5. event format ----------

function eventFormat(brief: LaunchBrief, k: IntentContract, out: Findings) {
  // A named venue or any stated format settles which places can do the job.
  if (k.formats.length || brief.existingChoices.some((c) => c.slot === "event_place")) return;
  out.uncertainties.push({
    id: "event-format",
    reason: "event_format",
    what: "The brief doesn't say what kind of event the launch is, which decides what kind of venue can host it.",
    sourcePhrases: [brief.launchGoal],
    affectedSlots: ["event_place"],
    interpretations: [
      { label: "A retail pop-up", consequence: "Pop-up and retail-friendly spaces.", patches: [{ kind: "event_format", format: "pop_up" }] },
      { label: "A gallery or exhibition", consequence: "Galleries and exhibition spaces.", patches: [{ kind: "event_format", format: "exhibition" }] },
      { label: "A performance or night out", consequence: "Music and nightlife venues.", patches: [{ kind: "event_format", format: "live_music" }] },
      { label: "A dinner or tasting", consequence: "Food and drink venues.", patches: [{ kind: "event_format", format: "food_and_drink" }] },
    ],
    multi: false,
    effects: effects({ eventRole: true, eligibility: true }),
    safeDefault: { assumption: "The launch is treated as a pop-up event; general event spaces are eligible.", patches: [{ kind: "event_format", format: "pop_up" }], provisional: false },
    origin: "deterministic",
    confidence: "medium",
    limitations: [],
    prompt: "What kind of launch event is it?",
  });
}
