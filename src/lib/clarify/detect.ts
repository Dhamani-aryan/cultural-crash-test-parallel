import { compileIntent, type IntentContract } from "@/lib/crashtest/intent";
import { SLOT_LABEL, type LaunchBrief, type Slot } from "@/lib/crashtest/types";
import type { Market } from "@/lib/markets";
import type { BriefPatch, Effects, IdentityFact, Resolution, Uncertainty } from "./types";

/**
 * Deterministic materiality checks. Each reads only the parsed brief, its intent contract and the
 * identity facts preflight gathered; none reads Qloo affinity, evidence strength or candidates.
 *
 * P2.1: clarification is rare. The brief is the user's current plan, not a permissions form, so
 * wording settles almost everything without asking: "booked" locks, "considering" makes a choice
 * considered, and an ordinary named choice is preferred. A tension between choices (a headline act
 * and "not celebrity-led", a booked venue and "a better one if you can") is recorded for the
 * comparison to test, never asked. Only an ambiguous identity, or two explicit instructions that
 * directly contradict each other, become questions.
 */

const NONE: Effects = { eligibility: false, constraintState: false, eventRole: false, winnerOrder: false, identity: false };
const effects = (e: Partial<Effects>): Effects => ({ ...NONE, ...e });

/** Firm wording: the choice is fixed. */
const FIRM = /\b(must|booked|confirmed|already (?:booked|confirmed|secured|signed|agreed)|keep(?:ing)?|locked|fixed|non-negotiable|signed|secured|have to|has to|cannot change|can't change)\b/i;
/** Firm wording negated ("haven't confirmed", "not booked yet") is not a lock. */
const NEGATED_FIRM = /\b(?:not|no|never|haven'?t|hasn'?t|isn'?t|aren'?t|wasn'?t|without|yet to|not yet|un)\s*(?:been\s+|yet\s+)?$/i;
/** Tentative wording: the choice is only being considered. */
const TENTATIVE = /\b(consider(?:ing)?|possibly|potentially|hoping|hope to|might|maybe|perhaps|could|exploring|thinking (?:of|about)|open to (?:other|alternatives)|would love|ideally)\b/i;
/** Example wording: the name illustrates a kind, it isn't a choice. */
const EXAMPLE = /\b(for example|e\.g\.|such as|something like|someone like|a brand like|an artist like|an example)\b/i;
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
const sentenceBounds = (text: string, at: number) => {
  const start = Math.max(text.lastIndexOf(".", at - 1), text.lastIndexOf("!", at - 1), text.lastIndexOf("?", at - 1)) + 1;
  const ends = [".", "!", "?"].map((p) => text.indexOf(p, at)).filter((i) => i >= 0);
  return [start, ends.length ? Math.min(...ends) + 1 : text.length] as const;
};
const sentenceOf = (text: string, at: number) => {
  const [s, e] = sentenceBounds(text, at);
  return text.slice(s, e).trim();
};
const negated = (s: string) => /\b(not|no|never|without|rather than|instead of|avoid\w*|don't|do not)\b/i.test(s);

/** A firm word about this choice: in its own sentence, and not negated. */
function firmWord(text: string, at: number, length: number): string | null {
  const [s, e] = sentenceBounds(text, at);
  const near = text.slice(Math.max(s, at - 80), Math.min(e, at + length + 40));
  for (const m of near.matchAll(new RegExp(FIRM.source, "gi"))) if (!NEGATED_FIRM.test(near.slice(0, m.index))) return m[0];
  return null;
}

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
  geography(k, text, out);
  eventFormat(brief, k, out);
  // A slot whose conflict is asked, or already settled, needs no strength resolution of its own.
  const settled = new Set([
    ...out.uncertainties.filter((u) => u.reason === "conflict").flatMap((u) => u.affectedSlots),
    ...out.resolutions.filter((r) => r.because.startsWith("Booked and")).flatMap((r) => r.patches.flatMap((p) => (p.kind === "choice_strength" ? [p.slot] : []))),
  ]);
  out.resolutions = out.resolutions.filter((r) => r.because.startsWith("Booked and") || !r.patches.some((p) => p.kind === "choice_strength" && settled.has(p.slot)));
  return out;
}

const note = (text: string): BriefPatch => ({ kind: "assumption", text });

// ---------- 1. conflicts ----------

function conflicts(brief: LaunchBrief, k: IntentContract, text: string, out: Findings) {
  // A booked choice and a request for a better one: the explicit lock stands, and the comparison
  // still shows the alternatives. Not a contradiction between two hard instructions.
  for (const c of brief.existingChoices) {
    const at = text.toLowerCase().indexOf(c.name.toLowerCase());
    if (at < 0) continue;
    const firm = firmWord(text, at, c.name.length);
    const replace = [...text.matchAll(new RegExp(REPLACE.source, "gi"))].find((m) => SLOT_WORDS[c.slot].test(window(text, m.index!, 0, 60)));
    if (firm && replace)
      out.resolutions.push({
        patches: [
          { kind: "choice_strength", slot: c.slot, name: c.name, strength: "locked" },
          note(`${c.name} stays, because the brief says it is ${firm}; alternatives are compared for reference only.`),
        ],
        because: `Booked and asked to look for better: "${firm}" keeps ${c.name}; the comparison shows alternatives.`,
        sourcePhrase: window(text, at, 40, c.name.length + 40).trim(),
      });
  }

  // A headline act wanted, and the launch not to feel celebrity-led: a tension for the comparison.
  const headline = [...text.matchAll(new RegExp(HEADLINE.source, "gi"))].find((m) => !negated(window(text, m.index!, 40, 0)));
  const avoid = k.negative.find((n) => NOT_DOMINATED.test(n.phrase));
  if (headline && avoid)
    out.resolutions.push({
      patches: [note(`The brief asks for a headline name and for the launch not to feel celebrity-led ("${avoid.phrase}"); the comparison tests that tension.`)],
      because: "A strategic tension the comparison tests, not a question.",
      sourcePhrase: sentenceOf(text, headline.index!),
    });

  // "Must be in X" and "anywhere is fine": two explicit instructions about the same boundary.
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

  // A choice the brief names and also explicitly excludes.
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

// ---------- 3. choice strength: settled by wording, never asked ----------

function choiceStrength(brief: LaunchBrief, text: string, out: Findings) {
  for (const c of brief.existingChoices) {
    const locked = brief.constraints.some((x) => x.kind === "hard" && x.lockSlot === c.slot);
    const at = text.toLowerCase().indexOf(c.name.toLowerCase());
    // Without the user's own words, the structured brief's lock state is the answer.
    if (locked || at < 0) continue;
    const before = window(text, at, 80, 0);
    const cite = window(text, at, 80, c.name.length + 40).trim();
    const settle = (strength: "locked" | "preferred" | "considered" | "example", because: string) =>
      out.resolutions.push({ patches: [{ kind: "choice_strength", slot: c.slot, name: c.name, strength }], because, sourcePhrase: cite });
    const firm = firmWord(text, at, c.name.length);
    if (EXAMPLE.test(before)) settle("example", `"${before.match(EXAMPLE)![0]}" makes ${c.name} an example, not a choice.`);
    else if (firm && !TENTATIVE.test(before)) settle("locked", `"${firm}" fixes ${c.name}.`);
    else if (TENTATIVE.test(before)) settle("considered", `"${before.match(TENTATIVE)![0]}" makes ${c.name} a choice under consideration.`);
    // An ordinary named choice in the user's current plan: preferred, replaceable only with recorded evidence.
    else settle("preferred", `The brief names ${c.name} without lock or tentative wording.`);
  }
}

// ---------- 4. geography: a named neighbourhood is a preference unless the brief says otherwise ----------

function geography(k: IntentContract, text: string, out: Findings) {
  const hood = k.neighborhoods[0];
  if (!hood || out.uncertainties.some((u) => u.id === "conflict:neighbourhood-vs-anywhere")) return;
  const at = text.toLowerCase().indexOf(hood.value.toLowerCase());
  const before = at >= 0 ? window(text, at, 40, 0) : hood.phrase;
  const cite = at >= 0 ? window(text, at, 40, hood.value.length).trim() : hood.phrase;
  const patch = (strictness: "required" | "nearby" | "city"): BriefPatch[] => [{ kind: "geography", place: hood.value, strictness }];
  if (REQUIRED.test(before)) out.resolutions.push({ patches: patch("required"), because: `"${before.match(REQUIRED)![0]}" makes ${hood.value} required.`, sourcePhrase: cite });
  else if (NEARBY.test(before) || NEARBY.test(hood.phrase)) out.resolutions.push({ patches: patch("nearby"), because: `"${(before.match(NEARBY) ?? hood.phrase.match(NEARBY))![0]}" makes ${hood.value} a centre, not a boundary.`, sourcePhrase: cite });
  else out.resolutions.push({ patches: patch("nearby"), because: `The brief places the launch in ${hood.value} without making it mandatory.`, sourcePhrase: cite });
}

// ---------- 5. event format: a missing format is an assumption, not a question ----------

function eventFormat(brief: LaunchBrief, k: IntentContract, out: Findings) {
  if (k.formats.length || brief.existingChoices.some((c) => c.slot === "event_place")) return;
  out.resolutions.push({
    patches: [note("The brief doesn't name an event format, so general event spaces are eligible.")],
    because: "No event format is named; general event spaces stay eligible.",
    sourcePhrase: brief.launchGoal,
  });
}
