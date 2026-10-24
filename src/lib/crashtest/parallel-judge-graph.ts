import { parallelView } from "./parallel-view";
import {
  type JudgeDecisionText,
  type JudgeGraph,
  type JudgeGraphEdge,
  type JudgeGraphNode,
  type JudgeNodeState,
} from "./judge-graph";
import {
  SLOT_LABEL,
  type ComponentState,
  type EvidenceClaim,
  type RunState,
  type Slot,
} from "./types";

/**
 * A judge-facing graph of the parallel run. It is a deterministic projection of the recorded
 * candidates, evidence matrix and verdict: no model is called and no causal claim is invented.
 * The overview stays small; focusing a choice reveals the three independently generated options,
 * their evidence groups, the blind comparison and the selected result.
 */
export function buildParallelJudgeGraph(state: RunState): JudgeGraph {
  const p = state.parallel;
  const view = parallelView(state);
  if (!p || !view) return { nodes: [], edges: [], decisions: [] };

  const nodes: JudgeGraphNode[] = [
    {
      id: "brief",
      kind: "brief",
      label: "Your brief",
      detail: `${state.marketLabel} · ${state.brief.audienceDescription}`,
      evidenceIds: [],
      state: "neutral",
      step: 1,
      overview: true,
    },
    {
      id: "plan",
      kind: "plan",
      label: "Final plan",
      detail: `${view.summary.counts.supported} supported · ${Math.round(view.summary.coverage * 100)}% evidence coverage`,
      evidenceIds: [],
      state: view.summary.provisional ? "uncertain" : "accepted",
      step: 6,
      overview: true,
    },
  ];
  const edges: JudgeGraphEdge[] = [];
  const edge = (
    source: string,
    target: string,
    relation: JudgeGraphEdge["relation"],
    slot: Slot,
    evidenceIds: string[] = [],
    overview = false,
  ) =>
    edges.push({
      id: `${slot}:${source}>${relation}>${target}`,
      source,
      target,
      relation,
      evidenceIds: [...new Set(evidenceIds)],
      overview,
      slot,
    });

  const decisions: JudgeDecisionText[] = [];
  for (const row of view.rows) {
    const slot = row.slot;
    const candidates = [
      { id: "user", cell: row.you, kind: "brief" as const, step: 2 },
      { id: "llm", cell: row.llm, kind: "llm_choice" as const, step: 2 },
      { id: "agent", cell: row.agent, kind: "candidate" as const, step: 2 },
    ];

    for (const candidate of candidates) {
      const id = `${slot}:${candidate.id}`;
      nodes.push({
        id,
        kind: candidate.kind,
        slot,
        label: candidate.cell.label,
        detail: `${candidate.id === "user" ? "Your direction" : candidate.id === "llm" ? "LLM alone" : "Evidence-first agent"} · ${candidate.cell.status}`,
        evidenceIds: [],
        state: componentTone(candidate.cell.state),
        step: candidate.step,
        overview: false,
      });
      edge("brief", id, candidate.id === "user" ? "supplied_by_user" : "generated_independently", slot);

      if (candidate.cell.candidateId) {
        const claims = p.matrix.claims.filter(
          (claim) => claim.candidateId === candidate.cell.candidateId && claim.slot === slot,
        );
        for (const group of groupClaims(claims)) {
          const evidenceId = `${slot}:${candidate.id}:evidence:${group.stance}`;
          nodes.push({
            id: evidenceId,
            kind: group.isQloo ? "qloo_evidence" : "test",
            slot,
            label:
              group.stance === "supports"
                ? "Supporting evidence"
                : group.stance === "contradicts"
                  ? "Counter-evidence"
                  : "Unverified evidence",
            detail: group.detail,
            evidenceIds: group.evidenceIds,
            state:
              group.stance === "supports"
                ? "supported"
                : group.stance === "contradicts"
                  ? "rejected"
                  : "uncertain",
            step: 3,
            overview: false,
          });
          edge(
            evidenceId,
            id,
            group.stance === "supports"
              ? "supports"
              : group.stance === "contradicts"
                ? "did_not_support"
                : "tested_against",
            slot,
            group.evidenceIds,
          );
        }
      }
    }

    const compare = `${slot}:compare`;
    nodes.push({
      id: compare,
      kind: "test",
      slot,
      label: "Blind comparison",
      detail: "The complete plans were judged in both presentation orders against the same evidence matrix.",
      evidenceIds: [],
      state: p.final.verdict === "winner" ? "supported" : "uncertain",
      step: 4,
      overview: false,
    });
    for (const candidate of candidates) edge(`${slot}:${candidate.id}`, compare, "compared_blind", slot);

    const stress = `${slot}:stress`;
    nodes.push({
      id: stress,
      kind: "test",
      slot,
      label: "Stability checks",
      detail: p.stability
        ? `${p.stability.preserved} of ${p.stability.completed} completed checks preserved the final recommendation; ${p.stability.tied} tied and ${p.stability.reversed} reversed.`
        : "No additional stability audit was recorded for this run.",
      evidenceIds: [],
      state: p.stability?.robust ? "supported" : "uncertain",
      step: 5,
      overview: false,
    });
    edge(compare, stress, "tested_against", slot);

    const final = `${slot}:final`;
    const finalEvidence = [...row.support, ...row.counter, ...row.uncertain].flatMap(
      (claim) => claim.evidenceIds,
    );
    nodes.push({
      id: final,
      kind: "final_choice",
      slot,
      label: row.final.label,
      detail: `${SLOT_LABEL[slot]} · ${row.final.source ?? "No source"} · ${row.final.status}`,
      evidenceIds: [...new Set(finalEvidence)],
      state: componentTone(row.final.state),
      step: 6,
      overview: true,
    });
    edge(stress, final, "selected", slot, finalEvidence);
    edge(final, "plan", "part_of", slot, [], true);
    edge("brief", final, "decided_from", slot, [], true);

    const changedAgainst = [
      row.you.label !== row.final.label && row.you.candidateId ? `you (${row.you.label})` : null,
      row.llm.label !== row.final.label && row.llm.candidateId ? `the LLM (${row.llm.label})` : null,
      row.agent.label !== row.final.label && row.agent.candidateId
        ? `the agent's first plan (${row.agent.label})`
        : null,
    ].filter(Boolean);
    decisions.push({
      slot,
      title: SLOT_LABEL[slot],
      changed: changedAgainst.length > 0,
      headline: `${row.final.label} · ${row.final.status.toLowerCase()}`,
      lines: [
        `You: ${row.you.label} · LLM: ${row.llm.label} · Agent: ${row.agent.label}`,
        changedAgainst.length
          ? `Selected over ${changedAgainst.join(" and ")}. Open the evidence nodes to inspect the recorded support and counter-evidence.`
          : "All available directions converged on this choice. Open the evidence nodes to inspect the recorded support and counter-evidence.",
      ],
    });
  }

  return { nodes, edges, decisions };
}

function componentTone(state: ComponentState | "not_specified" | "abstained"): JudgeNodeState {
  if (state === "supported") return "supported";
  if (state === "conflicting" || state === "rejected") return "rejected";
  if (state === "plausible_thin" || state === "unverified" || state === "needs_human")
    return "uncertain";
  return "neutral";
}

function groupClaims(claims: EvidenceClaim[]) {
  return (["supports", "contradicts", "unknown"] as const).flatMap((stance) => {
    const matches = claims.filter((claim) => claim.stance === stance);
    if (!matches.length) return [];
    const sources = [...new Set(matches.map((claim) => claim.source))];
    const evidenceIds = [...new Set(matches.flatMap((claim) => claim.evidenceIds))];
    const excerpts = matches.slice(0, 2).map((claim) => claim.claim);
    return [
      {
        stance,
        isQloo: sources.some((source) => source.startsWith("qloo")),
        evidenceIds,
        detail: `${matches.length} claim${matches.length === 1 ? "" : "s"}: ${excerpts.join(" ")}${matches.length > excerpts.length ? " …" : ""}`,
      },
    ];
  });
}

