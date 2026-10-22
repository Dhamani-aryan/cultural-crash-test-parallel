"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { agentReceipt, briefConstants, buildDecisions, summarizeRun, type AgentReceipt, type RunSummary } from "@/lib/crashtest/explain";
import { STEPS } from "@/lib/crashtest/judge-graph";
import { STOP_LABEL, type RunState, type Slot } from "@/lib/crashtest/types";
import { ParallelRunResult } from "./parallel-result";
import { AuditDetails, ComparisonTable } from "./plan-comparison";

const EARLY = new Set(["user_cancelled", "error", "api_budget_limit", "insufficient_data"]);
const eyebrow = "font-mono text-[10px] uppercase tracking-[0.14em] text-muted";

/** A plain introduction to the three-way comparison. */
export function RunResultHeader({ state, summary }: { state: RunState; summary: RunSummary }) {
  const mode = state.provenance?.mode;
  return (
    <header>
      <p className={eyebrow}>
        {state.marketLabel}
        {mode ? ` · ${mode === "recorded" ? "Recorded run" : "Live run"}` : ""}
      </p>
      <h2 className="mt-2 max-w-2xl text-2xl font-semibold tracking-[-0.035em] text-ink">Here&apos;s how the three plans compare.</h2>
      <p className="mt-2 max-w-2xl text-[15px] leading-6 text-ink-2">
        You specified {summary.userSpecified} of {summary.total} choices. The LLM completed the rest without Qloo. After testing the plan, the agent changed {summary.changed} and kept {summary.retained}.
      </p>
      <p className="mt-3 text-sm text-muted">
        LLM draft: {summary.baselineSupported}/{summary.total} supported &nbsp;→&nbsp; Agent plan: {summary.revisedSupported}/{summary.total} supported
      </p>
    </header>
  );
}

/** The user context every stage shares, shown once rather than as plan choices. */
export function BriefConstants({ state }: { state: RunState }) {
  const constants = briefConstants(state);
  return (
    <section aria-label="Your direction" className="border-l-2 border-ink/20 pl-4 text-sm leading-6 text-ink-2">
      <p className={eyebrow}>Your direction</p>
      <p className="mt-1">
        {constants.map((c, i) => (
          <span key={c.label}>
            {i ? " · " : ""}<span className="text-muted">{c.label}:</span> <span className="text-ink">{c.value}</span>
          </span>
        ))}
      </p>
    </section>
  );
}

/** One quiet run receipt: what the agent did, counted from the recorded run. */
export function RunReceipt({ receipt }: { receipt: AgentReceipt }) {
  return (
    <section aria-label="What the agent did" className="text-sm leading-6 text-ink-2">
      <p className={eyebrow}>What the agent did</p>
      <p className="mt-1 text-ink">{receipt.lines[0]}</p>
      <p>{receipt.lines[1]}</p>
      {receipt.lines[2] && <p className="text-xs text-muted">{receipt.lines[2]}</p>}
    </section>
  );
}

const LOOP = STEPS.slice(1);

/** The agent's method in one line; the graph's replay lights the step it is showing. */
export function AgentLoop({ step }: { step?: number | null }) {
  return (
    <ol aria-label="Agent method" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
      {LOOP.map((s, i) => {
        const on = step === i + 2;
        return (
          <li key={s} className="flex items-center gap-2" aria-current={on ? "step" : undefined}>
            {i > 0 && <span aria-hidden>→</span>}
            <span className={on ? "font-semibold text-accent" : undefined}>{s}</span>
          </li>
        );
      })}
    </ol>
  );
}

export type ResultView = "table" | "graph";

export function ViewSwitch({ view, onChange }: { view: ResultView; onChange: (v: ResultView) => void }) {
  const item = (v: ResultView, label: string) => (
    <button
      type="button"
      aria-pressed={view === v}
      onClick={() => onChange(v)}
      className={`min-h-10 px-4 text-sm font-medium transition-colors ${view === v ? "bg-ink text-bg" : "text-ink-2 hover:bg-panel-2"}`}
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label="Result view" className="inline-flex overflow-hidden rounded-lg border border-line bg-panel">
      {item("table", "Table")}
      {item("graph", "Decision graph")}
    </div>
  );
}

// The graph and Three.js load only when the judge opens the graph.
const JudgeGraphView = dynamic(() => import("./judge-graph-view"), {
  ssr: false,
  loading: () => <p className="py-16 text-center text-sm text-muted">Loading the decision graph…</p>,
});

export function RunResult({ state }: { state: RunState }) {
  if (state.architecture === "parallel") return <ParallelRunResult state={state} />;
  return <SequentialRunResult state={state} />;
}

function SequentialRunResult({ state }: { state: RunState }) {
  const [view, setView] = useState<ResultView>("table");
  const [focus, setFocus] = useState<Slot | null>(null);
  const [step, setStep] = useState<number | null>(null);
  const summary = summarizeRun(state);
  const receipt = agentReceipt(state);
  if (!summary || !receipt)
    return (
      <p className="text-[15px] text-ink-2">
        The run stopped before any choice could be tested{state.stopDetail ? `: ${state.stopDetail}` : "."}
      </p>
    );
  const decisions = buildDecisions(state);
  return (
    <div className="space-y-7 pt-3">
      {state.stopReason && EARLY.has(state.stopReason) && (
        <p className="text-sm text-weak">
          Stopped early: {STOP_LABEL[state.stopReason]}
          {state.stopDetail ? ` (${state.stopDetail})` : ""}. Showing what was tested so far.
        </p>
      )}
      <RunResultHeader state={state} summary={summary} />
      <BriefConstants state={state} />
      <RunReceipt receipt={receipt} />
      <div className="space-y-3">
        <ViewSwitch
          view={view}
          onChange={(v) => {
            setView(v);
            setStep(null);
          }}
        />
        <AgentLoop step={view === "graph" ? step : null} />
      </div>
      {view === "table" ? (
        <ComparisonTable
          decisions={decisions}
          focus={focus}
          onEvidencePath={(slot) => {
            setFocus(slot);
            setView("graph");
          }}
        />
      ) : (
        <JudgeGraphView state={state} decisions={decisions} focus={focus} onFocus={setFocus} onStep={setStep} />
      )}
      <AuditDetails state={state} />
    </div>
  );
}
