import { MATERIAL_DELTA } from "./evaluate";
import type { DraftTrial, RepairProposal } from "./repair";
import {
  SLOTS,
  SLOT_LABEL,
  type CandidatePlan,
  type ChallengeFinding,
  type Component,
  type ComponentAssessment,
  type ComponentSource,
  type CulturalPlan,
  type EvidenceMatrix,
  type HybridAttempt,
  type ImprovementRound,
  type LaunchBrief,
  type PlanEvaluation,
  type RejectionCode,
  type Slot,
} from "./types";

/**
 * The bounded challenge-and-improvement loop. After the first adjudication, the incumbent (the
 * winner, or the best plan on the evidence) is challenged from the evidence matrix; hybrids are
 * built from the union of the tracks' components and from targeted Qloo searches for its specific
 * weaknesses. Every hybrid is re-tested as a complete plan and accepted only for a material
 * improvement with no hard regression. It stops after a fixed number of rounds, on convergence
 * (a round accepts nothing), or when the Qloo budget runs out. No open-ended debate.
 */

export const MAX_SWAPS_PER_ROUND = 2;

export interface OptimizerDeps {
  /** Full-plan evaluation (gather evidence, then the deterministic rubric). */
  evaluate(plan: CulturalPlan): Promise<PlanEvaluation>;
  /** Targeted Qloo retrieval for one weak or open slot of the incumbent. */
  search(slot: Slot, incumbent: CandidatePlan): Promise<{ proposals: RepairProposal[]; trials: DraftTrial[] }>;
  /** The evidence matrix over some candidates (for hard failures and challenges). */
  matrix(candidates: CandidatePlan[]): EvidenceMatrix;
  /** A fresh stable candidate ID and blind ID. */
  newIds(): { candidateId: string; blindId: string };
}

export interface OptimizeInput {
  brief: LaunchBrief;
  contenders: CandidatePlan[];
  incumbentId: string;
  maxRounds: number;
  /** Wording the first adjudication had removed, raised as a challenge. */
  flagged?: string[];
}

export interface OptimizeResult {
  rounds: ImprovementRound[];
  incumbent: CandidatePlan;
  /** Every hybrid that was built and evaluated, accepted or not. */
  hybrids: CandidatePlan[];
  trials: DraftTrial[];
  /** "budget": the Qloo budget ran out mid-round; the incumbent is the last accepted plan. */
  stop: "converged" | "round_limit" | "budget";
}

const STATUS_RANK: Record<ComponentAssessment["status"], number> = { constraint_conflict: 0, no_support: 1, unresolved: 1, weak: 2, supported: 3 };
const COVERAGE_RANK = { insufficient: 0, partial: 1, adequate: 2 } as const;

/** A component's standing in its own plan's evaluation, higher is better. */
export function componentRank(a: ComponentAssessment | undefined): number[] {
  if (!a) return [-1];
  return [a.status === "constraint_conflict" ? 0 : 1, a.contradicted ? 0 : 1, STATUS_RANK[a.status], COVERAGE_RANK[a.coverage], a.total ?? 0];
}
/** True when rank x is strictly better than rank y, compared left to right. */
export const rankBetter = (x: number[], y: number[]) => {
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (Math.abs(d) > 1e-9) return d > 0;
  }
  return false;
};

/** Plan-level progress: fewer contradicted choices, then more choices, then more supported, then a material score gain. */
export function planProgress(prev: PlanEvaluation, next: PlanEvaluation): { better: boolean; material: boolean } {
  const k = prev.contradicted - next.contradicted;
  if (k) return { better: k > 0, material: k > 0 };
  const n = next.components.length - prev.components.length;
  if (n) return { better: n > 0, material: n > 0 };
  const s = next.supported - prev.supported;
  if (s) return { better: s > 0, material: s > 0 };
  const d = (next.totalScore ?? 0) - (prev.totalScore ?? 0);
  return { better: d > 0, material: d >= MATERIAL_DELTA };
}

/** The acceptance guard for a hybrid against the incumbent, on two complete-plan evaluations. */
export function judgeHybrid(
  prev: PlanEvaluation,
  next: PlanEvaluation,
  nextHard: string[],
  /** Supporting brief-fit claims (role fit, user intent) before and after: the brief comes before Qloo scores. */
  fit?: { before: number; after: number },
): { accepted: boolean; rejectionCode?: HybridAttempt["rejectionCode"]; retest: NonNullable<HybridAttempt["retest"]> } {
  const lostSupported = prev.components
    .filter((c) => c.status === "supported" && next.components.find((x) => x.slot === c.slot)?.status !== "supported")
    .map((c) => c.slot);
  const retest = {
    supportedBefore: prev.supported,
    supportedAfter: next.supported,
    contradictedBefore: prev.contradicted,
    contradictedAfter: next.contradicted,
    lostSupported,
    violationsBefore: prev.hardConstraintViolations.length,
    violationsAfter: next.hardConstraintViolations.length,
    ...(fit ? { briefFitBefore: fit.before, briefFitAfter: fit.after } : {}),
  };
  let rejectionCode: RejectionCode | "hard_failure" | "brief_fit_lost" | undefined;
  if (nextHard.length) rejectionCode = "hard_failure";
  else if (next.hardConstraintViolations.length > prev.hardConstraintViolations.length) rejectionCode = "constraint_conflict";
  else if (fit && fit.after < fit.before) rejectionCode = "brief_fit_lost";
  else if (lostSupported.length && !(next.contradicted < prev.contradicted)) rejectionCode = "plan_regression";
  else if (!planProgress(prev, next).material) rejectionCode = "no_improvement";
  return { accepted: !rejectionCode, rejectionCode, retest };
}

const REASON: Record<NonNullable<HybridAttempt["rejectionCode"]>, string> = {
  hard_failure: "It breaks a hard rule of the brief.",
  brief_fit_lost: "It loses brief or role fit the incumbent had (a choice you named, or a brand attribute), whatever Qloo says.",
  constraint_conflict: "It breaks more hard constraints than the incumbent.",
  plan_regression: "It costs a supported choice without removing a contradiction.",
  no_improvement: "The complete-plan re-test showed no material improvement.",
  target_not_supported: "The targeted choice didn't become supported.",
  better_candidate_selected: "Another hybrid tested better this round.",
  duplicate: "It is the same plan as one already tested.",
  repeated_plan: "It is a plan already tested.",
  locked: "It would change a choice the brief fixes.",
};

const sig = (p: CulturalPlan) =>
  SLOTS.map((s) => {
    const c = p.components.find((x) => x.slot === s);
    return c ? `${s}=${c.entity?.id ?? c.label.toLowerCase()}|${c.tags.map((t) => t.id).sort().join(",")}` : `${s}=open`;
  }).join(";");

/** The deterministic challenger: what is wrong with the incumbent, from the matrix alone. */
export function challenge(incumbent: CandidatePlan, m: EvidenceMatrix, contenders: CandidatePlan[], flagged: string[] = []): ChallengeFinding[] {
  const id = incumbent.candidateId;
  const out: ChallengeFinding[] = [];
  for (const h of m.hardFailures[id] ?? []) out.push({ kind: "constraint", candidateId: id, detail: h, claimIds: [] });
  const claims = m.claims.filter((c) => c.candidateId === id);
  for (const c of claims.filter((x) => x.stance === "contradicts" && x.dimension === "constraint"))
    out.push({ kind: "constraint", candidateId: id, slot: c.slot, detail: c.claim, claimIds: [c.claimId] });
  const states = m.componentStates[id] ?? {};
  for (const slot of SLOTS) {
    const st = states[slot];
    const comp = incumbent.plan.components.find((c) => c.slot === slot);
    if (!comp) {
      const open = incumbent.open.find((o) => o.slot === slot);
      if (open) out.push({ kind: "weak_evidence", candidateId: id, slot, detail: `${SLOT_LABEL[slot]} is open: ${open.reason}`, claimIds: [] });
      continue;
    }
    if (st === "conflicting" || st === "plausible_thin" || st === "unverified")
      out.push({
        kind: "weak_evidence",
        candidateId: id,
        slot,
        detail: `${SLOT_LABEL[slot]} "${comp.label}" is ${st.replace("_", " ")}.`,
        claimIds: claims.filter((c) => c.slot === slot && c.stance !== "supports").map((c) => c.claimId),
      });
    const incoherent = claims.filter((c) => c.slot === slot && (c.claimId.endsWith("/duplicate") || (c.dimension === "coherence" && c.stance === "contradicts")));
    if (incoherent.length) out.push({ kind: "incoherent", candidateId: id, slot, detail: incoherent[0].claim, claimIds: incoherent.map((c) => c.claimId) });
    const mine = incumbent.evaluation?.components.find((c) => c.slot === slot);
    for (const other of contenders) {
      if (other.candidateId === id) continue;
      const theirs = other.evaluation?.components.find((c) => c.slot === slot);
      const oc = other.plan.components.find((c) => c.slot === slot);
      if (oc && theirs && oc.label !== comp.label && rankBetter(componentRank(theirs), componentRank(mine)))
        out.push({
          kind: "better_alternative",
          candidateId: id,
          slot,
          detail: `"${oc.label}" tested better for the ${SLOT_LABEL[slot].toLowerCase()} in another plan (${theirs.status} vs ${mine?.status ?? "untested"}).`,
          claimIds: m.claims.filter((c) => c.candidateId === other.candidateId && c.slot === slot && c.stance === "supports").map((c) => c.claimId),
          alternativeFrom: other.candidateId,
        });
    }
  }
  for (const f of flagged) out.push({ kind: "unsupported_claim", candidateId: id, detail: `Removed from the verdict: "${f}"`, claimIds: [] });
  return out;
}

/** May the loop change this slot of the incumbent? Locks never; a user's own choice only when the evidence contradicts it (or the user allowed exploring). */
function adjustable(incumbent: CandidatePlan, slot: Slot, brief: LaunchBrief): boolean {
  const comp = incumbent.plan.components.find((c) => c.slot === slot);
  if (brief.constraints.some((c) => c.kind === "hard" && c.lockSlot === slot)) return false;
  if (!comp) return true;
  if (comp.locked) return false;
  if (comp.origin !== "user_provided") return true;
  const a = incumbent.evaluation?.components.find((c) => c.slot === slot);
  return brief.exploreUserChoices || !!a?.contradicted;
}

/** The strongest component per slot across contenders, by its standing in its own evaluated plan. */
export function strongestComponents(contenders: CandidatePlan[], incumbent: CandidatePlan, brief: LaunchBrief) {
  const out = new Map<Slot, { component: Component; source: ComponentSource }>();
  for (const slot of SLOTS) {
    const own = incumbent.plan.components.find((c) => c.slot === slot);
    let best = own ? { component: own, source: incumbent.sources[slot] ?? "agent", rank: componentRank(incumbent.evaluation?.components.find((c) => c.slot === slot)) } : null;
    if (adjustable(incumbent, slot, brief))
      for (const c of contenders) {
        const comp = c.plan.components.find((x) => x.slot === slot);
        if (!comp || comp.locked) continue;
        const rank = componentRank(c.evaluation?.components.find((x) => x.slot === slot));
        if (!best || rankBetter(rank, best.rank)) best = { component: comp, source: c.sources[slot] ?? "agent", rank };
      }
    if (best) out.set(slot, { component: best.component, source: best.source });
  }
  return out;
}

export async function optimize(input: OptimizeInput, deps: OptimizerDeps): Promise<OptimizeResult> {
  const { brief } = input;
  const contenders = input.contenders;
  let incumbent = contenders.find((c) => c.candidateId === input.incumbentId)!;
  const rounds: ImprovementRound[] = [];
  const hybrids: CandidatePlan[] = [];
  const trials: DraftTrial[] = [];
  const seen = new Set(contenders.map((c) => sig(c.plan)));
  const searched = new Set<Slot>();
  let stop: OptimizeResult["stop"] = "round_limit";

  for (let r = 1; r <= input.maxRounds; r++) {
    try {
      const accepted = await runRound(r);
      if (!accepted) {
        stop = "converged";
        break;
      }
    } catch (err) {
      if ((err as Error).name !== "BudgetExceeded") throw err;
      stop = "budget";
      break;
    }
  }
  return { rounds, incumbent, hybrids, trials, stop };

  async function runRound(r: number): Promise<boolean> {
    const matrix = deps.matrix([...contenders, ...hybrids]);
    const challenges = challenge(incumbent, matrix, contenders, r === 1 ? input.flagged : []);
    const round: ImprovementRound = { round: r, incumbent: incumbent.candidateId, challenges, attempts: [] };
    rounds.push(round);

    // Build the round's hybrids: the union of the strongest components, single swaps to a
    // stronger component from another plan, and targeted search for the weakest open or weak slot.
    const built: { plan: CulturalPlan; sources: CandidatePlan["sources"]; kind: HybridAttempt["kind"]; slot?: Slot; reason: string }[] = [];
    const withSlot = (slot: Slot, comp: Component) => {
      const components = SLOTS.flatMap((s) => (s === slot ? [comp] : incumbent.plan.components.filter((c) => c.slot === s)));
      return { ...incumbent.plan, components };
    };
    if (r === 1) {
      const best = strongestComponents(contenders, incumbent, brief);
      const components = SLOTS.flatMap((s) => (best.get(s) ? [best.get(s)!.component] : []));
      built.push({
        plan: { ...incumbent.plan, components },
        sources: Object.fromEntries(SLOTS.flatMap((s) => (best.get(s) ? [[s, best.get(s)!.source]] : []))),
        kind: "union",
        reason: "The strongest tested component for each slot across the plans.",
      });
    }
    const swaps = challenges.filter((c) => c.kind === "better_alternative" && c.slot && adjustable(incumbent, c.slot, brief));
    for (const ch of swaps.slice(0, MAX_SWAPS_PER_ROUND)) {
      const from = contenders.find((c) => c.candidateId === ch.alternativeFrom);
      const comp = from?.plan.components.find((x) => x.slot === ch.slot);
      if (!from || !comp) continue;
      built.push({ plan: withSlot(ch.slot!, comp), sources: { ...incumbent.sources, [ch.slot!]: from.sources[ch.slot!] ?? "agent" }, kind: "swap", slot: ch.slot, reason: ch.detail });
    }
    const target = challenges.find(
      (c) => c.kind !== "better_alternative" && c.kind !== "unsupported_claim" && c.slot && !searched.has(c.slot) && adjustable(incumbent, c.slot, brief),
    );
    if (target?.slot) {
      searched.add(target.slot);
      const found = await deps.search(target.slot, incumbent);
      trials.push(...found.trials);
      for (const p of found.proposals)
        built.push({ plan: withSlot(target.slot, p.after), sources: { ...incumbent.sources, [target.slot]: "search" }, kind: "search", slot: target.slot, reason: `${target.detail} ${p.reason}` });
    }

    // Re-test every new hybrid as a complete plan; keep the best that passes the guard.
    let winner: { cand: CandidatePlan; attempt: HybridAttempt } | null = null;
    for (const b of built) {
      const ids = deps.newIds();
      const base = { candidateId: ids.candidateId, parent: incumbent.candidateId, kind: b.kind, slot: b.slot };
      const key = sig(b.plan);
      if (seen.has(key)) {
        round.attempts.push({ ...base, accepted: false, rejectionCode: "duplicate", reason: REASON.duplicate });
        continue;
      }
      seen.add(key);
      const evaluation = await deps.evaluate(b.plan);
      const cand: CandidatePlan = {
        ...ids,
        track: "hybrid",
        briefFingerprint: incumbent.briefFingerprint,
        plan: b.plan,
        open: incumbent.open.filter((o) => !b.plan.components.some((c) => c.slot === o.slot)),
        sources: b.sources,
        evaluation,
        assumptions: [b.reason],
        parent: incumbent.candidateId,
        provenance: { qlooCalls: 0, llmCalls: 0, ms: 0, generatedAt: new Date().toISOString() },
      };
      hybrids.push(cand);
      const pair = deps.matrix([incumbent, cand]);
      const hard = pair.hardFailures[cand.candidateId] ?? [];
      const fitOf = (id: string) =>
        pair.claims.filter((c) => c.candidateId === id && c.stance === "supports" && (c.dimension === "role_fit" || c.claimId.endsWith("/user-intent"))).length;
      const verdict = judgeHybrid(incumbent.evaluation!, evaluation, hard, { before: fitOf(incumbent.candidateId), after: fitOf(cand.candidateId) });
      const attempt: HybridAttempt = {
        ...base,
        accepted: verdict.accepted,
        rejectionCode: verdict.rejectionCode,
        reason: verdict.accepted ? b.reason : REASON[verdict.rejectionCode!],
        retest: verdict.retest,
      };
      round.attempts.push(attempt);
      if (verdict.accepted && (!winner || planProgress(winner.cand.evaluation!, evaluation).better)) winner = { cand, attempt };
    }
    for (const a of round.attempts)
      if (a.accepted && a !== winner?.attempt) {
        a.accepted = false;
        a.rejectionCode = "better_candidate_selected";
        a.reason = REASON.better_candidate_selected;
      }
    if (!winner) return false;
    round.accepted = winner.cand.candidateId;
    incumbent = winner.cand;
    return true;
  }
}
