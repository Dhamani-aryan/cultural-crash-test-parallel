import type { BriefPatch, ClarificationReason, IdentityFact } from "../src/lib/clarify/types";
import type { LaunchBriefInput } from "../src/lib/crashtest/types";

/**
 * P2.1 regression fixtures: clarification is rare. Frozen before the P2.1 implementation changed.
 * The gate may ask only about entity identity, directly contradictory hard instructions, or an
 * explicitly mandatory rule whose meaning has two mutually exclusive readings with no conservative
 * reading. Strategic, cultural or aesthetic tensions are the agent's work, never a question.
 *
 * REVIEW STATUS: draft, awaiting human review (see tests/clarify/p21-regression.test.ts).
 */

/** The Morrow brief, exactly as the user wrote it (the run that exposed the over-asking). */
export const MORROW =
  "We’re launching Morrow, a new sustainable streetwear label, in London. The brand is understated, experimental and community-led. We want to reach design students, young creatives and people who shop from independent fashion labels. Our current plan is a one-night pop-up at Village Underground, with Central Cee as the music act, a collaboration with Burberry, and a polished black-and-chrome gallery-style creative direction. Our goal is to build cultural credibility in London and introduce our first collection.";

export const MORROW_BRIEF: LaunchBriefInput = {
  brandName: "Morrow",
  productCategory: "Sustainable streetwear",
  launchGoal: "One-night pop-up to introduce the first collection",
  marketId: "london",
  audienceDescription: "Design students, young creatives and people who shop from independent fashion labels",
  brandAttributes: ["understated", "experimental", "community-led"],
  sourceText: MORROW,
  existingChoices: [
    { slot: "event_place", name: "Village Underground" },
    { slot: "artist_music", name: "Central Cee" },
    { slot: "brand_collaboration", name: "Burberry" },
    { slot: "creative_direction", name: "polished black-and-chrome gallery-style" },
  ],
  depth: "quick",
};

/** A scripted model proposal; the strict rule-meaning fields are optional (absent = not shown). */
export type P21Proposal = {
  reason: ClarificationReason;
  what: string;
  sourcePhrases: string[];
  affectedSlots: ("artist_music" | "brand_collaboration" | "event_place" | "creative_direction")[];
  interpretations: { label: string; consequence: string }[];
  multi: boolean;
  changesEligibility: boolean;
  changesConstraint: boolean;
  changesEventRole: boolean;
  identityRisk: boolean;
  safeDefault: string;
  prompt: string;
  /** The cited phrase is an explicitly mandatory rule. */
  ruleIsMandatory?: boolean;
  /** The readings exclude each other. */
  mutuallyExclusive?: boolean;
  /** A reading that conservatively preserves the rule under every interpretation; "" when none. */
  conservativeReading?: string;
};

export interface P21Fixture {
  id: string;
  note: string;
  brief: LaunchBriefInput;
  identities?: IdentityFact[];
  proposals: P21Proposal[];
  expect: {
    questions: number;
    reasons?: ClarificationReason[];
    /** Resolutions applied without asking (each must be present). */
    resolutions?: BriefPatch[];
    /** Strengths that must NOT be applied to these names. */
    notStrength?: { name: string; strength: "locked" | "preferred" | "considered" | "example" }[];
  };
}

const base = { productCategory: "Streetwear", launchGoal: "Pop-up launch", audienceDescription: "Young creatives in London", marketId: "london", depth: "quick" as const };
const p = (x: Partial<P21Proposal> & Pick<P21Proposal, "reason" | "what" | "sourcePhrases" | "prompt">): P21Proposal => ({
  affectedSlots: [],
  interpretations: [
    { label: "The first reading", consequence: "" },
    { label: "The second reading", consequence: "" },
  ],
  multi: false,
  changesEligibility: true,
  changesConstraint: true,
  changesEventRole: false,
  identityRisk: false,
  safeDefault: "Proceed with the brief as written.",
  ...x,
});
const preferred = (slot: "artist_music" | "brand_collaboration" | "event_place" | "creative_direction", name: string): BriefPatch => ({ kind: "choice_strength", slot, name, strength: "preferred" });

export const P21_FIXTURES: P21Fixture[] = [
  {
    id: "morrow-full-brief",
    note: "The full Morrow brief: zero questions, four preferred choices, even when the model proposes the two questions it once asked.",
    brief: MORROW_BRIEF,
    proposals: [
      p({
        reason: "conflict",
        what: "The understated, experimental brand identity and the polished black-and-chrome direction pull in different directions.",
        sourcePhrases: ["The brand is understated, experimental and community-led", "a polished black-and-chrome gallery-style creative direction"],
        affectedSlots: ["creative_direction"],
        interpretations: [
          { label: "Keep the brand identity first", consequence: "" },
          { label: "Keep the proposed creative direction", consequence: "" },
        ],
        prompt: "Should the brand identity or the proposed creative direction win?",
      }),
      p({
        reason: "choice_strength",
        what: "Whether Village Underground is fixed.",
        sourcePhrases: ["a one-night pop-up at Village Underground"],
        affectedSlots: ["event_place"],
        prompt: "Is Village Underground fixed, or open to alternatives?",
      }),
    ],
    expect: {
      questions: 0,
      resolutions: [
        preferred("event_place", "Village Underground"),
        preferred("artist_music", "Central Cee"),
        preferred("brand_collaboration", "Burberry"),
        preferred("creative_direction", "polished black-and-chrome gallery-style"),
      ],
      notStrength: ["Village Underground", "Central Cee", "Burberry", "polished black-and-chrome gallery-style"].map((name) => ({ name, strength: "locked" as const })),
    },
  },
  {
    id: "brand-creative-tension",
    note: "An understated brand with a polished chrome direction is a tension for the agent to test, not a question.",
    brief: {
      ...base,
      brandAttributes: ["understated"],
      sourceText: "Our brand is understated. We want a polished chrome creative direction for the pop-up.",
      existingChoices: [{ slot: "creative_direction", name: "polished chrome" }],
    },
    proposals: [
      p({
        reason: "tradeoff",
        what: "Understated versus polished chrome.",
        sourcePhrases: ["Our brand is understated", "polished chrome creative direction"],
        affectedSlots: ["creative_direction"],
        prompt: "Do you prefer staying understated or the polished chrome look?",
      }),
    ],
    expect: { questions: 0, resolutions: [preferred("creative_direction", "polished chrome")] },
  },
  {
    id: "ordinary-venue",
    note: "'Our plan is' names a preference: preferred, no question.",
    brief: { ...base, sourceText: "Our plan is Village Underground for the pop-up.", existingChoices: [{ slot: "event_place", name: "Village Underground" }] },
    proposals: [],
    expect: { questions: 0, resolutions: [preferred("event_place", "Village Underground")] },
  },
  {
    id: "locked-venue",
    note: "'Booked' locks, without a question.",
    brief: { ...base, sourceText: "Village Underground is booked for the pop-up.", existingChoices: [{ slot: "event_place", name: "Village Underground" }] },
    proposals: [],
    expect: { questions: 0, resolutions: [{ kind: "choice_strength", slot: "event_place", name: "Village Underground", strength: "locked" }] },
  },
  {
    id: "tentative-venue",
    note: "'Considering' makes it considered, without a question.",
    brief: { ...base, sourceText: "We are considering Village Underground for the pop-up.", existingChoices: [{ slot: "event_place", name: "Village Underground" }] },
    proposals: [],
    expect: { questions: 0, resolutions: [{ kind: "choice_strength", slot: "event_place", name: "Village Underground", strength: "considered" }] },
  },
  {
    id: "namesake",
    note: "An ambiguous identity still asks one question.",
    brief: { ...base, sourceText: "Our plan is a pop-up with a set from Saffron Ray.", existingChoices: [{ slot: "artist_music", name: "Saffron Ray" }] },
    identities: [{ slot: "artist_music", name: "Saffron Ray", expectedCountry: "India", qlooDescription: "American country singer." }],
    proposals: [],
    expect: { questions: 1, reasons: ["entity_identity"] },
  },
  {
    id: "named-and-excluded",
    note: "A choice that is named and explicitly excluded still asks one question.",
    brief: {
      ...base,
      sourceText: "We plan to collaborate with Burberry. Never use Burberry.",
      existingChoices: [{ slot: "brand_collaboration", name: "Burberry" }],
      constraints: [{ id: "x", description: "Never use Burberry", kind: "hard", excludeNames: ["Burberry"] }],
    },
    proposals: [],
    expect: { questions: 1, reasons: ["conflict"] },
  },
  {
    id: "operational-uncertainty",
    note: "Unknown capacity or availability never blocks preflight, and 'haven't confirmed' is not a lock.",
    brief: {
      ...base,
      sourceText: "Our plan is a pop-up at Village Underground. We haven't confirmed capacity or availability yet.",
      existingChoices: [{ slot: "event_place", name: "Village Underground" }],
    },
    proposals: [
      p({
        reason: "rule_meaning",
        what: "Venue capacity is unknown.",
        sourcePhrases: ["We haven't confirmed capacity or availability yet"],
        affectedSlots: ["event_place"],
        prompt: "What capacity and dates do you need at the venue?",
        ruleIsMandatory: true,
        mutuallyExclusive: true,
        conservativeReading: "",
      }),
    ],
    expect: { questions: 0, resolutions: [preferred("event_place", "Village Underground")], notStrength: [{ name: "Village Underground", strength: "locked" }] },
  },
  {
    id: "strategic-fit-conflict",
    note: "A model-proposed strategic-fit conflict is dropped by code.",
    brief: { ...base, brandAttributes: ["understated"], sourceText: "Our plan is a pop-up with Central Cee performing. The brand is understated.", existingChoices: [{ slot: "artist_music", name: "Central Cee" }] },
    proposals: [
      p({
        reason: "conflict",
        what: "Central Cee may be too mainstream for an understated brand.",
        sourcePhrases: ["a pop-up with Central Cee performing", "The brand is understated"],
        affectedSlots: ["artist_music"],
        interpretations: [
          { label: "Keep Central Cee", consequence: "" },
          { label: "Look for a smaller act", consequence: "" },
        ],
        prompt: "Central Cee may feel too mainstream for an understated brand. Keep him or look for a smaller act?",
      }),
    ],
    expect: { questions: 0, resolutions: [preferred("artist_music", "Central Cee")] },
  },
  {
    id: "strict-rule-meaning-admitted",
    note: "An explicitly mandatory rule with two mutually exclusive readings and no conservative reading is asked.",
    brief: {
      ...base,
      sourceText: "Only partners from the collective may be used.",
      constraints: [{ id: "r", description: "Only partners from the collective may be used", kind: "hard" }],
    },
    proposals: [
      p({
        reason: "rule_meaning",
        what: "Which collective the rule means.",
        sourcePhrases: ["Only partners from the collective may be used"],
        affectedSlots: ["brand_collaboration"],
        interpretations: [
          { label: "Members of the Hackney Wick collective", consequence: "" },
          { label: "Members of the Peckham collective", consequence: "" },
        ],
        safeDefault: "The rule is kept, and a person confirms which collective it means.",
        prompt: "Which collective does the partner rule mean?",
        ruleIsMandatory: true,
        mutuallyExclusive: true,
        conservativeReading: "",
      }),
    ],
    expect: { questions: 1, reasons: ["rule_meaning"] },
  },
  {
    id: "rule-with-conservative-reading",
    note: "A mandatory rule that a conservative reading preserves is not asked.",
    brief: {
      ...base,
      sourceText: "No fast fashion partners.",
      constraints: [{ id: "r", description: "No fast fashion partners", kind: "hard" }],
    },
    proposals: [
      p({
        reason: "rule_meaning",
        what: "Whether 'fast fashion' covers high-street labels with sustainable lines.",
        sourcePhrases: ["No fast fashion partners"],
        affectedSlots: ["brand_collaboration"],
        prompt: "Does 'no fast fashion' rule out every high-street label?",
        ruleIsMandatory: true,
        mutuallyExclusive: true,
        conservativeReading: "Exclude every high-street label",
      }),
    ],
    expect: { questions: 0 },
  },
  {
    id: "rule-not-mandatory",
    note: "A preference, not a mandatory rule, is never asked as a rule question.",
    brief: { ...base, sourceText: "We'd prefer partners with a sustainability story." },
    proposals: [
      p({
        reason: "rule_meaning",
        what: "What counts as a sustainability story.",
        sourcePhrases: ["We'd prefer partners with a sustainability story"],
        affectedSlots: ["brand_collaboration"],
        prompt: "What counts as a sustainability story?",
        ruleIsMandatory: false,
        mutuallyExclusive: true,
        conservativeReading: "",
      }),
    ],
    expect: { questions: 0 },
  },
];
