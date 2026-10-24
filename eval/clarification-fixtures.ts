import type { BriefPatch, ClarificationReason, GateBudget, IdentityFact } from "../src/lib/clarify/types";
import type { LaunchBriefInput } from "../src/lib/crashtest/types";

/**
 * The frozen clarification fixture set (clarification quality, separate from recommendation
 * quality). Written before any gate output was seen. Names are invented; none is one of the 15
 * evaluation scenarios, so nothing here tunes the recommendation runs.
 *
 * P2.1 revision: clarification is rare. Fixtures that asked about neighbourhood strictness, choice
 * strength, event format or a strategic tension now expect a deterministic resolution instead; the
 * answer, budget and failure fixtures use questions that are still allowed.
 *
 * REVIEW STATUS: draft, awaiting human review. Once reviewed, set REVIEWED_BY and REVIEWED_AT and
 * update the recorded fingerprint in tests/clarify/fixtures.test.ts; any later edit changes it.
 */
export const REVIEWED_BY: string | null = null;
export const REVIEWED_AT: string | null = null;

/** A scripted reply from the clarification model: proposals, or a failed call. */
type Proposal = {
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
  ruleIsMandatory?: boolean;
  mutuallyExclusive?: boolean;
  conservativeReading?: string;
};
export type GeneratorReply = { proposals: Proposal[] } | "fail";

export interface ClarificationFixture {
  id: string;
  kind: "clear" | "ambiguous" | "conflict" | "identity" | "answer" | "delegate" | "generator_failure" | "unnecessary" | "leading" | "budget";
  /** What a reviewer should check, in one line. */
  note: string;
  brief: LaunchBriefInput;
  identities?: IdentityFact[];
  generator: GeneratorReply;
  budget?: GateBudget;
  askedIds?: string[];
  forbiddenNames?: string[];
  expect: {
    decision: "ready" | "clarify";
    /** The question asked this turn has one of these reasons (when clarify). */
    reasons?: ClarificationReason[];
    /** Its id starts with this. */
    questionId?: string;
    /** No asked question may match these. */
    forbidden?: string[];
    /** Patches the brief settles without asking (subset). */
    resolutions?: BriefPatch[];
    /** "Decide for me" applies this assumption (substring) and these patches. */
    delegated?: { assumption: string; patches: BriefPatch[]; provisional: boolean };
    /** Answering with these option numbers (1-based) or text gives these patches. */
    answers?: { options?: number[]; text?: string; patches?: BriefPatch[]; needsInterpretation?: boolean }[];
    /** An assumption recorded without asking (substring). */
    assumption?: string;
    /** Material uncertainties left for a later turn. */
    deferred?: number;
    provisional?: boolean;
  };
}

const base = { productCategory: "Streetwear", launchGoal: "Launch event", audienceDescription: "Young creatives who follow independent fashion", depth: "quick" as const };
const none: GeneratorReply = { proposals: [] };
const proposal = (p: Partial<Proposal> & Pick<Proposal, "reason" | "what" | "sourcePhrases" | "prompt">): Proposal => ({
  affectedSlots: [],
  interpretations: [
    { label: "Yes", consequence: "" },
    { label: "No", consequence: "" },
  ],
  multi: false,
  changesEligibility: false,
  changesConstraint: false,
  changesEventRole: false,
  identityRisk: false,
  safeDefault: "Proceed with the brief as written.",
  ...p,
});

export const FIXTURES: ClarificationFixture[] = [
  // ---------- clear briefs: run without a question ----------
  {
    id: "clear-booked-hoping-around",
    kind: "clear",
    note: "Booked venue, hoped-for act, mandatory partner and 'around SoHo' all settle themselves.",
    brief: {
      ...base,
      marketId: "new-york",
      sourceText: "We have booked Pier Hall for a pop-up around SoHo with live screen printing. The partner brand must be Linden & Co, and we're hoping to get Rae Lune for a short set.",
      existingChoices: [
        { slot: "event_place", name: "Pier Hall" },
        { slot: "brand_collaboration", name: "Linden & Co" },
        { slot: "artist_music", name: "Rae Lune" },
      ],
    },
    generator: none,
    expect: {
      decision: "ready",
      resolutions: [
        { kind: "choice_strength", slot: "event_place", name: "Pier Hall", strength: "locked" },
        { kind: "choice_strength", slot: "brand_collaboration", name: "Linden & Co", strength: "locked" },
        { kind: "choice_strength", slot: "artist_music", name: "Rae Lune", strength: "considered" },
        { kind: "geography", place: "SoHo", strictness: "nearby" },
      ],
    },
  },
  {
    id: "clear-considering",
    kind: "clear",
    note: "'Considering' and 'possibly' make both choices considered; 'around' makes the area a centre.",
    brief: {
      ...base,
      productCategory: "Non-alcoholic spirits",
      marketId: "london",
      sourceText: "We're considering Hollow Yard for a listening party around Dalston, possibly with a set from Kofi Vale.",
      existingChoices: [
        { slot: "event_place", name: "Hollow Yard" },
        { slot: "artist_music", name: "Kofi Vale" },
      ],
    },
    generator: none,
    expect: {
      decision: "ready",
      resolutions: [
        { kind: "choice_strength", slot: "event_place", name: "Hollow Yard", strength: "considered" },
        { kind: "choice_strength", slot: "artist_music", name: "Kofi Vale", strength: "considered" },
        { kind: "geography", place: "Dalston", strictness: "nearby" },
      ],
    },
  },
  {
    id: "clear-no-choices",
    kind: "clear",
    note: "A format, no named choices and no neighbourhood: nothing material is open.",
    brief: { ...base, productCategory: "Skincare", marketId: "london", sourceText: "We're launching a skincare line with a pop-up and a sampling workshop. It should feel independent, not generic." },
    generator: none,
    expect: { decision: "ready" },
  },
  {
    id: "clear-structured-only",
    kind: "clear",
    note: "No free text: the structured brief's lock state is the user's answer.",
    brief: { ...base, marketId: "london", launchGoal: "Pop-up launch", existingChoices: [{ slot: "event_place", name: "Hollow Yard" }] },
    generator: none,
    expect: { decision: "ready" },
  },
  {
    id: "clear-example-name",
    kind: "clear",
    note: "'Someone like' makes the act an example, not a choice.",
    brief: { ...base, marketId: "london", sourceText: "A pop-up with a performance from someone like Kofi Vale.", existingChoices: [{ slot: "artist_music", name: "Kofi Vale" }] },
    generator: none,
    expect: { decision: "ready", resolutions: [{ kind: "choice_strength", slot: "artist_music", name: "Kofi Vale", strength: "example" }] },
  },
  {
    id: "booked-venue-becomes-lock",
    kind: "clear",
    note: "'Already booked' becomes a lock without asking.",
    brief: { ...base, marketId: "london", sourceText: "Our launch venue, The Glass Room, is already booked for a pop-up.", existingChoices: [{ slot: "event_place", name: "The Glass Room" }] },
    generator: none,
    expect: { decision: "ready", resolutions: [{ kind: "choice_strength", slot: "event_place", name: "The Glass Room", strength: "locked" }] },
  },

  // ---------- settled by wording, never asked (P2.1) ----------
  {
    id: "neighbourhood-is-preference",
    kind: "clear",
    note: "A named neighbourhood without 'must' or 'only' is a preference, not a question.",
    brief: { ...base, marketId: "new-york", sourceText: "We're planning a pop-up on the Lower East Side with live screen printing and customisation." },
    generator: none,
    expect: { decision: "ready", resolutions: [{ kind: "geography", place: "Lower East Side", strictness: "nearby" }] },
  },
  {
    id: "ordinary-choice-is-preference",
    kind: "clear",
    note: "A venue named with no firm or tentative wording is preferred, not asked about.",
    brief: { ...base, marketId: "london", sourceText: "We'll launch at Juniper Hall with a DJ set and a pop-up shop.", existingChoices: [{ slot: "event_place", name: "Juniper Hall" }] },
    generator: none,
    expect: { decision: "ready", resolutions: [{ kind: "choice_strength", slot: "event_place", name: "Juniper Hall", strength: "preferred" }] },
  },
  {
    id: "missing-event-format",
    kind: "clear",
    note: "No format and no venue: general event spaces stay eligible, recorded as an assumption.",
    brief: { ...base, productCategory: "Fragrance", launchGoal: "Launch", marketId: "berlin", sourceText: "We're launching a fragrance and want it to feel experimental." },
    generator: none,
    expect: { decision: "ready", resolutions: [{ kind: "assumption", text: "The brief doesn't name an event format, so general event spaces are eligible." }] },
  },
  {
    id: "booked-and-better",
    kind: "clear",
    note: "A booked venue and 'a better one if you can': the lock stands and alternatives are compared, without a question.",
    brief: { ...base, marketId: "london", sourceText: "We've booked Juniper Hall for the pop-up, but please find a better venue if you can.", existingChoices: [{ slot: "event_place", name: "Juniper Hall" }] },
    generator: none,
    expect: { decision: "ready", resolutions: [{ kind: "choice_strength", slot: "event_place", name: "Juniper Hall", strength: "locked" }] },
  },
  {
    id: "headline-vs-celebrity",
    kind: "clear",
    note: "A headline name and 'not celebrity-led' is a tension the comparison tests, not a question.",
    brief: { ...base, marketId: "london", sourceText: "We want a global star to headline the pop-up, but the launch must not feel celebrity-led." },
    generator: none,
    expect: { decision: "ready" },
  },

  // ---------- conflicts: two explicit instructions that contradict ----------
  {
    id: "conflict-area-and-anywhere",
    kind: "answer",
    note: "'Must be in Shoreditch' and 'anywhere is fine': one question; buttons, text and delegation each patch it.",
    brief: { ...base, marketId: "london", sourceText: "The pop-up must be in Shoreditch, though anywhere in London is fine." },
    generator: none,
    expect: {
      decision: "clarify",
      reasons: ["conflict"],
      questionId: "conflict:neighbourhood-vs-anywhere",
      delegated: { assumption: "Shoreditch is preferred, not required", patches: [{ kind: "geography", place: "Shoreditch", strictness: "nearby" }], provisional: true },
      answers: [
        { options: [1], patches: [{ kind: "geography", place: "Shoreditch", strictness: "required" }] },
        { options: [2], patches: [{ kind: "geography", place: "Shoreditch", strictness: "city" }] },
        { text: "Somewhere east would be ideal", needsInterpretation: true },
      ],
    },
  },
  {
    id: "conflict-named-and-excluded",
    kind: "conflict",
    note: "The same brand named and excluded.",
    brief: {
      ...base,
      marketId: "london",
      launchGoal: "Pop-up launch",
      existingChoices: [{ slot: "brand_collaboration", name: "Linden & Co" }],
      constraints: [{ id: "x", description: "Never use Linden & Co", kind: "hard", excludeNames: ["Linden & Co"] }],
    },
    generator: none,
    expect: { decision: "clarify", reasons: ["conflict"], questionId: "conflict:named-and-excluded:brand_collaboration", delegated: { assumption: "excluded", patches: [{ kind: "priority", keep: "exclude Linden & Co", over: "use Linden & Co" }], provisional: true } },
  },

  // ---------- identity ----------
  {
    id: "identity-namesake",
    kind: "identity",
    note: "Qloo's only match is a namesake from another country: ask which one; delegating keeps it unresolved.",
    brief: { ...base, marketId: "mumbai", sourceText: "A pop-up in Mumbai with a performance we're hoping to arrange with Saffron Ray.", existingChoices: [{ slot: "artist_music", name: "Saffron Ray" }] },
    identities: [{ slot: "artist_music", name: "Saffron Ray", expectedCountry: "India", qlooDescription: "American country singer." }],
    generator: none,
    expect: {
      decision: "clarify",
      reasons: ["entity_identity"],
      questionId: "identity:artist_music:saffron ray",
      delegated: { assumption: "stays unresolved", patches: [{ kind: "identity", slot: "artist_music", name: "Saffron Ray", meaning: "unresolved" }], provisional: true },
      answers: [{ options: [1], patches: [{ kind: "identity", slot: "artist_music", name: "Saffron Ray", meaning: "as_described_by_user", country: "India" }] }],
    },
  },

  // ---------- model proposals the code must refuse ----------
  {
    id: "unnecessary-missing-affinity",
    kind: "unnecessary",
    note: "Missing Qloo affinity alone never interrupts intake.",
    brief: { ...base, marketId: "london", sourceText: "A pop-up and a sampling workshop for our new skincare line." },
    generator: { proposals: [proposal({ reason: "rule_meaning", what: "Qloo has no affinity data for this audience.", sourcePhrases: ["sampling workshop"], prompt: "Qloo has no affinity data here. Should we proceed?", changesEligibility: true })] },
    expect: { decision: "ready", forbidden: ["affinity", "Qloo"] },
  },
  {
    id: "unnecessary-capacity",
    kind: "unnecessary",
    note: "Venue capacity stays a result-time human check.",
    brief: { ...base, marketId: "london", sourceText: "A pop-up and a sampling workshop for our new skincare line." },
    generator: { proposals: [proposal({ reason: "event_format", what: "Venue capacity is unknown.", sourcePhrases: ["pop-up"], prompt: "What capacity does the venue need?", changesEventRole: true })] },
    expect: { decision: "ready", forbidden: ["capacity"] },
  },
  {
    id: "unnecessary-demographics",
    kind: "unnecessary",
    note: "Extra demographic detail isn't needed to proceed.",
    brief: { ...base, marketId: "london", sourceText: "A pop-up and a sampling workshop for our new skincare line." },
    generator: { proposals: [proposal({ reason: "rule_meaning", what: "Age range unclear.", sourcePhrases: ["skincare line"], prompt: "What age range and income bracket is the audience?", changesEligibility: true })] },
    expect: { decision: "ready", forbidden: ["age range", "income"] },
  },
  {
    id: "unnecessary-tradeoff-before-plans",
    kind: "unnecessary",
    note: "A trade-off between directions is the comparison's work, never an intake question.",
    brief: { ...base, marketId: "london", sourceText: "A pop-up and a sampling workshop for our new skincare line." },
    generator: { proposals: [proposal({ reason: "tradeoff", what: "Reach versus local specificity.", sourcePhrases: ["pop-up"], prompt: "Do you prefer broad reach or local specificity?" })] },
    expect: { decision: "ready", forbidden: ["reach", "specificity"] },
  },
  {
    id: "leading-candidate-names",
    kind: "leading",
    note: "Naming retrieved candidates, or any brand the brief doesn't name, is refused.",
    brief: { ...base, marketId: "london", sourceText: "We're launching streetwear with a pop-up and want a local brand partner." },
    forbiddenNames: ["Mossgrove", "Fieldnote"],
    generator: {
      proposals: [
        proposal({ reason: "conflict", what: "Which partner?", sourcePhrases: ["a local brand partner"], prompt: "Would you prefer Mossgrove or Fieldnote as the partner?", changesEligibility: true }),
        proposal({ reason: "geography", what: "Partner choice.", sourcePhrases: ["a local brand partner"], prompt: "Should the partner be Brindle Works?", changesEligibility: true }),
      ],
    },
    expect: { decision: "ready", forbidden: ["Mossgrove", "Fieldnote", "Brindle Works"] },
  },
  {
    id: "invented-source-phrase",
    kind: "unnecessary",
    note: "A proposal citing words the brief doesn't contain is refused.",
    brief: { ...base, marketId: "london", sourceText: "A pop-up and a sampling workshop for our new skincare line." },
    generator: { proposals: [proposal({ reason: "rule_meaning", what: "Sustainability rule unclear.", sourcePhrases: ["must be carbon neutral"], prompt: "How strict is the carbon-neutral rule?", changesEligibility: true })] },
    expect: { decision: "ready" },
  },

  // ---------- model proposals: only a strict, mandatory rule meaning is admitted (P2.1) ----------
  {
    id: "model-rule-meaning",
    kind: "ambiguous",
    note: "An explicitly mandatory rule with two mutually exclusive readings and no conservative reading.",
    brief: {
      ...base,
      marketId: "london",
      sourceText: "A pop-up for our streetwear label. Only partners from the collective may be used.",
      constraints: [{ id: "r", description: "Only partners from the collective may be used", kind: "hard" }],
    },
    generator: {
      proposals: [
        proposal({
          reason: "rule_meaning",
          what: "Which collective the rule means.",
          sourcePhrases: ["Only partners from the collective may be used"],
          affectedSlots: ["brand_collaboration"],
          interpretations: [
            { label: "Members of the Hackney Wick collective", consequence: "Only that collective's partners." },
            { label: "Members of the Peckham collective", consequence: "Only that collective's partners." },
          ],
          changesEligibility: true,
          safeDefault: "The rule is kept, and a person confirms which collective it means.",
          prompt: "Which collective does the partner rule mean?",
          ruleIsMandatory: true,
          mutuallyExclusive: true,
          conservativeReading: "",
        }),
      ],
    },
    expect: {
      decision: "clarify",
      reasons: ["rule_meaning"],
      questionId: "model:rule_meaning",
      answers: [{ options: [2], patches: [{ kind: "rule_meaning", rule: "Only partners from the collective may be used", meaning: "Members of the Peckham collective" }] }],
      delegated: { assumption: "a person confirms which collective", patches: [{ kind: "assumption", text: "The rule is kept, and a person confirms which collective it means." }], provisional: true },
    },
  },
  {
    id: "model-rule-conservative",
    kind: "unnecessary",
    note: "A mandatory rule a conservative reading keeps safe is read that way and recorded, not asked.",
    brief: {
      ...base,
      marketId: "london",
      sourceText: "A pop-up for our streetwear label. No fast fashion partners.",
      constraints: [{ id: "r", description: "No fast fashion partners", kind: "hard" }],
    },
    generator: {
      proposals: [
        proposal({
          reason: "rule_meaning",
          what: "Whether 'fast fashion' covers high-street labels with sustainable lines.",
          sourcePhrases: ["No fast fashion partners"],
          affectedSlots: ["brand_collaboration"],
          changesEligibility: true,
          prompt: "Does 'no fast fashion' rule out every high-street label?",
          ruleIsMandatory: true,
          mutuallyExclusive: true,
          conservativeReading: "every high-street label is excluded",
        }),
      ],
    },
    expect: { decision: "ready", assumption: "read conservatively: every high-street label is excluded" },
  },
  {
    id: "model-local-meaning-dropped",
    kind: "unnecessary",
    note: "What 'local' should mean for a partner is the agent's work: dropped, even as checkboxes.",
    brief: { ...base, marketId: "london", sourceText: "We're launching streetwear with a pop-up and want a local brand partner." },
    generator: {
      proposals: [
        proposal({
          reason: "geography",
          what: "What 'local' requires of the partner.",
          sourcePhrases: ["a local brand partner"],
          affectedSlots: ["brand_collaboration"],
          interpretations: [
            { label: "Founded in the city", consequence: "" },
            { label: "Independent rather than global", consequence: "" },
            { label: "Culturally relevant here", consequence: "" },
          ],
          multi: true,
          changesEligibility: true,
          prompt: "Which of these must the partner be? Select any that are required.",
        }),
      ],
    },
    expect: { decision: "ready" },
  },

  // ---------- the model fails ----------
  {
    id: "generator-failure-clear",
    kind: "generator_failure",
    note: "A failed model call never blocks: ready, with the failure disclosed.",
    brief: { ...base, marketId: "london", sourceText: "A pop-up and a sampling workshop for our new skincare line." },
    generator: "fail",
    expect: { decision: "ready", assumption: "clarification model was unavailable" },
  },
  {
    id: "generator-failure-ambiguous",
    kind: "generator_failure",
    note: "Deterministic findings still stand when the model fails.",
    brief: { ...base, marketId: "london", sourceText: "The pop-up must be in Shoreditch, though anywhere in London is fine." },
    generator: "fail",
    expect: { decision: "clarify", reasons: ["conflict"] },
  },

  // ---------- budget ----------
  {
    id: "budget-turns-used",
    kind: "budget",
    note: "After two turns, the default is applied and recorded, and the run proceeds.",
    brief: { ...base, marketId: "london", sourceText: "The pop-up must be in Shoreditch, though anywhere in London is fine." },
    generator: none,
    budget: { turnsUsed: 2, questionsAsked: 2 },
    expect: { decision: "ready", assumption: "Shoreditch is preferred, not required", provisional: true },
  },
  {
    id: "budget-questions-used",
    kind: "budget",
    note: "After three questions, the default is applied.",
    brief: { ...base, marketId: "london", sourceText: "The pop-up must be in Shoreditch, though anywhere in London is fine." },
    generator: none,
    budget: { turnsUsed: 1, questionsAsked: 3 },
    expect: { decision: "ready", assumption: "Shoreditch is preferred, not required" },
  },
  {
    id: "budget-priority-and-defer",
    kind: "budget",
    note: "Three askable decisions on the first turn: a contradiction is asked first, the rest wait for the next turn.",
    brief: {
      ...base,
      marketId: "london",
      sourceText: "The pop-up must be in Shoreditch, though anywhere in London is fine. We plan to collaborate with Linden & Co. Never use Linden & Co. We'd like Saffron Ray to perform.",
      existingChoices: [
        { slot: "brand_collaboration", name: "Linden & Co" },
        { slot: "artist_music", name: "Saffron Ray" },
      ],
      constraints: [{ id: "x", description: "Never use Linden & Co", kind: "hard", excludeNames: ["Linden & Co"] }],
    },
    identities: [{ slot: "artist_music", name: "Saffron Ray", expectedCountry: "India", qlooDescription: "American country singer." }],
    generator: none,
    expect: { decision: "clarify", reasons: ["conflict"], deferred: 2 },
  },
  {
    id: "budget-last-turn",
    kind: "budget",
    note: "The same brief on the last turn: one is asked and the rest are assumed, since no turn remains.",
    brief: {
      ...base,
      marketId: "london",
      sourceText: "The pop-up must be in Shoreditch, though anywhere in London is fine. We plan to collaborate with Linden & Co. Never use Linden & Co. We'd like Saffron Ray to perform.",
      existingChoices: [
        { slot: "brand_collaboration", name: "Linden & Co" },
        { slot: "artist_music", name: "Saffron Ray" },
      ],
      constraints: [{ id: "x", description: "Never use Linden & Co", kind: "hard", excludeNames: ["Linden & Co"] }],
    },
    identities: [{ slot: "artist_music", name: "Saffron Ray", expectedCountry: "India", qlooDescription: "American country singer." }],
    generator: none,
    budget: { turnsUsed: 1, questionsAsked: 1 },
    expect: { decision: "clarify", reasons: ["conflict"], deferred: 0, assumption: "stays unresolved" },
  },
  {
    id: "already-asked",
    kind: "budget",
    note: "A question already answered in the session is never asked again.",
    brief: { ...base, marketId: "london", sourceText: "The pop-up must be in Shoreditch, though anywhere in London is fine." },
    generator: none,
    budget: { turnsUsed: 1, questionsAsked: 1 },
    askedIds: ["conflict:neighbourhood-vs-anywhere"],
    expect: { decision: "ready" },
  },
];
