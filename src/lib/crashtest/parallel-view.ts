import {
  COMPONENT_STATE_LABEL,
  EVIDENCE_DIMENSION_LABEL,
  SLOTS,
  SLOT_LABEL,
  SOURCE_LABEL,
  TRACK_LABEL,
  type CandidatePlan,
  type ComponentState,
  type EvidenceClaim,
  type ParallelResult,
  type RunState,
  type Slot,
} from "./types";

/**
 * What a judge sees of a parallel run, as data: a deterministic projection of the recorded
 * state, so the table, the summary and the decision path always agree and a replayed state
 * renders identically. No model is called. Unknown evidence is labelled as unknown, never as a
 * failure.
 */

export interface CellView {
  candidateId: string | null;
  label: string;
  /** "Not specified", "Left open", or the component's state for a person. */
  status: string;
  state: ComponentState | "not_specified" | "abstained";
  /** A genuinely equivalent thin-evidence option. The primary plan remains unchanged. */
  alternative?: string;
  note?: string;
}

export interface RowView {
  slot: Slot;
  title: string;
  you: CellView;
  llm: CellView;
  agent: CellView;
  final: CellView & { source: string | null };
  /** Where the final choice is also the user's, LLM's or agent's pick. */
  sameAs: ("you" | "llm" | "agent")[];
  changed: boolean;
  support: ClaimView[];
  counter: ClaimView[];
  uncertain: ClaimView[];
  /** How the other tracks' picks for this slot tested, for the "why this won" comparison. */
  alternatives: { track: string; label: string; status: string }[];
}

export interface ClaimView {
  claimId: string;
  dimension: string;
  text: string;
  source: string;
  decisive: boolean;
  limitations: string[];
  evidenceIds: string[];
}

export interface SummaryView {
  winner: string;
  /** "U", "L", "A" or "H", or null when nothing is recommended. */
  winnerTrack: string | null;
  verdict: string;
  stable: boolean;
  /** The plan shown leads only on the evidence order (no stable blind verdict): for a person to confirm. */
  provisional: boolean;
  /** "Best complete plan", "Provisional plan", or "Insufficient Qloo evidence". */
  headline: string;
  stability: string;
  hardConstraints: { passed: number; total: number };
  coverage: number;
  counts: {
    supported: number;
    thin: number;
    unverified: number;
    needsHuman: number;
    conflicting: number;
  };
  qlooChecks: number;
  modelCalls: number;
  assumptionsToConfirm: number;
  humanChecks: number;
  stress: {
    completed: number;
    preserved: number;
    tied: number;
    reversed: number;
    unavailable: number;
  } | null;
}

export interface PathNode {
  id: string;
  kind: "brief" | "track" | "evidence" | "adjudication" | "hybrid" | "final";
  label: string;
  detail: string;
  state: "neutral" | "supported" | "rejected" | "uncertain" | "accepted";
}

export interface PathEdge {
  source: string;
  target: string;
  relation:
    | "generated"
    | "evidence_for"
    | "supports"
    | "contradicts"
    | "uncertain"
    | "constrained_by"
    | "adjudicated"
    | "challenged"
    | "accepted_after_retest"
    | "rejected_after_retest"
    | "selected";
}

export interface ParallelView {
  summary: SummaryView;
  rows: RowView[];
  path: { nodes: PathNode[]; edges: PathEdge[] };
  initialVerdict: string;
  finalVerdict: string;
}

const TRACK_LETTER = { user: "U", llm: "L", agent: "A", hybrid: "H" } as const;
const WINNER_TEXT = {
  user: "Your plan",
  llm: "The LLM’s plan",
  agent: "The evidence-first agent’s plan",
  hybrid: "A hybrid of the plans",
} as const;
const VERDICT_TEXT = {
  winner: "Winner",
  tie: "Tie",
  unstable: "Unstable",
  insufficient_evidence: "Not enough evidence",
} as const;

const claimView = (c: EvidenceClaim, decisive: Set<string>): ClaimView => ({
  claimId: c.claimId,
  dimension: EVIDENCE_DIMENSION_LABEL[c.dimension],
  text: c.claim,
  source:
    c.source === "entity_metadata"
      ? "Qloo entity data"
      : c.source.startsWith("qloo")
        ? "Qloo evidence"
        : c.source === "logical_rubric"
          ? "Application rule"
          : c.source === "user"
            ? "Your brief"
            : c.source === "constraint"
              ? "User constraint"
              : c.source === "official_source"
                ? "Official venue source"
                : c.source === "human"
                  ? "Human check"
                  : "Stress test",
  decisive: decisive.has(c.claimId),
  limitations: c.limitations,
  evidenceIds: c.evidenceIds,
});

function cell(p: ParallelResult, c: CandidatePlan | undefined, slot: Slot): CellView {
  if (!c) return { candidateId: null, label: "—", status: "Not run", state: "unverified" };
  const comp = c.plan.components.find((x) => x.slot === slot);
  const open = c.open.find((o) => o.slot === slot);
  if (!comp)
    return open?.state === "not_specified"
      ? {
          candidateId: c.candidateId,
          label: "Not specified",
          status: "You left this open",
          state: "not_specified",
        }
      : {
          candidateId: c.candidateId,
          label: "Left open",
          status: "Nothing passed the screens",
          state: "abstained",
          note: open?.reason,
        };
  const st = p.matrix.componentStates[c.candidateId]?.[slot] ?? "unverified";
  return {
    candidateId: c.candidateId,
    label: comp.label,
    status: COMPONENT_STATE_LABEL[st],
    state: st,
  };
}

export function parallelView(state: RunState): ParallelView | null {
  const p = state.parallel;
  if (!p) return null;
  const by = (id: string) => p.candidates.find((c) => c.candidateId === id);
  const U = by("user");
  const L = by("llm");
  const A = by("agent");
  const F = p.verdict.candidateId ? by(p.verdict.candidateId) : undefined;
  const decisive = new Set(p.final.decisiveClaimIds);

  const rows: RowView[] = SLOTS.map((slot) => {
    const you = cell(p, U, slot);
    const llm = cell(p, L, slot);
    const agent = cell(p, A, slot);
    const fin = F
      ? cell(p, F, slot)
      : {
          candidateId: null,
          label: "No recommendation",
          status: "Needs a person",
          state: "unverified" as const,
        };
    // A thin result is not a meaningful winner over another thin result. Keep the selected
    // complete plan as the primary value, but show the other workable choice so a marketer can
    // decide from price, availability and logistics. Rejected or conflicting choices never get
    // this treatment.
    const equivalent = [you, agent].find(
      (choice) =>
        choice.candidateId &&
        choice.label !== fin.label &&
        choice.state === "plausible_thin" &&
        fin.state === "plausible_thin",
    );
    if (equivalent) {
      fin.alternative = equivalent.label;
      fin.status = "Both workable — choose by logistics";
    }
    const source = F?.sources[slot] ? SOURCE_LABEL[F.sources[slot]!] : null;
    const claims = F
      ? p.matrix.claims.filter((c) => c.candidateId === F.candidateId && c.slot === slot)
      : [];
    const sameAs = (["you", "llm", "agent"] as const).filter(
      (k) => ({ you, llm, agent })[k].label === fin.label && fin.candidateId,
    );
    return {
      slot,
      title: SLOT_LABEL[slot],
      you,
      llm,
      agent,
      final: { ...fin, source },
      sameAs: [...sameAs],
      changed: !!F && llm.label !== fin.label,
      support: claims.filter((c) => c.stance === "supports").map((c) => claimView(c, decisive)),
      counter: claims.filter((c) => c.stance === "contradicts").map((c) => claimView(c, decisive)),
      uncertain: claims.filter((c) => c.stance === "unknown").map((c) => claimView(c, decisive)),
      alternatives: [
        { track: TRACK_LABEL.user, ...you },
        { track: TRACK_LABEL.llm, ...llm },
        { track: TRACK_LABEL.agent, ...agent },
      ]
        .filter((x) => x.candidateId && x.state !== "not_specified" && x.label !== fin.label)
        .map((x) => ({ track: x.track, label: x.label, status: x.status })),
    };
  });

  const states = F ? Object.values(p.matrix.componentStates[F.candidateId] ?? {}) : [];
  const supportedCount = states.filter((s) => s === "supported").length;
  // A consistent ordering is not the same as evidential support. Keep the proposed plan visible as
  // a hypothesis, but never present a zero-support winner as a validated recommendation.
  const evidenceInsufficient = !!F && supportedCount === 0;
  const semanticContradictions = F
    ? p.matrix.claims.filter(
        (claim) =>
          claim.candidateId === F.candidateId &&
          claim.stance === "contradicts" &&
          (claim.dimension === "role_fit" || claim.ruleId === "R-neighborhood"),
      )
    : [];
  const hardTotal = state.brief.constraints.filter((c) => c.kind === "hard").length;
  const violations = p.verdict.evaluation?.hardConstraintViolations.length ?? 0;
  const v = p.verdict;
  const audit = p.stability;
  // Recordings from before parallel:v3 don't carry the flag; the same rule applies to them.
  const provisional =
    evidenceInsufficient ||
    semanticContradictions.length > 0 ||
    (v.provisional ?? (!!F && v.decidedBy === "evidence_order"));
  const summary: SummaryView = {
    winner: F ? WINNER_TEXT[F.track] : "No recommendation",
    winnerTrack: F ? TRACK_LETTER[F.track] : null,
    verdict: VERDICT_TEXT[v.verdict],
    stable: v.stable && !evidenceInsufficient && semanticContradictions.length === 0,
    provisional,
    headline: evidenceInsufficient
      ? "Insufficient Qloo evidence"
      : provisional
        ? "Provisional plan"
        : "Best complete plan",
    stability: evidenceInsufficient
      ? "Insufficient evidence: Qloo did not support any choice in this plan. Treat it as a hypothesis for human validation, not a validated recommendation."
      : semanticContradictions.length
        ? `Provisional: the leading plan still has ${semanticContradictions.length} explicit brief contradiction${semanticContradictions.length === 1 ? "" : "s"}. A person must accept that trade-off or revise the plan.`
        : audit?.reversed
          ? `Provisional: ${audit.reversed} evidence stress test${audit.reversed === 1 ? "" : "s"} selected a different finalist; a person should review it before relying on it.`
          : v.stable && audit?.robust
            ? `Stable: all ${audit.completed} recorded stability checks preserved the recommendation.`
            : v.stable && audit
              ? `Stable blind verdict; ${audit.preserved} of ${audit.completed} completed stress tests preserved it${audit.tied ? ` and ${audit.tied} produced a tie` : ""}.`
              : v.stable
                ? "Stable: the same verdict in both blind orders."
                : v.verdict === "unstable"
                  ? `Unstable: the blind verdict changed with the order the plans were shown in.${provisional ? " This plan only leads on the evidence order; a person should review it before relying on it." : ""}`
                  : v.verdict === "tie"
                    ? `Tie: the blind judge found the plans level.${provisional ? " This plan only leads on the evidence order; a person should choose." : ""}`
                    : "No verdict: not enough evidence.",
    // A clarification left open (a delegated conflict, an unresolved identity) names the one check that could change the plan.
    ...(state.clarification?.provisional.length && F
      ? { stability: `Provisional: ${state.clarification.provisional[0]}` }
      : {}),
    hardConstraints: { passed: F ? hardTotal - violations : 0, total: hardTotal },
    coverage: F ? (p.matrix.coverageByCandidate[F.candidateId] ?? 0) : 0,
    counts: {
      supported: supportedCount,
      thin: states.filter((s) => s === "plausible_thin").length,
      unverified: states.filter((s) => s === "unverified").length,
      needsHuman: states.filter((s) => s === "needs_human").length,
      conflicting: states.filter((s) => s === "conflicting").length,
    },
    qlooChecks: state.qlooUsage?.checks ?? state.qlooCallsUsed,
    modelCalls: state.llmCalls,
    assumptionsToConfirm: v.assumptionsIntroduced.length,
    humanChecks: v.humanChecks.length,
    stress: audit
      ? {
          completed: audit.completed,
          preserved: audit.preserved,
          tied: audit.tied,
          reversed: audit.reversed,
          unavailable: audit.unavailable,
        }
      : null,
  };
  return {
    summary,
    rows,
    path: decisionPath(state, p),
    initialVerdict: adjudicationLine(p.initial, p),
    finalVerdict: adjudicationLine(p.final, p),
  };
}

const nameOf = (p: ParallelResult, id: string | null) => {
  const c = id ? p.candidates.find((x) => x.candidateId === id) : undefined;
  return c
    ? c.track === "hybrid"
      ? `Hybrid ${c.candidateId.replace("hybrid-", "#")}`
      : TRACK_LABEL[c.track]
    : "none";
};

function adjudicationLine(r: ParallelResult["initial"], p: ParallelResult): string {
  const out =
    r.verdict === "winner"
      ? `${nameOf(p, r.winnerCandidateId)} won in both blind orders.`
      : `${VERDICT_TEXT[r.verdict]}. ${r.rationale}`;
  const gone = Object.keys(r.eliminated);
  return gone.length
    ? `${out} Removed first for breaking the brief: ${gone.map((id) => nameOf(p, id)).join(", ")}.`
    : out;
}

/** The decision path: three branches from the brief, evidence, adjudication, hybrids and the final verdict. */
function decisionPath(state: RunState, p: ParallelResult): ParallelView["path"] {
  const nodes: PathNode[] = [
    {
      id: "brief",
      kind: "brief",
      label: "Your brief",
      detail: `Frozen as ${p.briefFingerprint}; ${state.brief.constraints.filter((c) => c.kind === "hard").length} hard rule(s)`,
      state: "neutral",
    },
  ];
  const edges: PathEdge[] = [];
  for (const c of p.candidates.filter((x) => x.track !== "hybrid" && !x.parent)) {
    const id = `track:${c.candidateId}`;
    const hard = p.matrix.hardFailures[c.candidateId] ?? [];
    nodes.push({
      id,
      kind: "track",
      label: TRACK_LABEL[c.track],
      detail: `${c.plan.components.length} of ${SLOTS.length} choices; ${c.evaluation?.supported ?? 0} supported${hard.length ? `; breaks: ${hard.join("; ")}` : ""}`,
      state: hard.length ? "rejected" : "neutral",
    });
    edges.push({ source: "brief", target: id, relation: "generated" });
    const claims = p.matrix.claims.filter((x) => x.candidateId === c.candidateId);
    const ev = `evidence:${c.candidateId}`;
    const sup = claims.filter((x) => x.stance === "supports").length;
    const con = claims.filter((x) => x.stance === "contradicts").length;
    const unk = claims.filter((x) => x.stance === "unknown").length;
    nodes.push({
      id: ev,
      kind: "evidence",
      label: `Evidence for ${TRACK_LABEL[c.track]}`,
      detail: `${sup} supporting, ${con} contradicting, ${unk} unknown`,
      state: con ? "uncertain" : "supported",
    });
    edges.push({
      source: ev,
      target: id,
      relation: con ? "contradicts" : sup ? "supports" : "uncertain",
    });
    if (hard.length) edges.push({ source: id, target: "brief", relation: "constrained_by" });
  }
  nodes.push({
    id: "adjudication:initial",
    kind: "adjudication",
    label: "Blind comparison",
    detail: adjudicationLine(p.initial, p),
    state: p.initial.verdict === "winner" ? "supported" : "uncertain",
  });
  for (const c of p.candidates.filter((x) => x.track !== "hybrid" && !x.parent))
    edges.push({
      source: `track:${c.candidateId}`,
      target: "adjudication:initial",
      relation: "adjudicated",
    });
  let last = "adjudication:initial";
  for (const r of p.rounds) {
    for (const a of r.attempts.filter((x) => x.rejectionCode !== "duplicate")) {
      const id = `hybrid:${a.candidateId}`;
      nodes.push({
        id,
        kind: "hybrid",
        label: `${a.kind === "search" ? "Targeted search" : a.kind === "union" ? "Strongest-component hybrid" : "Swap"}${a.slot ? ` · ${SLOT_LABEL[a.slot]}` : ""}`,
        detail: a.reason,
        state: a.accepted ? "accepted" : "rejected",
      });
      edges.push({ source: last, target: id, relation: "challenged" });
      edges.push({
        source: id,
        target: "final",
        relation: a.accepted ? "accepted_after_retest" : "rejected_after_retest",
      });
    }
    if (r.accepted) last = `hybrid:${r.accepted}`;
  }
  const v = p.verdict;
  nodes.push({
    id: "final",
    kind: "final",
    label: v.candidateId ? `Final: ${nameOf(p, v.candidateId)}` : "No recommendation",
    detail: adjudicationLine(p.final, p),
    state: v.stable ? "accepted" : "uncertain",
  });
  edges.push({ source: last, target: "final", relation: "selected" });
  return { nodes, edges };
}

/** The parallel run as a Markdown report, from recorded facts only. */
export function toParallelMarkdown(state: RunState): string {
  const view = parallelView(state);
  const p = state.parallel;
  if (!view || !p)
    return `# Crash test — ${state.marketLabel}\n\nThe run stopped before the plans could be compared.\n`;
  const s = view.summary;
  const lines = [
    `# Crash test — ${state.marketLabel} (parallel)`,
    "",
    `**${s.headline}:** ${s.winner} · ${s.stability}`,
    "",
    `Hard constraints passed: ${s.hardConstraints.passed} of ${s.hardConstraints.total} · Evidence coverage: ${Math.round(s.coverage * 100)}% · Supported ${s.counts.supported}, thin ${s.counts.thin}, unverified ${s.counts.unverified}, needs a person ${s.counts.needsHuman} · Qloo checks ${s.qlooChecks} · Model calls ${s.modelCalls}`,
    "",
    "| Choice | You | LLM | Evidence-first agent | Final verdict |",
    "|---|---|---|---|---|",
    ...view.rows.map(
      (r) =>
        `| ${r.title} | ${r.you.label} | ${r.llm.label} (${r.llm.status}) | ${r.agent.label} (${r.agent.status}) | **${r.final.label}** (${r.final.status}${r.final.source ? `, ${r.final.source.toLowerCase()}` : ""}) |`,
    ),
    "",
    `**First blind comparison:** ${view.initialVerdict}`,
    "",
    `**Final blind comparison:** ${view.finalVerdict}`,
    ...(p.stability
      ? [
          "",
          `**Recommendation stability:** ${p.stability.preserved}/${p.stability.completed} completed checks preserved the recommendation; ${p.stability.tied} tied; ${p.stability.reversed} reversed; ${p.stability.unavailable} unavailable.`,
          ...p.stability.checks.map((c) => `- ${c.label}: ${c.outcome}. ${c.detail}`),
        ]
      : []),
    ...(p.operational
      ? [
          "",
          "## Operational verification",
          ...(p.operational.override
            ? [
                `- The cultural comparison recommended ${p.operational.override.fromVenue}; the operational check found: ${p.operational.override.reason} Final course: ${p.operational.override.toVenue ?? "no venue established"}.`,
              ]
            : []),
          ...p.operational.checks.flatMap((check) => [
            `- **${check.venue} — ${check.status.replaceAll("_", " ")}:** ${check.finding}`,
            ...check.sources.map(
              (source) => `  - [${source.title}](${source.url}) (${source.sourceType})`,
            ),
          ]),
        ]
      : []),
    "",
    "## Why each choice stands",
    ...view.rows.flatMap((r) => [
      "",
      `### ${r.title}: ${r.final.label}`,
      ...r.support.map(
        (c) =>
          `- Supports (${c.dimension}, ${c.source})${c.decisive ? " — decisive" : ""}: ${c.text}`,
      ),
      ...r.counter.map((c) => `- Against (${c.dimension}, ${c.source}): ${c.text}`),
      ...r.uncertain.map((c) => `- Unknown (${c.dimension}): ${c.text}`),
    ]),
    "",
    "## User choices preserved",
    ...(p.verdict.userChoicesPreserved.length
      ? p.verdict.userChoicesPreserved.map(
          (u) =>
            `- ${SLOT_LABEL[u.slot]} "${u.label}"${u.locked ? " (fixed)" : ""}: ${u.preserved ? "kept" : "replaced"}`,
        )
      : ["- You named no choices."]),
    "",
    "## Assumptions introduced",
    ...(p.verdict.assumptionsIntroduced.length
      ? p.verdict.assumptionsIntroduced.map((a) => `- ${a}`)
      : ["- None."]),
    "",
    "## Human checks still required",
    ...(p.verdict.humanChecks.length ? p.verdict.humanChecks.map((h) => `- ${h}`) : ["- None."]),
    "",
    "## Rejected alternatives",
    ...p.verdict.rejectedAlternatives.map(
      (r) => `- ${nameOf(p, r.candidateId)} (${r.candidateId}): ${r.reason}`,
    ),
    "",
    "## Evidence limitations",
    ...p.verdict.evidenceLimitations.map((l) => `- ${l}`),
    "",
    `_Versions: ${state.provenance?.runVersion ?? "?"}; rubric ${p.baseRubricVersion}; ${p.evidenceRubricVersion}; ${p.adjudicationVersion}. Brief ${p.briefFingerprint}._`,
    "",
  ];
  return lines.join("\n");
}
