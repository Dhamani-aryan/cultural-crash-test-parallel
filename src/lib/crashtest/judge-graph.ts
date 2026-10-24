import { changeOutcome, buildDecisionTrace } from "./decision-trace";
import { buildDecisions, type DecisionExplanation } from "./explain";
import { unverifiableRules } from "./constraints";
import {
  DIMENSION_LABEL,
  SLOT_LABEL,
  STATUS_LABEL,
  type ComponentAssessment,
  type DimensionKey,
  type PlanChange,
  type RunState,
  type Slot,
} from "./types";

/**
 * The decision graph as data: a deterministic projection of the recorded run and of the same
 * DecisionExplanation rows the table shows, so both views reach identical conclusions. No model
 * is called. Every Qloo node cites ledger records, every candidate is a recorded PlanChange,
 * every rejection is a recorded reverted re-test, and rules come only from the confirmed brief.
 * Missing evidence becomes an "uncertain" node, never a failure. Edges name a relationship;
 * none says one thing caused another.
 */

export type JudgeNodeKind = "plan" | "brief" | "llm_choice" | "qloo_evidence" | "candidate" | "test" | "final_choice";
export type JudgeNodeState = "neutral" | "supported" | "rejected" | "uncertain" | "accepted";
export type JudgeRelation =
  | "supplied_by_user"
  | "added_by_llm"
  | "tested_against"
  | "supports"
  | "did_not_support"
  | "constrained_by"
  | "candidate_for"
  | "rejected_after_retest"
  | "accepted_after_retest"
  | "retained"
  | "part_of"
  | "decided_from"
  | "generated_independently"
  | "compared_blind"
  | "selected";

export const RELATION_LABEL: Record<JudgeRelation, string> = {
  supplied_by_user: "supplied by user",
  added_by_llm: "added by LLM",
  tested_against: "tested against",
  supports: "supports",
  did_not_support: "did not support",
  constrained_by: "constrained by",
  candidate_for: "candidate for",
  rejected_after_retest: "rejected after re-test",
  accepted_after_retest: "accepted after re-test",
  retained: "retained",
  part_of: "part of",
  decided_from: "decided from",
  generated_independently: "generated independently",
  compared_blind: "compared in two blind orders",
  selected: "selected",
};

export const KIND_LABEL: Record<JudgeNodeKind, string> = {
  plan: "Final plan",
  brief: "Your brief",
  llm_choice: "LLM choice",
  qloo_evidence: "Qloo evidence",
  candidate: "Candidate tested",
  test: "Application test",
  final_choice: "Final choice",
};

/** The order in which the replay reveals the path; it matches the agent-loop strip. */
export const STEPS = ["Your brief", "Draft without Qloo", "Test every choice", "Search alternatives", "Re-test complete plan", "Keep only improvements"] as const;

export interface JudgeGraphNode {
  id: string;
  kind: JudgeNodeKind;
  slot?: Slot;
  label: string;
  detail?: string;
  evidenceIds: string[];
  state: JudgeNodeState;
  /** 1–6: when the replay reveals it (index into STEPS + 1). */
  step: number;
  /** Shown in the overview; the rest appears only when its decision is focused. */
  overview: boolean;
  /** Candidates only: the recorded change behind it. */
  change?: PlanChange;
}

export interface JudgeGraphEdge {
  id: string;
  source: string;
  target: string;
  relation: JudgeRelation;
  evidenceIds: string[];
  overview: boolean;
  slot?: Slot;
}

export interface JudgeDecisionText {
  slot: Slot;
  title: string;
  changed: boolean;
  headline: string;
  lines: string[];
}

export interface JudgeGraph {
  nodes: JudgeGraphNode[];
  edges: JudgeGraphEdge[];
  decisions: JudgeDecisionText[];
}

const KEYS: DimensionKey[] = ["audience", "local", "coherence"];

export function buildJudgeGraph(state: RunState, decisions: DecisionExplanation[] = buildDecisions(state)): JudgeGraph {
  const first = state.evaluations[0];
  const last = state.evaluations.at(-1);
  if (!first || !last) return { nodes: [], edges: [], decisions: [] };
  const trace = buildDecisionTrace(state);
  const brief = state.brief;
  const ledger = new Set(state.evidenceLedger.map((r) => r.evidenceId));
  const real = (ids: string[]) => [...new Set(ids)].filter((id) => ledger.has(id));
  const unverifiable = new Set(unverifiableRules(brief.constraints));
  const hard = brief.constraints.filter((c) => c.kind === "hard");

  const nodes: JudgeGraphNode[] = [];
  const edges: JudgeGraphEdge[] = [];
  const edge = (source: string, target: string, relation: JudgeRelation, slot?: Slot, evidenceIds: string[] = [], overview = false) =>
    edges.push({ id: `${source}>${relation}>${target}`, source, target, relation, evidenceIds, overview, slot });

  nodes.push(
    { id: "brief", kind: "brief", label: "Your brief", detail: `${state.marketLabel} · ${brief.audienceDescription}`, evidenceIds: [], state: "neutral", step: 1, overview: true },
    { id: "plan", kind: "plan", label: "Final plan", detail: `${last.supported} of ${last.components.length} choices supported`, evidenceIds: [], state: "neutral", step: 6, overview: true },
  );

  const evidenceNodes = (a: ComponentAssessment, slot: Slot, target: string, prefix: string, step: number, which: DimensionKey[]) => {
    for (const key of which) {
      const d = a.dimensions.find((x) => x.key === key);
      const ids = real(d?.evidenceIds ?? []);
      if (!d || !ids.length) continue;
      const supported = d.score !== undefined && d.score >= 0.6;
      const id = `${slot}:${prefix}:${key}`;
      nodes.push({
        id,
        kind: "qloo_evidence",
        slot,
        label: DIMENSION_LABEL[key],
        detail: d.explanation,
        evidenceIds: ids,
        state: supported ? "supported" : "uncertain",
        step,
        overview: false,
      });
      edge(id, target, supported ? "supports" : "did_not_support", slot, ids);
    }
  };

  for (const d of decisions) {
    const s = d.slot;
    const b = first.components.find((c) => c.slot === s)!;
    const a = last.components.find((c) => c.slot === s)!;
    const user = `${s}:user`;
    const llm = `${s}:llm`;
    const final = `${s}:final`;
    const retest = `${s}:retest`;

    nodes.push({
      id: user,
      kind: "brief",
      slot: s,
      label: d.userChoice?.label ?? "Open slot",
      detail: d.userChoice ? (d.userChoice.locked ? "Your choice · fixed" : "Your choice") : "You left this open",
      evidenceIds: [],
      state: "neutral",
      step: 1,
      overview: false,
    });
    edge(user, "brief", "part_of", s);

    nodes.push({
      id: llm,
      kind: "llm_choice",
      slot: s,
      label: d.baseline.label,
      detail: `${d.baseline.origin === "user_provided" ? "Carried forward from you" : "Added by the LLM"} · ${STATUS_LABEL[d.baseline.status]}`,
      evidenceIds: [],
      // Colour follows the evidence: a replaced choice is amber only if its own test came back thin or contradicted.
      state: d.baseline.status === "supported" ? "supported" : d.changed ? "rejected" : "uncertain",
      step: 2,
      overview: false,
    });
    edge(user, llm, d.userChoice ? "supplied_by_user" : "added_by_llm", s);

    // What Qloo said about the LLM-completed choice.
    evidenceNodes(b, s, llm, "q", 3, KEYS);
    if (b.status === "unresolved" && !b.dimensions.some((x) => real(x.evidenceIds).length)) {
      nodes.push({ id: `${s}:lookup`, kind: "test", slot: s, label: "Qloo lookup", detail: "Qloo could not verify this choice. That is missing evidence, not evidence against it.", evidenceIds: [], state: "uncertain", step: 3, overview: false });
      edge(`${s}:lookup`, llm, "tested_against", s);
    }

    // Rules from the confirmed brief, attached where they constrained this decision.
    const lock = hard.find((c) => c.lockSlot === s);
    if (lock) {
      nodes.push({ id: `${s}:lock`, kind: "brief", slot: s, label: "Fixed in your brief", detail: lock.description, evidenceIds: [], state: "neutral", step: 1, overview: false });
      edge(llm, `${s}:lock`, "constrained_by", s);
    }

    const tried = trace.find((t) => t.slot === s)!.changes;
    if (tried.length) {
      nodes.push({
        id: retest,
        kind: "test",
        slot: s,
        label: "Full-plan re-test",
        detail: d.changed ? `${STATUS_LABEL[d.baseline.status]} → ${STATUS_LABEL[d.revised.status]}` : "No candidate improved the plan",
        evidenceIds: real(a.dimensions.flatMap((x) => x.evidenceIds)),
        state: "neutral",
        step: 5,
        overview: false,
      });
      tried.forEach((c, i) => {
        const id = `${s}:candidate:${i}`;
        const accepted = c === d.acceptedChange;
        nodes.push({
          id,
          kind: "candidate",
          slot: s,
          label: c.after,
          detail: accepted || c.reverted ? changeOutcome(c) : "Kept for a round, then replaced by a later repair.",
          evidenceIds: real(c.triggeringEvidenceIds),
          state: c.reverted ? "rejected" : accepted ? "accepted" : "neutral",
          step: 4,
          overview: false,
          change: c,
        });
        edge(id, llm, "candidate_for", s);
        edge(id, retest, "tested_against", s, real(c.triggeringEvidenceIds));
        if (c.reverted) edge(retest, id, "rejected_after_retest", s);
      });
      for (const c of hard.filter((x) => !x.lockSlot)) {
        const id = `${s}:rule:${c.id}`;
        nodes.push({ id, kind: "brief", slot: s, label: "Your rule", detail: c.description, evidenceIds: [], state: "neutral", step: 1, overview: false });
        edge(retest, id, "constrained_by", s);
      }
    } else if (d.reasonCodes.includes("user_rule_unverified")) {
      for (const c of hard.filter((x) => unverifiable.has(x.description))) {
        const id = `${s}:rule:${c.id}`;
        nodes.push({ id, kind: "brief", slot: s, label: "Your rule", detail: `${c.description} (code can't fully check it)`, evidenceIds: [], state: "uncertain", step: 1, overview: false });
        edge(llm, id, "constrained_by", s);
      }
    }

    nodes.push({
      id: final,
      kind: "final_choice",
      slot: s,
      label: d.revised.label,
      detail: `${SLOT_LABEL[s]} · ${d.changed ? "Changed by the agent" : "Kept by the agent"} · ${STATUS_LABEL[d.revised.status]}`,
      evidenceIds: [],
      // Green only when the final choice tested Supported; a change never earns it on its own.
      state: d.revised.status !== "supported" ? "uncertain" : d.changed ? "accepted" : "supported",
      step: 6,
      overview: true,
    });
    if (d.changed && d.acceptedChange) {
      edge(retest, final, "accepted_after_retest", s);
      // Why the replacement holds: its own Qloo results.
      evidenceNodes(a, s, final, "qf", 5, ["audience", "local"]);
    } else if (d.changed) {
      edge(llm, final, "candidate_for", s);
    } else {
      edge(llm, final, "retained", s);
    }
    edge("brief", final, "decided_from", s, [], true);
    edge(final, "plan", "part_of", s, [], true);
  }

  return {
    nodes,
    edges,
    decisions: decisions.map((d) => ({
      slot: d.slot,
      title: SLOT_LABEL[d.slot],
      changed: d.changed,
      headline: d.changed ? `${d.baseline.label} → ${d.revised.label}` : `${d.revised.label} · kept`,
      lines: d.changed ? [d.whyAway[0] ?? d.summaryReason, d.whyToward.join(" ")] : [d.whyStayed.join(" ")],
    })),
  };
}

/** The nodes and edges visible for an overview (slot undefined) or one focused decision. */
export function visibleGraph(g: JudgeGraph, slot?: Slot) {
  const nodes = g.nodes.filter((n) => n.overview || (slot && n.slot === slot));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = g.edges.filter(
    (e) => ids.has(e.source) && ids.has(e.target) && (slot ? e.slot === slot && !(e.relation === "decided_from") : e.overview),
  );
  // In focus, the other decisions keep only their link to the plan.
  if (slot) for (const e of g.edges) if (e.relation === "part_of" && e.target === "plan" && e.slot !== slot) edges.push(e);
  return { nodes, edges };
}

/** The relationship that best says what a node did on the path, by node kind. */
const PATH_RELATION: Record<JudgeNodeKind, JudgeRelation[]> = {
  brief: ["supplied_by_user", "added_by_llm", "generated_independently", "constrained_by"],
  llm_choice: ["generated_independently", "supplied_by_user", "added_by_llm"],
  qloo_evidence: ["supports", "did_not_support"],
  candidate: ["generated_independently", "rejected_after_retest", "tested_against"],
  test: ["compared_blind", "accepted_after_retest", "tested_against"],
  final_choice: ["selected", "accepted_after_retest", "retained"],
  plan: [],
};

/** One decision's path as text, in replay order: the accessible and no-WebGL view. */
export function pathText(g: JudgeGraph, slot: Slot): { id: string; kind: JudgeNodeKind; text: string; inspectable: boolean }[] {
  const { nodes, edges } = visibleGraph(g, slot);
  return nodes
    .filter((n) => n.slot === slot)
    .sort((x, y) => x.step - y.step)
    .map((n) => {
      const touching = edges.filter((e) => e.source === n.id || e.target === n.id);
      const rel = PATH_RELATION[n.kind].map((r) => touching.find((e) => e.relation === r)).find(Boolean);
      const how = rel ? ` (${RELATION_LABEL[rel.relation]})` : "";
      return {
        id: n.id,
        kind: n.kind,
        text: `${KIND_LABEL[n.kind]}${how}: ${n.label}${n.detail ? ` — ${n.detail}` : ""}`,
        inspectable: n.kind === "qloo_evidence" || n.kind === "candidate",
      };
    });
}

/** A plain tree for review and fixtures: every node with its outgoing relationships. */
export function graphAsTree(g: JudgeGraph): string {
  const lines: string[] = [];
  const out = (id: string) => g.edges.filter((e) => e.source === id);
  const show = (id: string) => {
    const n = g.nodes.find((x) => x.id === id)!;
    return `${n.label} [${n.kind}, ${n.state}${n.evidenceIds.length ? `, evidence ${n.evidenceIds.join(" ")}` : ""}]`;
  };
  for (const n of [...g.nodes].sort((a, b) => (a.slot ?? "").localeCompare(b.slot ?? "") || a.step - b.step)) {
    lines.push(`${n.slot ? `${SLOT_LABEL[n.slot]} / ` : ""}${show(n.id)}`);
    for (const e of out(n.id)) lines.push(`    --${RELATION_LABEL[e.relation]}--> ${show(e.target)}`);
  }
  return lines.join("\n") + "\n";
}
