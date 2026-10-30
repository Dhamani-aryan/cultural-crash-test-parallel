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

/**
 * The venues to check: the preliminary recommendation's, the user's, then every other finalist's
 * in evidence order, so a finalist venue can be preferred on cited facts (at most four searches).
 */
export function operationalVenues(
  candidates: CandidatePlan[],
  result: AdjudicationResult,
): string[] {
  const venue = (id: string | null | undefined) => venueOf(candidates.find((candidate) => candidate.candidateId === id));
  const preliminaryId = result.winnerCandidateId ?? result.evidenceOrder[0];
  const finalists = result.evidenceOrder.filter((id) => result.candidateIds.includes(id) && !result.eliminated[id]);
  return [...new Set([venue(preliminaryId), venue("user"), ...finalists.map(venue)].filter((value): value is string => !!value))].slice(0, 4);
}

/** The cited fit facts that count against a venue: the wrong kind of place, outside the named area, closed to the guests. */
export function fitConcerns(check: VenueOperationalCheck | undefined): string[] {
  const fit = check?.sources.length ? check.fit : undefined;
  if (!fit) return [];
  return [
    ...(fit.kind === "unsuitable" ? ["not the right kind of place for this event"] : []),
    ...(fit.area === "outside" ? ["outside the area the brief names"] : []),
    ...(fit.access === "restricted" ? ["not open to the launch's guests"] : []),
  ];
}

const keptNamed = (candidate: CandidatePlan) =>
  candidate.plan.components.filter((component) => component.origin === "user_provided").length;

/**
 * Prefer a finalist venue on cited web facts (operational:v2). When the recommended plan's venue
 * has fit concerns another finalist's doesn't share as much, and that finalist keeps at least as
 * many of the user's named choices and breaks no hard rule, the recommendation moves to it: the
 * first such finalist in evidence order. The web facts only choose among plans that already passed
 * the blind comparison's screens; they never add a venue or rewrite a cultural score.
 */
export function applyVenueFitPreference(
  candidates: CandidatePlan[],
  result: AdjudicationResult,
  checks: VenueOperationalCheck[],
  hardFailures: Record<string, string[]>,
): { result: AdjudicationResult; preference?: OperationalAudit["preference"] } {
  const byVenue = new Map(checks.map((check) => [key(check.venue), check]));
  const winnerId = result.winnerCandidateId ?? result.evidenceOrder[0] ?? null;
  const winner = candidates.find((candidate) => candidate.candidateId === winnerId);
  const winnerVenue = venueOf(winner);
  if (!winner || !winnerVenue) return { result };
  const against = fitConcerns(byVenue.get(key(winnerVenue)));
  if (!against.length) return { result };
  const better = result.evidenceOrder
    .filter((id) => id !== winner.candidateId && result.candidateIds.includes(id) && !result.eliminated[id] && !hardFailures[id]?.length)
    .map((id) => candidates.find((candidate) => candidate.candidateId === id))
    .find((candidate): candidate is CandidatePlan => {
      const venue = venueOf(candidate);
      if (!candidate || !venue || key(venue) === key(winnerVenue)) return false;
      const check = byVenue.get(key(venue));
      if (!check?.fit || !check.sources.length || check.status === "verified_conflict") return false;
      return fitConcerns(check).length < against.length && keptNamed(candidate) >= keptNamed(winner);
    });
  if (!better) return { result };
  const toVenue = venueOf(better)!;
  const reason = `${winnerVenue}: ${against.join("; ")} (${byVenue.get(key(winnerVenue))!.fit!.note})`;
  return {
    // An undecided comparison stays undecided: the facts only reorder its fallback.
    result: {
      ...result,
      winnerCandidateId: result.verdict === "winner" ? better.candidateId : result.winnerCandidateId,
      evidenceOrder: [better.candidateId, ...result.evidenceOrder.filter((id) => id !== better.candidateId)],
      rationale: `${result.rationale} The cited web facts then favoured ${toVenue} over ${reason}.`.trim(),
      decisiveClaimIds: [...result.decisiveClaimIds, `${winner.candidateId}/event_place/operational`],
    },
    preference: {
      fromCandidateId: winner.candidateId,
      fromVenue: winnerVenue,
      fromSource: winner.sources?.event_place ?? (winner.track === "hybrid" ? undefined : winner.track),
      toCandidateId: better.candidateId,
      toVenue,
      toSource: better.sources?.event_place ?? (better.track === "hybrid" ? undefined : better.track),
      concerns: against,
      note: byVenue.get(key(winnerVenue))!.fit!.note,
      sourceUrl: byVenue.get(key(winnerVenue))!.sources[0]?.url,
    },
  };
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
  const vetoed = preliminary?.plan.components.find((component) => component.slot === "event_place");
  const category = vetoed?.placeCategory?.split(":").at(-1)?.replace(/_/g, " ") ?? null;
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
      fromSource: preliminary?.sources?.event_place ?? (preliminary?.track === "hybrid" ? undefined : preliminary?.track),
      fromQlooCategory: category,
      kind: conflict.conflictKind,
      sourceUrl: conflict.sources.find((source) => source.sourceType === "official")?.url,
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
