import type { LlmClient } from "@/lib/llm/types";
import { OUTCOME_LABEL, comparePlans } from "./compare";
import { toParallelMarkdown } from "./parallel-view";
import {
  DIMENSION_LABEL,
  SLOT_LABEL,
  STATUS_LABEL,
  STOP_LABEL,
  WEIGHTS,
  type CulturalPlan,
  type PlanEvaluation,
  type RunState,
} from "./types";

/**
 * The report is rendered from the recorded run state. The model writes only the short verdict,
 * from a summary of that state, and is told it may not add anything the state doesn't hold.
 */

export const DISCLAIMER =
  "This assessment compares a plan against available cultural-affinity signals. It is not a sales forecast or a guarantee of campaign performance.";

const pct = (x: number | undefined) => (x === undefined ? "n/a" : `${Math.round(x * 100)}`);

export function finalEvaluation(state: RunState): PlanEvaluation | undefined {
  return state.evaluations.at(-1);
}

function facts(state: RunState): string {
  const first = state.evaluations[0];
  const last = finalEvaluation(state);
  const lines = [
    `City: ${state.marketLabel}. Audience anchors: ${state.plan?.anchors.map((a) => a.name).join(", ") || "none"}.`,
    `Stop: ${state.stopReason ? STOP_LABEL[state.stopReason] : "unknown"}${state.stopDetail ? ` (${state.stopDetail})` : ""}.`,
    `Supported choices ${first?.supported ?? 0}/${first?.components.length ?? 0} → ${last?.supported ?? 0}/${last?.components.length ?? 0}. Plan score ${pct(first?.totalScore)} → ${pct(last?.totalScore)} (app-defined, 0-100, over the choices that have a score).`,
    ...(last?.components ?? []).map((c) => `Final ${SLOT_LABEL[c.slot]} "${c.label}": ${STATUS_LABEL[c.status]}. ${c.finding}`),
    ...state.changes.map(
      (c) => `Change ${c.iteration}: ${SLOT_LABEL[c.slot]} ${c.before} → ${c.after}${c.reverted ? " (reverted: re-test came out worse)" : ""}. ${c.observedEffect ?? ""}`,
    ),
    ...state.unresolvedQuestions.map((q) => `Open: ${q}`),
  ];
  return lines.join("\n");
}

export async function writeVerdict(llm: LlmClient, state: RunState): Promise<string> {
  const reply = await llm.generateText({
    system:
      "Write a 2-3 sentence executive verdict on a launch plan's cultural choices: the strongest part, the weakest part, and what changed. Use only the facts given; do not add names, numbers or claims. Never call the score a probability or a forecast. Plain prose, no lists.",
    prompt: facts(state),
  });
  return reply.text.trim();
}

function planTable(plan: CulturalPlan | null): string {
  if (!plan) return "_No plan._\n";
  const rows = plan.components.map(
    (c) =>
      `| ${SLOT_LABEL[c.slot]} | ${c.label}${c.tags.length ? ` (${c.tags.map((t) => t.name).join(", ")})` : ""} | ${c.origin.replace("_", " ")}${c.locked ? ", locked" : ""} | ${c.resolution} |`,
  );
  return ["| Slot | Choice | Source | Qloo |", "|---|---|---|---|", ...rows].join("\n") + "\n";
}

export function toMarkdown(state: RunState): string {
  if (state.architecture === "parallel") return toParallelMarkdown(state);
  const last = finalEvaluation(state);
  const first = state.evaluations[0];
  const ledger = new Map(state.evidenceLedger.map((r) => [r.evidenceId, r]));
  const out: string[] = [];
  out.push(`# Cultural Crash-Test: ${state.brief.brandName || state.brief.productCategory} in ${state.marketLabel}`, "");
  out.push(`_Run ${state.runId}, ${state.startedAt}. Rubric ${last?.rubricVersion ?? "n/a"}._`, "");
  out.push(`> ${DISCLAIMER}`, "");
  if (state.verdict) out.push("## Verdict", "", state.verdict, "", "_Written by the model from the recorded evidence below._", "");
  out.push(
    "## Outcome",
    "",
    `- **Stopped:** ${state.stopReason ? STOP_LABEL[state.stopReason] : "unknown"}${state.stopDetail ? `: ${state.stopDetail}` : ""}`,
    `- **Explore alternatives to your own choices:** ${state.brief.exploreUserChoices ? "on" : "off"}`,
    `- **Fixed (locked) choices:** ${state.brief.constraints.filter((c) => c.lockSlot).map((c) => c.description).join("; ") || "none"}`,
    `- **Supported choices:** ${first?.supported ?? 0} of ${first?.components.length ?? 0} → ${last?.supported ?? 0} of ${last?.components.length ?? 0}`,
    `- **Plan score (app-defined, 0–100, over choices that have a score):** ${pct(first?.totalScore)} → ${pct(last?.totalScore)}`,
    `- **Repair rounds:** ${state.currentIteration} of ${state.maxIterations}; **Qloo calls:** ${state.qlooCallsUsed} of ${state.maxQlooCalls}; **model calls:** ${state.llmCalls}`,
    "",
  );
  const cmp = comparePlans(state);
  if (cmp) {
    out.push("## Compare plans", "", `**${OUTCOME_LABEL[cmp.outcome]}.** ${cmp.headline}`, "");
    out.push("| Choice | LLM alone | Agent | Better supported | Evidence |", "|---|---|---|---|---|");
    for (const c of cmp.componentComparisons)
      out.push(`| ${SLOT_LABEL[c.slot]} | ${c.baselineChoice} | ${c.agentChoice} | ${OUTCOME_LABEL[c.outcome]} | ${c.evidenceIds.join(", ")} |`);
    out.push("", `_${cmp.coverageCaveat} Decided by code from the recorded evaluations (rule: ${cmp.decidedBy.replace("_", " ")})._`, "");
  }
  out.push("## Original plan (the model's first draft, no Qloo)", "", planTable(state.initialPlan));
  out.push("## Final plan", "", planTable(state.plan));
  out.push("## Component assessments", "");
  for (const c of last?.components ?? []) {
    out.push(`### ${SLOT_LABEL[c.slot]}: ${c.label} — ${STATUS_LABEL[c.status]}`, "");
    out.push(`Score ${pct(c.total)}, coverage ${c.coverage}. ${c.finding}`, "");
    for (const d of c.dimensions)
      out.push(
        `- **${DIMENSION_LABEL[d.key]}** (weight ${Math.round(d.weight * 100)}%): ${d.score === undefined ? "no evidence" : pct(d.score)}. ${d.explanation}${d.heuristic ? " _(app heuristic)_" : ""}${d.evidenceIds.length ? ` [${d.evidenceIds.join(", ")}]` : ""}`,
      );
    out.push("");
  }
  out.push("## Revision log", "");
  if (!state.changes.length) out.push("No changes were made.", "");
  for (const c of state.changes) {
    out.push(
      `${c.iteration}. **${SLOT_LABEL[c.slot]}: ${c.before} → ${c.after}**${c.reverted ? " _(reverted)_" : ""}`,
      `   - Why: ${c.reason}`,
      `   - Expected: ${c.expectedEffect}`,
      `   - Observed: ${c.observedEffect ?? "n/a"}`,
      `   - Evidence: ${c.triggeringEvidenceIds.join(", ")}`,
    );
  }
  out.push("");
  if (state.assumptions.length || state.unresolvedQuestions.length) {
    out.push("## Assumptions and open questions", "");
    for (const a of state.assumptions) out.push(`- Assumed: ${a}`);
    for (const q of state.unresolvedQuestions) out.push(`- Open: ${q}`);
    out.push("");
  }
  out.push(
    "## Next steps for a human",
    "",
    "- Check availability, fees and brand fit with the shortlisted artist, brand and venue directly.",
    `- Test the creative direction with a few people from the audience in ${state.marketLabel}.`,
    "- Treat any component with partial coverage as a hypothesis, not a finding.",
    "",
  );
  out.push(
    "## How the score is built",
    "",
    `Each choice is scored on ${Object.entries(WEIGHTS)
      .map(([k, w]) => `${DIMENSION_LABEL[k as keyof typeof WEIGHTS].toLowerCase()} (${Math.round(w * 100)}%)`)
      .join(", ")}. Dimensions without evidence are left out and the weights renormalise; coverage is shown separately. Affinity is Qloo's, ranks are positions in Qloo result lists, and the combination is this app's own. A choice is *Supported* when its score, audience affinity and local relevance are all at least 60.`,
    "",
  );
  out.push("## Evidence ledger", "");
  for (const r of ledger.values()) {
    out.push(
      `- **${r.evidenceId}** (round ${r.iteration}, ${r.coverageStatus}): ${r.purpose}. ${r.resultCount} results` +
        (r.results.length ? `; top: ${r.results.slice(0, 5).map((x) => x.name).join(", ")}` : "") +
        `. Request: \`${JSON.stringify(r.sanitizedRequest)}\`` +
        (r.warnings.length ? ` Warnings: ${r.warnings.join(" ")}` : ""),
    );
  }
  out.push("", "Data: [Qloo](https://www.qloo.com/) Taste AI. Results summarised; raw responses are not stored.", "");
  return out.join("\n");
}
