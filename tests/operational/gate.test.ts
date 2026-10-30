import { describe, expect, it } from "vitest";
import {
  addOperationalClaims,
  applyVenueFitPreference,
  applyOperationalGate,
  operationalSalvageSource,
  operationalVenues,
} from "@/lib/operational/gate";
import type { AdjudicationResult, CandidatePlan, EvidenceMatrix } from "@/lib/crashtest/types";
import type { VenueOperationalCheck } from "@/lib/operational/types";

const candidate = (candidateId: string, track: CandidatePlan["track"], venue: string) =>
  ({
    candidateId,
    track,
    plan: { anchors: [], components: [{ slot: "event_place", label: venue }] },
    open: [],
  }) as unknown as CandidatePlan;

const final: AdjudicationResult = {
  stage: "final",
  candidateIds: ["user", "agent"],
  eliminated: {},
  merged: {},
  winnerCandidateId: "agent",
  verdict: "winner",
  dimensionWinners: {},
  rationale: "The agent led on cultural evidence.",
  decisiveClaimIds: [],
  counterevidenceClaimIds: [],
  orderResults: [],
  flagged: [],
  evidenceOrder: ["agent", "user"],
};

const check = (
  venue: string,
  status: VenueOperationalCheck["status"],
  finding: string,
): VenueOperationalCheck => ({
  venue,
  city: "London",
  status,
  finding,
  facts: [],
  limitations: ["Dates unverified."],
  sources: [],
});

describe("operational feasibility gate", () => {
  const candidates = [
    candidate("user", "user", "Barbican Conservatory"),
    candidate("agent", "agent", "For Your Eyes Only"),
  ];

  it("checks the preliminary recommendation's venue first, then the user's and every other finalist's", () => {
    expect(operationalVenues(candidates, final)).toEqual([
      "For Your Eyes Only",
      "Barbican Conservatory",
    ]);
  });

  it("vetoes a verified conflict and falls back by the existing evidence order", () => {
    const result = applyOperationalGate(candidates, final, [
      check(
        "Barbican Conservatory",
        "verified_fit",
        "Official hire page supports product launches.",
      ),
      check(
        "For Your Eyes Only",
        "verified_conflict",
        "Official site identifies it as a strip club.",
      ),
    ]);
    expect(result.result.winnerCandidateId).toBe("user");
    expect(result.result.eliminated.agent?.[0]).toContain("strip club");
    expect(result.override?.toVenue).toBe("Barbican Conservatory");
  });

  it("records who picked the vetoed venue, what Qloo filed it under, and the kind of conflict", () => {
    const agent = {
      ...candidate("agent", "agent", "For Your Eyes Only"),
      sources: { event_place: "agent" },
      plan: { anchors: [], components: [{ slot: "event_place", label: "For Your Eyes Only", placeCategory: "urn:tag:category:place:cocktail_bar" }] },
    } as unknown as CandidatePlan;
    const conflict: VenueOperationalCheck = {
      ...check("For Your Eyes Only", "verified_conflict", "Official site identifies it as a strip club."),
      conflictKind: "wrong_establishment",
      sources: [{ title: "Official", url: "https://fyeo.example", snippet: "", sourceType: "official", retrievedAt: "" }],
    };
    const { override } = applyOperationalGate([candidates[0], agent], final, [conflict]);
    expect(override).toMatchObject({
      fromSource: "agent",
      fromQlooCategory: "cocktail bar",
      kind: "wrong_establishment",
      sourceUrl: "https://fyeo.example",
    });
  });

  it("does not let an unverified web reading change the result", () => {
    expect(
      applyOperationalGate(candidates, final, [
        check("For Your Eyes Only", "unverified", "A directory suggests a possible mismatch."),
      ]).result.winnerCandidateId,
    ).toBe("agent");
  });

  it("replaces the generic feasibility unknown with the operational claim", () => {
    const matrix: EvidenceMatrix = {
      rubricVersion: "test",
      candidateIds: ["agent"],
      claims: [
        {
          claimId: "agent/event_place/unverified",
          candidateId: "agent",
          slot: "event_place",
          dimension: "feasibility",
          claim: "Unknown",
          stance: "unknown",
          source: "logical_rubric",
          evidenceIds: [],
          ruleId: "R-feasibility-unverified",
          strength: "unknown",
          limitations: [],
        },
      ],
      coverageByCandidate: { agent: 1 },
      completenessByCandidate: { agent: 1 },
      hardFailures: { agent: [] },
      componentStates: { agent: { event_place: "supported" } },
    };
    addOperationalClaims(matrix, candidates, [
      check("For Your Eyes Only", "verified_conflict", "Wrong establishment type."),
    ]);
    expect(matrix.claims).toHaveLength(1);
    expect(matrix.claims[0]).toMatchObject({
      claimId: "agent/event_place/operational",
      source: "official_source",
      stance: "contradicts",
    });
    expect(matrix.componentStates.agent.event_place).toBe("rejected");
  });

  it("identifies a safe mixed-plan source without treating the rejected venue as viable", () => {
    const source = operationalSalvageSource(candidates, final, [
      check("Barbican Conservatory", "verified_fit", "Official hire page supports launches."),
      check("For Your Eyes Only", "verified_conflict", "Official site identifies a strip club."),
    ]);
    expect(source?.preliminary.candidateId).toBe("agent");
    expect(source?.preliminaryVenue.label).toBe("For Your Eyes Only");
    expect(source?.userVenue.label).toBe("Barbican Conservatory");
    expect(source?.conflict.status).toBe("verified_conflict");
  });
});

describe("venue preference on cited fit facts (operational:v2)", () => {
  const plan = (candidateId: string, track: CandidatePlan["track"], venue: string, named = 0) =>
    ({
      candidateId,
      track,
      sources: { event_place: track },
      plan: {
        anchors: [],
        components: [
          { slot: "event_place", label: venue, origin: track === "user" ? "user_provided" : "agent_proposed" },
          ...Array.from({ length: named }, (_, i) => ({ slot: "artist_music", label: `Act ${i}`, origin: "user_provided" })),
        ],
      },
      open: [],
    }) as unknown as CandidatePlan;
  const fitted = (venue: string, fit: VenueOperationalCheck["fit"], cited = true): VenueOperationalCheck => ({
    ...check(venue, "unverified", "No operational conflict."),
    fit,
    sources: cited ? [{ title: "Listing", url: `https://example.com/${venue}`, snippet: "", sourceType: "other", retrievedAt: "" }] : [],
  });
  const result = (order: string[], verdict: AdjudicationResult["verdict"] = "winner"): AdjudicationResult => ({
    ...final,
    candidateIds: order,
    evidenceOrder: order,
    winnerCandidateId: verdict === "winner" ? order[0] : null,
    verdict,
  });
  const outside = { kind: "suits" as const, area: "outside" as const, access: "open" as const, note: "It is in Condesa, not Roma Norte." };
  const inside = { kind: "suits" as const, area: "inside" as const, access: "open" as const, note: "" };

  it("moves to a finalist whose venue has fewer cited concerns and keeps as many named choices", () => {
    const cands = [plan("agent", "agent", "Studio 73", 2), plan("llm", "llm", "Foro Indie Rocks!", 2)];
    const { result: r, preference } = applyVenueFitPreference(cands, result(["agent", "llm"]), [fitted("Studio 73", outside), fitted("Foro Indie Rocks!", inside)], {});
    expect(r.winnerCandidateId).toBe("llm");
    expect(r.verdict).toBe("winner");
    expect(preference).toMatchObject({ fromVenue: "Studio 73", fromSource: "agent", toVenue: "Foro Indie Rocks!", toSource: "llm", concerns: ["outside the area the brief names"] });
  });

  it("never trades away a named choice for a better venue", () => {
    const cands = [plan("agent", "agent", "Studio 73", 2), plan("llm", "llm", "Foro Indie Rocks!", 1)];
    expect(applyVenueFitPreference(cands, result(["agent", "llm"]), [fitted("Studio 73", outside), fitted("Foro Indie Rocks!", inside)], {}).preference).toBeUndefined();
  });

  it("ignores uncited fit readings and finalists that break a hard rule", () => {
    const cands = [plan("agent", "agent", "Studio 73"), plan("llm", "llm", "Foro Indie Rocks!")];
    expect(applyVenueFitPreference(cands, result(["agent", "llm"]), [fitted("Studio 73", outside, false), fitted("Foro Indie Rocks!", inside)], {}).preference).toBeUndefined();
    expect(applyVenueFitPreference(cands, result(["agent", "llm"]), [fitted("Studio 73", outside), fitted("Foro Indie Rocks!", inside)], { llm: ["breaks a rule"] }).preference).toBeUndefined();
  });

  it("keeps an undecided comparison undecided and only reorders its fallback", () => {
    const cands = [plan("agent", "agent", "Studio 73"), plan("llm", "llm", "Foro Indie Rocks!")];
    const { result: r } = applyVenueFitPreference(cands, result(["agent", "llm"], "unstable"), [fitted("Studio 73", outside), fitted("Foro Indie Rocks!", inside)], {});
    expect(r.verdict).toBe("unstable");
    expect(r.winnerCandidateId).toBeNull();
    expect(r.evidenceOrder[0]).toBe("llm");
  });
});
