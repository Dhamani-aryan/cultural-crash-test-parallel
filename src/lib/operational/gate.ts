import type {
  AdjudicationResult,
  CandidatePlan,
  Component,
  EvidenceMatrix,
} from "@/lib/crashtest/types";
import type { OperationalAudit, VenueOperationalCheck } from "./types";

const key = (value: string) => value.trim().toLocaleLowerCase();
const venueOf = (candidate: CandidatePlan | undefined | null) =>
  candidate?.plan.components.find((component) => component.slot === "event_place")?.label ?? null;

export interface OperationalSalvageSource {
  preliminary: CandidatePlan;
  user: CandidatePlan;
  preliminaryVenue: Component;
  userVenue: Component;
  conflict: VenueOperationalCheck;
}

/**
 * Find the one safe mixed-plan opportunity after a venue veto: preserve the cultural winner's
 * non-venue choices and substitute the user's checked venue. The caller must still re-evaluate the
 * complete mixed plan; this helper only establishes that the substitution is operationally legal.
 */
export function operationalSalvageSource(
  candidates: CandidatePlan[],
  result: AdjudicationResult,
  checks: VenueOperationalCheck[],
): OperationalSalvageSource | null {
  const byVenue = new Map(checks.map((check) => [key(check.venue), check]));
  const preliminaryId = result.winnerCandidateId ?? result.evidenceOrder[0] ?? null;
  const preliminary = candidates.find((candidate) => candidate.candidateId === preliminaryId);
  const user = candidates.find((candidate) => candidate.candidateId === "user");
  const preliminaryVenue = preliminary?.plan.components.find(
    (component) => component.slot === "event_place",
  );
  const userVenue = user?.plan.components.find((component) => component.slot === "event_place");
  if (!preliminary || !user || !preliminaryVenue || !userVenue) return null;
  if (key(preliminaryVenue.label) === key(userVenue.label)) return null;
  const conflict = byVenue.get(key(preliminaryVenue.label));
  if (conflict?.status !== "verified_conflict") return null;
  if (byVenue.get(key(userVenue.label))?.status === "verified_conflict") return null;
  return { preliminary, user, preliminaryVenue, userVenue, conflict };
}

export function operationalVenues(
  candidates: CandidatePlan[],
  result: AdjudicationResult,
): string[] {
  const user = venueOf(candidates.find((candidate) => candidate.candidateId === "user"));
  const preliminaryId = result.winnerCandidateId ?? result.evidenceOrder[0];
  const preliminary = venueOf(
    candidates.find((candidate) => candidate.candidateId === preliminaryId),
  );
  return [...new Set([user, preliminary].filter((value): value is string => !!value))].slice(0, 2);
}

/**
 * Apply only a verified operational contradiction as a veto. Cultural ordering otherwise stays
 * untouched. This is intentionally deterministic: the web-reading model cannot award a winner.
 */
export function applyOperationalGate(
  candidates: CandidatePlan[],
  result: AdjudicationResult,
  checks: VenueOperationalCheck[],
): { result: AdjudicationResult; override?: OperationalAudit["override"] } {
  const byVenue = new Map(checks.map((check) => [key(check.venue), check]));
  const preliminaryId = result.winnerCandidateId ?? result.evidenceOrder[0] ?? null;
  const preliminary = candidates.find((candidate) => candidate.candidateId === preliminaryId);
  const preliminaryVenue = venueOf(preliminary);
  if (!preliminaryId || !preliminaryVenue) return { result };
  const conflict = byVenue.get(key(preliminaryVenue));
  if (conflict?.status !== "verified_conflict") return { result };

  const candidateIds = new Set(result.candidateIds);
  const nextId =
    result.evidenceOrder.find((candidateId) => {
      if (
        candidateId === preliminaryId ||
        !candidateIds.has(candidateId) ||
        result.eliminated[candidateId]
      )
        return false;
      const venue = venueOf(candidates.find((candidate) => candidate.candidateId === candidateId));
      return !!venue && byVenue.get(key(venue))?.status !== "verified_conflict";
    }) ?? null;
  const nextVenue = venueOf(candidates.find((candidate) => candidate.candidateId === nextId));
  const reason = `${preliminaryVenue} failed the operational check: ${conflict.finding}`;
  return {
    result: {
      ...result,
      eliminated: {
        ...result.eliminated,
        [preliminaryId]: [...(result.eliminated[preliminaryId] ?? []), reason],
      },
      winnerCandidateId: nextId,
      verdict: nextId ? "winner" : "insufficient_evidence",
      rationale: nextId
        ? `${reason} The highest remaining plan on the recorded evidence is shown instead.`
        : `${reason} No operationally viable alternative was established.`,
      decisiveClaimIds: [...result.decisiveClaimIds, `${preliminaryId}/event_place/operational`],
    },
    override: {
      fromCandidateId: preliminaryId,
      fromVenue: preliminaryVenue,
      toCandidateId: nextId,
      toVenue: nextVenue,
      reason,
    },
  };
}

/** Add the official-source result to the same evidence matrix the UI and report inspect. */
export function addOperationalClaims(
  matrix: EvidenceMatrix,
  candidates: CandidatePlan[],
  checks: VenueOperationalCheck[],
) {
  const byVenue = new Map(checks.map((check) => [key(check.venue), check]));
  for (const candidate of candidates) {
    const venue = venueOf(candidate);
    if (!venue) continue;
    const check = byVenue.get(key(venue));
    if (!check) continue;
    matrix.claims = matrix.claims.filter(
      (claim) =>
        !(
          claim.candidateId === candidate.candidateId &&
          claim.slot === "event_place" &&
          claim.dimension === "feasibility"
        ),
    );
    matrix.claims.push({
      claimId: `${candidate.candidateId}/event_place/operational`,
      candidateId: candidate.candidateId,
      slot: "event_place",
      dimension: "feasibility",
      claim: check.finding,
      stance:
        check.status === "verified_fit"
          ? "supports"
          : check.status === "verified_conflict"
            ? "contradicts"
            : "unknown",
      source: "official_source",
      evidenceIds: [],
      ruleId: "R-operational-source",
      strength: check.status === "unverified" ? "unknown" : "strong",
      limitations: check.limitations,
    });
    if (check.status === "verified_conflict") {
      matrix.hardFailures[candidate.candidateId] = [
        ...(matrix.hardFailures[candidate.candidateId] ?? []),
        check.finding,
      ];
      matrix.componentStates[candidate.candidateId] ??= {};
      matrix.componentStates[candidate.candidateId].event_place = "rejected";
    }
  }
  return matrix;
}
