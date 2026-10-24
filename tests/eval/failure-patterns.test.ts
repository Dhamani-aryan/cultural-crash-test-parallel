import { describe, expect, it } from "vitest";
import { failurePatterns, selectPatternRepresentatives } from "../../eval/failure-patterns-lib";

describe("failure-pattern scenario selection", () => {
  it("skips a stable improving scenario", () => {
    expect(failurePatterns({ id: "good", initialSupported: 1, finalSupported: 3, stable: true })).toEqual([]);
  });

  it("classifies evidence, stability and semantic failures from the saved trace", () => {
    expect(
      failurePatterns(
        { id: "bad", initialSupported: 0, finalSupported: 0, stable: false, provisional: true },
        {
          parallel: {
            verdict: { candidateId: "agent" },
            stability: {
              checks: [
                { kind: "blind_order", outcome: "reversed" },
                { kind: "anchor_dropout", outcome: "reversed" },
              ],
            },
            matrix: {
              claims: [
                { candidateId: "agent", dimension: "role_fit", stance: "contradicts" },
                { candidateId: "agent", ruleId: "R-role-check", stance: "unknown" },
                // A losing plan's problem must not be attributed to the recommendation.
                { candidateId: "llm", ruleId: "R-neighborhood", stance: "contradicts" },
              ],
            },
          },
        },
      ),
    ).toEqual([
      "brief_contradiction",
      "role_uncertainty",
      "anchor_sensitivity",
      "blind_order_instability",
      "zero_support",
      "no_evidence_gain",
    ]);
  });

  it("chooses a deterministic minimal representative set instead of rerunning every failure", () => {
    expect(
      selectPatternRepresentatives([
        { id: "a", patterns: ["role_uncertainty", "anchor_sensitivity"] },
        { id: "b", patterns: ["role_uncertainty"] },
        { id: "c", patterns: ["zero_support", "no_evidence_gain"] },
        { id: "d", patterns: [] },
      ]).map((c) => c.id),
    ).toEqual(["a", "c"]);
  });
});

