import { compareVectors, evidenceOrder, evidenceVector } from "./matrix";
import { BudgetExceeded } from "./ledger";
import type {
  AdjudicationResult,
  CandidatePlan,
  CulturalPlan,
  EvidenceMatrix,
  PlanEvaluation,
  StabilityAudit,
  StabilityCheck,
} from "./types";

/** At most three audience anchors are audited so the extra live budget stays bounded. */
export const MAX_STABILITY_ANCHORS = 3;

export interface StabilityDeps {
  evaluate(plan: CulturalPlan): Promise<PlanEvaluation>;
  matrix(candidates: CandidatePlan[]): EvidenceMatrix;
}

const distinctFinalists = (final: AdjudicationResult, candidates: CandidatePlan[]) => {
  const known = new Set(candidates.map((c) => c.candidateId));
  const duplicate = new Set(Object.keys(final.merged));
  return final.evidenceOrder.filter(
    (id) => known.has(id) && !final.eliminated[id]?.length && !duplicate.has(id),
  );
};

function result(
  base: Omit<StabilityCheck, "outcome" | "winnerCandidateId" | "verdict" | "detail">,
  expected: string,
  verdict: StabilityCheck["verdict"],
  winnerCandidateId: string | null,
  detail: string,
): StabilityCheck {
  return {
    ...base,
    verdict,
    winnerCandidateId,
    outcome:
      verdict === "unavailable" || verdict === "insufficient_evidence"
        ? "unavailable"
        : verdict === "tie" || !winnerCandidateId
          ? "tied"
          : winnerCandidateId === expected
            ? "preserved"
            : "reversed",
    detail,
  };
}

/** A unique deterministic leader under one evidence matrix, or a tie. */
function leader(
  matrix: EvidenceMatrix,
  ids: string[],
): { verdict: "winner" | "tie" | "insufficient_evidence"; winner: string | null } {
  const viable = ids.filter((id) => !matrix.hardFailures[id]?.length);
  if (!viable.length) return { verdict: "insufficient_evidence", winner: null };
  if (viable.length === 1) return { verdict: "winner", winner: viable[0] };
  const order = evidenceOrder(matrix, viable);
  const best = evidenceVector(matrix, order[0]);
  const tied = order.filter((id) => compareVectors(evidenceVector(matrix, id), best) === 0);
  return tied.length === 1
    ? { verdict: "winner", winner: order[0] }
    : { verdict: "tie", winner: null };
}

/**
 * Stress-test only the recommendation and strongest distinct runner-up. Blind-order checks cost no
 * tools. Each anchor check re-tests those two complete plans through the caller's normal Qloo
 * evaluator, so the same evidence rules and ledger apply.
 */
export async function auditRecommendationStability(
  final: AdjudicationResult,
  candidates: CandidatePlan[],
  deps: StabilityDeps,
): Promise<StabilityAudit | null> {
  const ordered = distinctFinalists(final, candidates);
  const expected = final.winnerCandidateId ?? ordered[0] ?? null;
  if (!expected) return null;
  const runner = ordered.find((id) => id !== expected);
  const finalistIds = runner ? [expected, runner] : [expected];
  const byId = new Map(candidates.map((c) => [c.candidateId, c]));
  const checks: StabilityCheck[] = [];
  let budgetLimited = false;

  for (const [index, judgment] of final.orderResults.entries()) {
    const base = {
      id: `blind-order-${index + 1}`,
      kind: "blind_order" as const,
      label: `Blind order ${index + 1}`,
    };
    if (!judgment.valid) {
      checks.push(
        result(
          base,
          expected,
          "unavailable",
          null,
          judgment.problem ?? "The blind judgment could not be validated.",
        ),
      );
      continue;
    }
    checks.push(
      result(
        base,
        expected,
        judgment.verdict,
        judgment.winnerCandidateId,
        judgment.verdict === "winner"
          ? `Selected ${judgment.winnerCandidateId}.`
          : judgment.verdict === "tie"
            ? "The finalists tied in this order."
            : "This order did not contain enough evidence to choose.",
      ),
    );
  }

  const expectedPlan = byId.get(expected)?.plan;
  const anchors = (expectedPlan?.anchors ?? []).slice(0, MAX_STABILITY_ANCHORS);
  if (runner && anchors.length > 1) {
    for (const anchor of anchors) {
      const base = {
        id: `anchor-dropout-${anchor.id}`,
        kind: "anchor_dropout" as const,
        label: `Without ${anchor.name}`,
        omittedAnchor: { id: anchor.id, name: anchor.name },
      };
      try {
        const tested = await Promise.all(
          finalistIds.map(async (id) => {
            const original = byId.get(id)!;
            const plan = {
              ...original.plan,
              anchors: original.plan.anchors.filter((a) => a.id !== anchor.id),
            };
            return { ...original, plan, evaluation: await deps.evaluate(plan) };
          }),
        );
        const matrix = deps.matrix(tested);
        const found = leader(matrix, finalistIds);
        checks.push(
          result(
            base,
            expected,
            found.verdict,
            found.winner,
            found.verdict === "winner"
              ? `The evidence order selected ${found.winner} after both complete plans were re-tested.`
              : found.verdict === "tie"
                ? "The complete plans became level after this audience anchor was withheld."
                : "Too little evidence remained to compare the complete plans.",
          ),
        );
      } catch (error) {
        checks.push(
          result(
            base,
            expected,
            "unavailable",
            null,
            error instanceof Error ? error.message : "The anchor check could not be completed.",
          ),
        );
        if (error instanceof BudgetExceeded) {
          budgetLimited = true;
          break;
        }
      }
    }
  }

  const completed = checks.filter((c) => c.outcome !== "unavailable").length;
  const count = (outcome: StabilityCheck["outcome"]) =>
    checks.filter((c) => c.outcome === outcome).length;
  const preserved = count("preserved");
  const tied = count("tied");
  const reversed = count("reversed");
  const unavailable = count("unavailable");
  return {
    version: "stability:v1",
    expectedWinnerId: expected,
    finalistIds,
    checks,
    completed,
    preserved,
    tied,
    reversed,
    unavailable,
    budgetLimited,
    robust:
      checks.some((check) => check.kind === "anchor_dropout") &&
      unavailable === 0 &&
      tied === 0 &&
      reversed === 0,
  };
}
