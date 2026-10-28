import { describe, expect, it } from "vitest";
import {
  addOperationalClaims,
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

  it("checks only the user's original and the preliminary recommendation", () => {
    expect(operationalVenues(candidates, final)).toEqual([
      "Barbican Conservatory",
      "For Your Eyes Only",
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
