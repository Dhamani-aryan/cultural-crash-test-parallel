import { createHash } from "node:crypto";
import type { LaunchBriefInput, Slot } from "../src/lib/crashtest/types";
import type { PlausibilityTally } from "./summary";

/**
 * Plausibility cases: does the agent's final choice still make cultural sense for the job, or
 * did it chase the evidence rubric into an implausible pick? Each case names one choice and the
 * outcome a knowledgeable human expects: keep it, or accept a replacement only if it is a
 * credible act / partner / venue / direction for this launch. Several cases expect the original
 * to stay.
 *
 * STATUS: drafted by the developer tooling and NOT yet human-reviewed. A case counts towards the
 * merge gates only after a person has checked its brief, expectation and check and set
 * `reviewed: true`. Outcomes are graded by a person too (see `PlausibilityReview`), never by a
 * model. Run them with `npm run eval:plausibility`.
 *
 * No audience anchor may also be the choice under test: Qloo leaves signal entities out of its
 * results, so the choice would be tested against itself.
 */
export interface PlausibilityCase {
  id: string;
  brief: LaunchBriefInput;
  slot: Slot;
  /** "keep": the original should survive. "replace_ok": a replacement is acceptable if credible. */
  expect: "keep" | "replace_ok";
  /** Which plan requirement this case covers. */
  covers:
    | "credible_original_retained"
    | "artist_event_genre_fit"
    | "venue_in_market_event_capable"
    | "brand_compatible_business"
    | "direction_attributes_survive"
    | "unverifiable_rule_preserves_and_flags";
  /** What a reviewer should check in the final choice. */
  check: string;
  reviewed: boolean;
}

/** A person's grade for one run's outcome of one case. Filled in by hand in the results file. */
export interface PlausibilityReview {
  verdict: "credible" | "questionable" | "implausible";
  /** One sentence. */
  reason: string;
  reviewer: string;
}

/**
 * A fingerprint of what a case tests (brief, slot, expectation). A result row recorded under a
 * different fingerprint is stale: the case changed after it ran, so its outcome and grade don't apply.
 */
export const caseKey = (c: Pick<PlausibilityCase, "brief" | "slot" | "expect">) =>
  createHash("sha256").update(JSON.stringify({ brief: c.brief, slot: c.slot, expect: c.expect })).digest("hex").slice(0, 16);

/** One case's outcome in a plausibility run (eval/plausibility-run.ts writes these). */
export interface PlausibilityRow {
  id: string;
  /** `caseKey` of the case as it was when this row ran; absent in rows written before it was recorded. */
  caseKey?: string;
  reviewed: boolean;
  expect: "keep" | "replace_ok";
  original: string | null;
  final: string | null;
  changed: boolean;
  /** "keep" cases: the original survived. "replace_ok" cases: always true (credibility is graded by hand). */
  expectationHeld: boolean;
  flagged: boolean;
  status: string | null;
  review: PlausibilityReview | null;
  error: string | null;
}

export interface PlausibilityFile {
  ranAt: string;
  runVersion?: string;
  ranking?: string;
  /** The agent's model; absent in files written before it was recorded. */
  model?: string;
  rows: PlausibilityRow[];
}

const VERDICTS = new Set<string>(["credible", "questionable", "implausible"]);
const isGraded = (r: PlausibilityReview | null | undefined): r is PlausibilityReview =>
  !!r && VERDICTS.has(r.verdict) && !!r.reason?.trim() && !!r.reviewer?.trim();

/**
 * Check a plausibility run against the current cases and the run it vouches for (B). Every
 * current case needs exactly one row that ran without error under the current case definition,
 * from the same agent version, ranking and model as B. Only valid rows count, and only for cases
 * a person has reviewed and whose outcome a person has graded in full.
 */
export function checkPlausibility(
  file: PlausibilityFile,
  cases: Pick<PlausibilityCase, "id" | "brief" | "slot" | "expect" | "reviewed">[],
  run: { runVersion?: string; ranking?: string; model?: string },
): { problems: string[]; tally: PlausibilityTally } {
  const problems: string[] = [];
  const meta = (what: string, x: string | undefined, want: string | undefined) => {
    if (!x || !want) problems.push(`Plausibility run's ${what} not recorded (run: ${x ?? "missing"}, B: ${want ?? "missing"}).`);
    else if (x !== want) problems.push(`Plausibility run is stale: ${what} ${x}, B ${want}.`);
  };
  meta("agent version", file.runVersion, run.runVersion);
  meta("ranking", file.ranking, run.ranking);
  meta("agent model", file.model, run.model);
  const rows = Array.isArray(file.rows) ? file.rows : [];
  const ids = new Set(rows.map((r) => r.id));
  const known = new Set(cases.map((c) => c.id));
  for (const id of ids) if (!known.has(id)) problems.push(`Plausibility row for an unknown case: ${id}.`);
  let graded = 0;
  let implausible = 0;
  let valid = 0;
  for (const c of cases) {
    const mine = rows.filter((r) => r.id === c.id);
    if (!mine.length) {
      problems.push(`Plausibility case ${c.id} has no row.`);
      continue;
    }
    if (mine.length > 1) {
      problems.push(`Plausibility case ${c.id} has ${mine.length} rows.`);
      continue;
    }
    const [r] = mine;
    if (r.error || r.final === null) {
      problems.push(`Plausibility case ${c.id} errored: ${r.error ?? "no final choice"}.`);
      continue;
    }
    if (r.caseKey !== caseKey(c)) {
      problems.push(`Plausibility case ${c.id} is stale: ${r.caseKey ? "the case changed after it ran" : "its case fingerprint was not recorded"}.`);
      continue;
    }
    valid++;
    if (r.review && !isGraded(r.review)) problems.push(`Plausibility case ${c.id} has an incomplete grade (needs verdict, reason and reviewer).`);
    if (!c.reviewed || !isGraded(r.review)) continue;
    graded++;
    if (r.review.verdict === "implausible") implausible++;
  }
  return { problems, tally: { cases: cases.length, rows: rows.length, uniqueIds: ids.size, valid, graded, implausible, problems: problems.length } };
}

const base = { brandAttributes: [], constraints: [], depth: "thorough" as const };

export const PLAUSIBILITY: PlausibilityCase[] = [
  {
    id: "london-artist-local-hero",
    brief: {
      ...base,
      brandName: "Grain Studio",
      productCategory: "Independent menswear",
      launchGoal: "A store-opening party",
      marketId: "london",
      audienceDescription: "25–35 London menswear and grime fans",
      audienceAnchors: ["Aries", "Wood Wood", "Little Simz"],
      existingChoices: [{ slot: "artist_music", name: "Skepta" }],
    },
    slot: "artist_music",
    expect: "keep",
    covers: "credible_original_retained",
    check: "A London grime headliner is a credible act for this audience; a replacement would need to be equally credible, not just higher on the rubric.",
    reviewed: false,
  },
  {
    id: "tokyo-brand-same-business",
    brief: {
      ...base,
      brandName: "Field Unit",
      productCategory: "Outdoor technical apparel",
      launchGoal: "A collaboration jacket drop",
      marketId: "tokyo",
      audienceDescription: "Tokyo outdoor and city-wear enthusiasts",
      audienceAnchors: ["Goldwin", "And Wander", "Arc'teryx"],
      existingChoices: [{ slot: "brand_collaboration", name: "Snow Peak" }],
    },
    slot: "brand_collaboration",
    expect: "keep",
    covers: "brand_compatible_business",
    check: "A replacement partner must be an outdoor or apparel business; a beverage or tech brand is implausible however strong its affinity.",
    reviewed: false,
  },
  {
    id: "madrid-venue-event-capable",
    brief: {
      ...base,
      brandName: "Rumbo",
      productCategory: "Sustainable sneakers",
      launchGoal: "A pop-up launch weekend",
      marketId: "madrid",
      audienceDescription: "Madrid design and sneaker fans aged 20–35",
      audienceAnchors: ["Ecoalf", "Camper", "Veja"],
      existingChoices: [],
    },
    slot: "event_place",
    expect: "replace_ok",
    covers: "venue_in_market_event_capable",
    check: "The venue must be in Madrid and able to host a retail pop-up (gallery, event space, concept store); a hotel, restaurant or museum café is implausible.",
    reviewed: false,
  },
  {
    id: "sao-paulo-artist-genre-fit",
    brief: {
      ...base,
      brandName: "Viela",
      productCategory: "Streetwear",
      launchGoal: "A launch night with a live set",
      marketId: "sao-paulo",
      audienceDescription: "São Paulo streetwear and funk fans aged 18–28",
      audienceAnchors: ["Approve", "Piet", "MC Kevin o Chris"],
      existingChoices: [],
    },
    slot: "artist_music",
    expect: "replace_ok",
    covers: "artist_event_genre_fit",
    check: "The act should be one this audience would plausibly see at a launch night (Brazilian funk, rap or electronic); a global pop star is implausible for a small launch.",
    reviewed: false,
  },
  {
    id: "mumbai-brand-keep-under-rule",
    brief: {
      ...base,
      brandName: "Loom Lane",
      productCategory: "Handloom fashion",
      launchGoal: "A collaboration capsule",
      marketId: "mumbai",
      audienceDescription: "Mumbai shoppers of contemporary Indian craft fashion",
      audienceAnchors: ["Good Earth", "Fabindia", "Raw Mango"],
      existingChoices: [{ slot: "brand_collaboration", name: "Nicobar" }],
      constraints: [{ id: "r1", kind: "hard", description: "No fast-fashion collaborators" }],
    },
    slot: "brand_collaboration",
    expect: "keep",
    covers: "credible_original_retained",
    check: "A credible craft partner the evidence doesn't contradict should stay; any replacement must also be a craft or design brand.",
    reviewed: false,
  },
  {
    id: "london-direction-keep-attributes",
    brief: {
      ...base,
      brandName: "Northbound Supply",
      productCategory: "Streetwear and skate-inspired apparel",
      launchGoal: "A weekend pop-up",
      marketId: "london",
      audienceDescription: "18–30 year-old skate and streetwear fans in East London",
      audienceAnchors: ["Stüssy", "Palace Skateboards", "Carhartt"],
      brandAttributes: ["utilitarian", "understated"],
      // Part-supported on purpose, with exploration on, so the direction repair actually runs.
      existingChoices: [{ slot: "creative_direction", name: "Utilitarian and playful pastel" }],
      exploreUserChoices: true,
    },
    slot: "creative_direction",
    expect: "replace_ok",
    covers: "direction_attributes_survive",
    check: "A revised direction must keep Utilitarian (the brand's attribute, and supported here) and replace only the pastel part; it must not become a different look.",
    reviewed: false,
  },
  {
    id: "london-unknown-brand-unverifiable-rule",
    brief: {
      ...base,
      brandName: "Kettle & Kiln",
      productCategory: "Small-batch ceramics",
      launchGoal: "A studio open day",
      marketId: "london",
      audienceDescription: "London design and craft enthusiasts aged 25–40",
      audienceAnchors: ["HAY", "Muji", "Toast"],
      // A small studio Qloo is unlikely to know, under a rule code can't verify.
      existingChoices: [{ slot: "brand_collaboration", name: "Hackney Clay Collective" }],
      constraints: [{ id: "r1", kind: "hard", description: "No luxury collaboration" }],
    },
    slot: "brand_collaboration",
    expect: "keep",
    covers: "unverifiable_rule_preserves_and_flags",
    check: "If Qloo doesn't know the brand, it must stay unchanged and be flagged with a question for a human; it must never be upgraded.",
    reviewed: false,
  },
];
