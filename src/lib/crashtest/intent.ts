import { unverifiableRules } from "./constraints";
import type { Market } from "@/lib/markets";
import type { LaunchBrief, Slot } from "./types";

/**
 * The brief-intent contract: a deterministic, versioned reading of the already-parsed brief that
 * every screen and explanation uses. It is not an agent and calls no model. Every item cites the
 * brief field and the exact phrase it came from; nothing is inferred from world knowledge, and a
 * quality the brief doesn't state is simply absent.
 */
export const CONTRACT_VERSION = "contract:v2";

export type BriefField = "sourceText" | "launchGoal" | "audienceDescription" | "productCategory" | "brandAttributes" | "existingChoices" | "constraints" | "audienceAnchors" | "budgetBand" | "marketId";

export interface Cited<T = string> {
  value: T;
  field: BriefField;
  /** The exact words in that field. */
  phrase: string;
}

export const EVENT_FORMATS = [
  "pop_up",
  "showroom",
  "exhibition",
  "listening_party",
  "party",
  "festival",
  "store_opening",
  "screening",
  "workshop",
  "live_music",
  "food_and_drink",
  "bar",
  "community",
  "product_drop",
] as const;
export type EventFormat = (typeof EVENT_FORMATS)[number];

export interface IntentContract {
  version: string;
  city: Cited;
  neighborhoods: Cited[];
  /** Places the brief only puts something "in" or "on": neighbourhoods once Qloo confirms them as localities of this city (contract:v2). */
  placeMentions?: Cited[];
  anchors: { names: string[]; source: "user" | "model_hypothesis" | "none" };
  product: Cited;
  attributes: Cited[];
  formats: Cited<EventFormat>[];
  choices: { slot: Slot; name: string; strength: "locked" | "preferred" | "considered"; cite: Cited }[];
  positive: Cited[];
  negative: Cited[];
  unverifiable: Cited[];
  /** The brief asks for independent, local or non-generic character (cited in positive/negative). */
  wantsDistinctive: boolean;
}

const FORMAT_PATTERNS: [EventFormat, RegExp][] = [
  ["pop_up", /\bpop[- ]?ups?\b/i],
  ["showroom", /\bshowrooms?\b/i],
  ["exhibition", /\b(exhibitions?|galler(y|ies)|installations?)\b/i],
  ["listening_party", /\blistening[- ](party|parties|session|sessions)\b/i],
  ["party", /\b(launch (party|night|evening)|parties|party)\b/i],
  ["festival", /\bfestivals?\b/i],
  ["store_opening", /\b(store|shop|flagship)[- ]opening|opening (party|night)\b/i],
  ["screening", /\bscreenings?\b/i],
  ["workshop", /\b(workshops?|customi[sz]ation|screen printing|restoration|styling experience|product trials?|sampling)\b/i],
  ["live_music", /\b(live (performance|music|set)|performance|music session|concert|gig|dj set)\b/i],
  ["food_and_drink", /\b(menu|tasting|dinner|food collaboration|cocktails?|drinks)\b/i],
  ["bar", /\b(speakeasy|cocktail bar|bar)\b/i],
  ["community", /\b(community (activity|event)|gathering|meet[- ]?up|run club)\b/i],
  ["product_drop", /\b(drop|capsule|limited edition)\b/i],
];

/** Qualities a brief can ask for; matched as whole words in its own text. */
const POSITIVE = [
  "independent",
  "intimate",
  "experimental",
  "local",
  "understated",
  "underground",
  "authentic",
  "craftsmanship",
  "craft",
  "sophisticated",
  "minimalist",
  "minimal",
  "sustainable",
  "community",
  "emerging",
  "distinctive",
  "refined",
  "contemporary",
  "genuine",
  "exclusive",
  "creative",
];
/** Qualities that ask for distinctiveness when the brief wants them. */
const DISTINCTIVE = new Set(["independent", "local", "underground", "distinctive", "authentic", "emerging", "genuine", "experimental"]);
/** Words inside a negative phrase that ask for distinctiveness ("not another generic …"). */
const NOT_GENERIC = /\b(generic|mainstream|celebrity|usual|conventional|corporate|touristy|another|typical|cliché|cliche|anywhere)\b/i;
const NEGATOR = /\b(?:not|rather than|instead of|without|avoid(?:ing)?|never|no)\s+/gi;
const TENTATIVE = /\b(consider(?:ing)?|possibly|potentially|hoping|hope to|might|maybe|perhaps|could)\b/i;

function fieldsOf(b: LaunchBrief): [BriefField, string][] {
  return [
    ["sourceText", b.sourceText ?? ""],
    ["launchGoal", b.launchGoal],
    ["audienceDescription", b.audienceDescription],
    ["productCategory", b.productCategory],
    ["brandAttributes", b.brandAttributes.join(", ")],
    ...b.constraints.map((c): [BriefField, string] => ["constraints", c.description]),
  ];
}

/** The text around a match, trimmed to whole words, so the citation is the brief's own phrase. */
const around = (text: string, index: number, length: number) => text.slice(index, index + length).trim();

export function compileIntent(brief: LaunchBrief, market: Market, anchors: IntentContract["anchors"]): IntentContract {
  const fields = fieldsOf(brief).filter(([, t]) => t.trim());
  const cite = <T>(value: T, field: BriefField, phrase: string): Cited<T> => ({ value, field, phrase });

  // Neighbourhoods: the market's known districts, and capitalised places the brief puts the launch in.
  const neighborhoods: Cited[] = [];
  const placeMentions: Cited[] = [];
  const seen = new Set<string>();
  const notPlaces = new Set([market.label, market.qlooLocation, market.country, ...brief.existingChoices.map((c) => c.name), brief.brandName ?? ""].map((s) => s.toLowerCase()));
  for (const [field, text] of fields) {
    for (const alias of market.locationAliases ?? []) {
      const i = text.toLowerCase().indexOf(alias.toLowerCase());
      if (i >= 0 && !seen.has(alias.toLowerCase())) {
        seen.add(alias.toLowerCase());
        neighborhoods.push(cite(alias, field, around(text, i, alias.length)));
      }
    }
    for (const m of text.matchAll(/\b(?:in|around|on|near)\s+(?:the\s+)?((?:\p{Lu}[\p{L}'-]+)(?:\s+\p{Lu}[\p{L}'-]+){0,2})(\s+neighbou?rhood)?/gu)) {
      const place = m[1];
      if (notPlaces.has(place.toLowerCase()) || seen.has(place.toLowerCase())) continue;
      // Only a place word the brief itself marks as a location: "the Juárez neighborhood", or "around Bondi".
      // A bare "in Bushwick" or "on Brick Lane" is one only once Qloo confirms it (confirmNeighborhoods).
      seen.add(place.toLowerCase());
      if (!m[2] && !/^(around|near)\b/i.test(m[0]) && !(market.locationAliases ?? []).some((a) => a.toLowerCase() === place.toLowerCase()))
        placeMentions.push(cite(place, field, m[0].trim()));
      else neighborhoods.push(cite(place, field, m[0].trim()));
    }
  }

  // A format named only to reject it ("rather than … throwing a party") isn't wanted.
  const formats: Cited<EventFormat>[] = [];
  for (const [format, re] of FORMAT_PATTERNS)
    for (const [field, text] of fields) {
      const m = [...text.matchAll(new RegExp(re.source, "gi"))].find((x) => !isNegated(text, x.index!));
      if (m && !formats.some((f) => f.value === format)) formats.push(cite(format, field, m[0]));
    }

  const positive: Cited[] = [];
  for (const q of POSITIVE)
    for (const [field, text] of fields) {
      const m = text.match(new RegExp(`\\b${q}\\b`, "i"));
      // A quality inside a negative phrase ("not generic") is not asked for.
      if (m && !positive.some((p) => p.value === q || (q === "craft" && p.value === "craftsmanship") || (q === "minimal" && p.value === "minimalist")) && !isNegated(text, m.index!)) {
        positive.push(cite(q, field, m[0]));
        break;
      }
    }

  // Each negator starts a phrase that runs to the next negator or punctuation, at most ten words:
  // "not mainstream and not generic" is two avoidances.
  const negative: Cited[] = [];
  for (const [field, text] of fields) {
    const starts = [...text.matchAll(NEGATOR)];
    starts.forEach((m, i) => {
      const from = m.index! + m[0].length;
      const to = Math.min(starts[i + 1]?.index ?? text.length, ...[...text.slice(from).matchAll(/[.,;:!?]/g)].slice(0, 1).map((p) => from + p.index!));
      const object = text.slice(from, to).trim().replace(/\s+(and|or|but)$/i, "").split(/\s+/).slice(0, 10).join(" ");
      if (!object || /^(more|longer)\b/i.test(object)) return;
      // The same avoidance can appear in several fields; cite it once, from the fullest field.
      if (negative.some((n) => n.value.toLowerCase().startsWith(object.toLowerCase().slice(0, 24)))) return;
      negative.push(cite(object, field, text.slice(m.index!, from + text.slice(from, to).indexOf(object) + object.length).trim()));
    });
  }

  const choices = brief.existingChoices.map((c) => {
    const locked = brief.constraints.some((k) => k.kind === "hard" && k.lockSlot === c.slot);
    const src = brief.sourceText ?? "";
    const at = src.toLowerCase().indexOf(c.name.toLowerCase());
    const before = at >= 0 ? src.slice(Math.max(0, at - 60), at) : "";
    const strength: "locked" | "preferred" | "considered" = locked ? "locked" : TENTATIVE.test(before) ? "considered" : "preferred";
    return {
      slot: c.slot,
      name: c.name,
      strength,
      cite: at >= 0 ? cite(c.name, "sourceText" as BriefField, src.slice(Math.max(0, at - 40), at + c.name.length).trim()) : cite(c.name, "existingChoices" as BriefField, c.name),
    };
  });

  const unverifiable: Cited[] = [
    ...unverifiableRules(brief.constraints).map((r) => cite(r, "constraints", r)),
    ...(brief.budgetBand ? [cite(`Budget fit: ${brief.budgetBand}`, "budgetBand", brief.budgetBand)] : []),
  ];

  return {
    version: CONTRACT_VERSION,
    city: cite(market.label, "marketId", brief.marketId),
    neighborhoods,
    placeMentions,
    anchors,
    product: cite(brief.productCategory, "productCategory", brief.productCategory),
    attributes: brief.brandAttributes.map((a) => cite(a, "brandAttributes", a)),
    formats,
    choices,
    positive,
    negative,
    unverifiable,
    wantsDistinctive: positive.some((p) => DISTINCTIVE.has(p.value)) || negative.some((n) => NOT_GENERIC.test(n.phrase)),
  };
}

/** Is the word at `index` inside a "not …" / "without …" phrase? */
function isNegated(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 50), index);
  return /\b(not|rather than|instead of|without|avoid(?:ing)?|never|no)\b[^.,;:!?]*$/i.test(before);
}

/** True when the contract asks for a format among these. */
export const wantsFormat = (c: IntentContract, ...f: EventFormat[]) => c.formats.some((x) => f.includes(x.value));
