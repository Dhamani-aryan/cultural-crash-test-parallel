import { describe, expect, it } from "vitest";
import { BudgetExceeded } from "@/lib/crashtest/ledger";
import { auditRecommendationStability } from "@/lib/crashtest/stability";
import type {
  AdjudicationResult,
  CandidatePlan,
  EvidenceMatrix,
  EntityRef,
  PlanEvaluation,
} from "@/lib/crashtest/types";

const anchor = (id: string, name: string): EntityRef => ({
  id,
  name,
  type: "urn:entity:brand",
  popularity: null,
  imageUrl: null,
  shortDescription: null,
});

const anchors = [
  anchor("a1", "Anchor one"),
  anchor("a2", "Anchor two"),
  anchor("a3", "Anchor three"),
  anchor("a4", "Anchor four"),
];

const candidate = (candidateId: string): CandidatePlan => ({
  candidateId,
  track: candidateId === "agent" ? "agent" : "llm",
  blindId: `blind-${candidateId}`,
  briefFingerprint: "brief",
  plan: { anchors, components: [] },
  open: [],
  sources: {},
  evaluation: null,
  assumptions: [],
  provenance: { qlooCalls: 0, llmCalls: 0, ms: 0, generatedAt: "2026-10-24T00:00:00.000Z" },
});

const final: AdjudicationResult = {
  stage: "final",
  candidateIds: ["agent", "llm"],
  eliminated: {},
  merged: {},
  winnerCandidateId: "agent",
  verdict: "winner",
  dimensionWinners: {},
  rationale: "Agent wins.",
  decisiveClaimIds: [],
  counterevidenceClaimIds: [],
  orderResults: [
    {
      order: ["blind-agent", "blind-llm"],
      verdict: "winner",
      winnerCandidateId: "agent",
      decisiveClaimIds: [],
      counterevidenceClaimIds: [],
      dimensionWinners: {},
      rationale: "",
      evidenceId: "j1",
      valid: true,
    },
    {
      order: ["blind-llm", "blind-agent"],
      verdict: "winner",
      winnerCandidateId: "agent",
      decisiveClaimIds: [],
      counterevidenceClaimIds: [],
      dimensionWinners: {},
      rationale: "",
      evidenceId: "j2",
      valid: true,
    },
  ],
  flagged: [],
  evidenceOrder: ["agent", "llm"],
};

const evaluation = {} as PlanEvaluation;
const matrix = (plans: CandidatePlan[], winner: string | null): EvidenceMatrix => ({
  rubricVersion: "test",
  candidateIds: plans.map((p) => p.candidateId),
  claims: plans.flatMap((p) =>
    winner
      ? [
          {
            claimId: `${p.candidateId}/audience`,
            candidateId: p.candidateId,
            dimension: "audience" as const,
            claim: "test",
            stance: p.candidateId === winner ? ("supports" as const) : ("unknown" as const),
            source: "qloo_affinity" as const,
            evidenceIds: ["e1"],
            strength: "moderate" as const,
            limitations: [],
            slot: "artist_music" as const,
          },
        ]
      : [],
  ),
  coverageByCandidate: Object.fromEntries(plans.map((p) => [p.candidateId, 1])),
  completenessByCandidate: Object.fromEntries(plans.map((p) => [p.candidateId, 1])),
  hardFailures: Object.fromEntries(plans.map((p) => [p.candidateId, []])),
  componentStates: Object.fromEntries(plans.map((p) => [p.candidateId, {}])),
});

describe("recommendation stability audit", () => {
  it("re-tests only the two finalists and caps leave-one-anchor-out checks at three", async () => {
    const seen: string[][] = [];
    const audit = await auditRecommendationStability(
      final,
      [candidate("agent"), candidate("llm"), candidate("user")],
      {
        evaluate: async (plan) => {
          seen.push(plan.anchors.map((a) => a.id));
          return evaluation;
        },
        matrix: (plans) => matrix(plans, "agent"),
      },
    );

    expect(audit).toMatchObject({
      completed: 5,
      preserved: 5,
      tied: 0,
      reversed: 0,
      unavailable: 0,
      budgetLimited: false,
      robust: true,
    });
    expect(audit!.checks.map((c) => c.id)).toEqual([
      "blind-order-1",
      "blind-order-2",
      "anchor-dropout-a1",
      "anchor-dropout-a2",
      "anchor-dropout-a3",
    ]);
    expect(seen).toHaveLength(6);
    expect(seen.every((ids) => ids.length === 3)).toBe(true);
  });

  it("marks the recommendation provisional evidence when an anchor dropout reverses it", async () => {
    const audit = await auditRecommendationStability(
      final,
      [candidate("agent"), candidate("llm")],
      {
        evaluate: async () => evaluation,
        matrix: (plans) =>
          matrix(plans, plans[0].plan.anchors.some((a) => a.id === "a1") ? "agent" : "llm"),
      },
    );

    expect(audit).toMatchObject({ preserved: 4, reversed: 1, tied: 0, robust: false });
    expect(audit!.checks.find((c) => c.id === "anchor-dropout-a1")).toMatchObject({
      outcome: "reversed",
      winnerCandidateId: "llm",
    });
  });

  it("stops bounded stress work when the Qloo budget is exhausted", async () => {
    let calls = 0;
    const audit = await auditRecommendationStability(
      final,
      [candidate("agent"), candidate("llm")],
      {
        evaluate: async () => {
          if (++calls === 2) throw new BudgetExceeded(700);
          return evaluation;
        },
        matrix: (plans) => matrix(plans, "agent"),
      },
    );

    expect(audit).toMatchObject({ budgetLimited: true, unavailable: 1, robust: false });
    expect(audit!.checks).toHaveLength(3);
    expect(audit!.checks.at(-1)).toMatchObject({ id: "anchor-dropout-a1", outcome: "unavailable" });
  });
});
