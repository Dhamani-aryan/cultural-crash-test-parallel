"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildDecisionTrace, decisionDetails } from "@/lib/crashtest/decision-trace";
import type { DecisionExplanation } from "@/lib/crashtest/explain";
import { buildJudgeGraph, KIND_LABEL, pathText, type JudgeGraphNode, type JudgeNodeKind } from "@/lib/crashtest/judge-graph";
import { buildParallelJudgeGraph } from "@/lib/crashtest/parallel-judge-graph";
import { layoutGraph } from "@/lib/crashtest/judge-layout";
import { buildReplay, stepChanges } from "@/lib/crashtest/judge-replay";
import type { RunState, Slot } from "@/lib/crashtest/types";

/**
 * The decision graph view. Above the canvas: the decisions and a toolbar. Below it: the legend,
 * then Decision details (the recorded process for the focused choice) and the Decision trace
 * (every step in order). The trace and details are the keyboard route and the no-WebGL view.
 * Nothing here calls Qloo or a model; it reads the recorded run.
 */

const Scene = dynamic(() => import("./judge-graph-scene"), { ssr: false });

/** Runs whose graph has already played its one-time replay in this tab. */
const played = new Set<string>();

function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

const prefersReduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Shape icons for the legend and the trace; they match the 3D shapes. */
export function KindIcon({ kind, className = "" }: { kind: JudgeNodeKind; className?: string }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.4 };
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden className={className}>
      {kind === "brief" && <rect x="3.5" y="3.5" width="9" height="9" {...common} />}
      {kind === "llm_choice" && <circle cx="8" cy="8" r="4.5" fill="currentColor" />}
      {kind === "qloo_evidence" && <rect x="2" y="5.5" width="12" height="5" rx="2.5" fill="currentColor" />}
      {kind === "candidate" && <circle cx="8" cy="8" r="4.5" {...common} />}
      {kind === "test" && <path d="M8 2.5 13.5 8 8 13.5 2.5 8Z" {...common} />}
      {(kind === "final_choice" || kind === "plan") && (
        <>
          <circle cx="8" cy="8" r="3" fill="currentColor" />
          <circle cx="8" cy="8" r="6" {...common} strokeWidth={1} />
        </>
      )}
    </svg>
  );
}

const LEGEND: JudgeNodeKind[] = ["brief", "llm_choice", "qloo_evidence", "candidate", "test", "final_choice"];
const label = "font-mono text-[10px] uppercase tracking-[0.11em] text-muted";

/** The recorded Qloo queries behind a node: what was asked, what came back, how complete it was. */
function EvidenceRecords({ node, state }: { node: JudgeGraphNode; state: RunState }) {
  const records = node.evidenceIds.map((id) => state.evidenceLedger.find((r) => r.evidenceId === id)).filter((r) => !!r);
  if (!records.length) return null;
  const source = state.provenance?.mode === "recorded" ? "Recorded Qloo result" : state.provenance?.mode === "live" ? "Live Qloo result" : "Qloo result";
  return (
    <ul className="space-y-3">
      {records.map((r) => (
        <li key={r.evidenceId}>
          <dl className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-0.5 text-[13px] leading-5">
            <dt className="text-muted">Query</dt>
            <dd className="text-ink">{r.purpose}</dd>
            <dt className="text-muted">Returned</dt>
            <dd className="text-ink-2">
              {r.resultCount} result{r.resultCount === 1 ? "" : "s"}
              {r.results.length ? `: ${r.results.slice(0, 5).map((x) => x.name).join(", ")}` : ""}
            </dd>
            <dt className="text-muted">Context</dt>
            <dd className="text-ink-2">
              {state.marketLabel} · {state.brief.audienceDescription}
            </dd>
            <dt className="text-muted">Coverage</dt>
            <dd className="text-ink-2">{r.coverageStatus}</dd>
            <dt className="text-muted">Source</dt>
            <dd className="text-ink-2">{source}</dd>
          </dl>
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-muted">Technical details</summary>
            <p className="mt-1 font-mono text-[11px] text-muted">{r.evidenceId}</p>
            <code className="block break-all text-[11px] text-muted">{JSON.stringify(r.sanitizedRequest).slice(0, 400)}</code>
          </details>
        </li>
      ))}
    </ul>
  );
}

export default function JudgeGraphView({
  state,
  decisions = [],
  focus,
  onFocus,
  onStep,
}: {
  state: RunState;
  decisions?: DecisionExplanation[];
  focus: Slot | null;
  onFocus: (slot: Slot | null) => void;
  onStep: (step: number | null) => void;
}) {
  const graph = useMemo(
    () =>
      state.architecture === "parallel"
        ? buildParallelJudgeGraph(state)
        : buildJudgeGraph(state, decisions),
    [state, decisions],
  );
  const trace = useMemo(
    () => (state.architecture === "parallel" ? [] : buildDecisionTrace(state)),
    [state],
  );
  // A narrow canvas (a phone) lays the graph out top to bottom, so labels have room.
  const frame = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const measure = () => setNarrow(el.clientWidth < 640);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const layout = useMemo(() => layoutGraph(graph, focus, { narrow }), [graph, focus, narrow]);
  const timeline = useMemo(() => buildReplay(graph, focus), [graph, focus]);
  const [webgl] = useState(hasWebGL);
  const [reduced] = useState(prefersReduced);
  const [selected, setSelected] = useState<string | null>(null);
  const [fitKey, setFitKey] = useState(0);
  const [replayStart, setReplayStart] = useState<number | null>(null);
  const detailsHeading = useRef<HTMLHeadingElement>(null);
  const runId = state.runId;

  // The first time this run's graph opens in this tab, the path plays once.
  useEffect(() => {
    if (played.has(runId) || reduced || !webgl) return;
    const t = window.setTimeout(() => {
      played.add(runId);
      setReplayStart(performance.now());
    }, 120);
    return () => window.clearTimeout(t);
  }, [runId, reduced, webgl]);

  // While a replay runs, light each method step as it starts; then clear and finish.
  useEffect(() => {
    if (replayStart === null) return;
    const elapsed = performance.now() - replayStart;
    const timers = stepChanges(timeline).map((s) => window.setTimeout(() => onStep(s.step), Math.max(0, s.at - elapsed)));
    timers.push(
      window.setTimeout(() => {
        onStep(null);
        setReplayStart(null);
      }, timeline.duration - elapsed + 400),
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [replayStart, timeline, onStep]);

  const stopReplay = () => {
    setReplayStart(null);
    onStep(null);
  };
  const select = (slot: Slot | null) => {
    setSelected(null);
    stopReplay();
    onFocus(slot);
  };
  /** Select a node in the graph and bring Decision details into view, with keyboard focus on them. */
  const pick = (id: string) => {
    setSelected(id === selected ? null : id);
    window.requestAnimationFrame(() => {
      const h = detailsHeading.current;
      if (!h) return;
      const r = h.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) h.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
      h.focus({ preventScroll: true });
    });
  };

  const text = focus ? graph.decisions.find((d) => d.slot === focus) : undefined;
  const entry = focus ? trace.find((t) => t.slot === focus) : undefined;
  const nodeFor = (name: string, iteration: number) =>
    graph.nodes.find((n) => n.kind === "candidate" && n.slot === focus && n.change?.after === name && n.change.iteration === iteration)?.id;
  const fields = entry
    ? decisionDetails(entry, nodeFor)
    : state.architecture === "parallel" && text
      ? [
          { label: "Final choice", value: text.headline },
          { label: "Compared", value: text.lines[0] ?? "—" },
          { label: "Decision", value: text.lines[1] ?? "—" },
        ]
      : [];
  const path = focus ? pathText(graph, focus) : [];
  const selectedNode = selected ? graph.nodes.find((n) => n.id === selected) : undefined;
  const interactive = (id: string) => {
    const n = graph.nodes.find((x) => x.id === id);
    return !!n && (n.kind === "candidate" || n.evidenceIds.length > 0);
  };
  const btn = "min-h-11 rounded-md px-3 text-xs font-medium";
  const tab = (on: boolean) => `${btn} border ${on ? "border-ink bg-ink text-bg" : "border-line text-ink-2 hover:bg-panel-2"}`;
  const running = replayStart !== null;

  return (
    <section aria-label="Decision graph" className="space-y-4">
      <div role="group" aria-label="Choose a decision" className="flex flex-wrap gap-1.5">
        <button type="button" aria-pressed={!focus} onClick={() => select(null)} className={tab(!focus)}>
          Overview
        </button>
        {graph.decisions.map((d) => (
          <button key={d.slot} type="button" aria-pressed={focus === d.slot} onClick={() => select(d.slot)} className={tab(focus === d.slot)}>
            {d.title}
            {d.changed ? " · changed" : ""}
          </button>
        ))}
      </div>

      {text ? (
        <div aria-live="polite" className="text-sm">
          <p className={label}>{text.title}</p>
          <p className="mt-1 text-base font-semibold text-ink">{text.headline}</p>
          {text.lines.map((l, i) => (
            <p key={i} className="mt-1 max-w-3xl leading-6 text-ink-2">
              {l}
            </p>
          ))}
        </div>
      ) : (
        <ul aria-live="polite" className="space-y-0.5 text-sm">
          {graph.decisions.map((d) => (
            <li key={d.slot} className="text-ink-2">
              <span className="text-muted">{d.title}:</span> <span className="text-ink">{d.headline}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap justify-end gap-1.5">
        {webgl && (
          <button type="button" onClick={() => setFitKey((k) => k + 1)} className={`${btn} border border-line text-ink-2 hover:bg-panel-2`}>
            Fit graph
          </button>
        )}
        {webgl && !reduced && (
          <button
            type="button"
            onClick={() => {
              if (running) return stopReplay();
              setSelected(null);
              onStep(null);
              setReplayStart(performance.now());
            }}
            className={`${btn} bg-ink text-bg hover:bg-ink-2`}
          >
            {running ? "Stop replay" : "Replay decision path"}
          </button>
        )}
      </div>

      <div ref={frame} className="h-[540px] overflow-hidden rounded-xl border border-line bg-[#141619] sm:h-[480px]">
        {webgl ? (
          <Scene
            graph={graph}
            layout={layout}
            focus={focus}
            timeline={timeline}
            replayStart={replayStart}
            reduced={reduced}
            selected={selected}
            fitKey={fitKey}
            onSelect={(n) => {
              if (n.kind === "final_choice" && n.slot && n.slot !== focus) select(n.slot);
              else if ((n.kind === "plan" || n.id === "brief") && focus) select(null);
              else if (n.slot === focus && focus) pick(n.id);
            }}
            onMiss={() => setSelected(null)}
          />
        ) : (
          <p className="flex h-full items-center justify-center p-6 text-center text-sm text-white/60">3D view unavailable in this browser.</p>
        )}
      </div>

      <ul aria-label="Legend" className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        {LEGEND.map((k) => (
          <li key={k} className="flex items-center gap-1.5">
            <KindIcon kind={k} />
            {KIND_LABEL[k]}
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-[#6fa8ff]" /> Qloo
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-[#e2a84f]" /> Rejected or uncertain
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-[#5fcf95]" /> Final
        </li>
      </ul>

      {(entry || (state.architecture === "parallel" && text)) && (
        <section aria-labelledby="decision-details" className="rounded-xl border border-line bg-panel p-4 sm:p-5">
          <h3 id="decision-details" ref={detailsHeading} tabIndex={-1} className="scroll-mt-24 text-base font-semibold text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent">
            Decision details
          </h3>
          <dl className="mt-3 grid gap-x-5 gap-y-3 text-[13px] leading-5 sm:grid-cols-[10rem_1fr]">
            {fields.map((f) => (
              <div key={f.label} className="contents">
                <dt className="text-muted">{f.label}</dt>
                <dd className="text-ink">
                  {f.value}
                  {f.items && (
                    <ul className="space-y-1">
                      {f.items.map((it, i) =>
                        it.id ? (
                          <li key={i}>
                            <button
                              type="button"
                              onClick={() => pick(it.id!)}
                              aria-pressed={selected === it.id}
                              className={`-mx-1.5 w-[calc(100%+0.75rem)] rounded px-1.5 py-0.5 text-left hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-accent ${selected === it.id ? "bg-panel-2 font-medium" : ""}`}
                            >
                              {it.text}
                            </button>
                          </li>
                        ) : (
                          <li key={i}>{it.text}</li>
                        ),
                      )}
                    </ul>
                  )}
                </dd>
              </div>
            ))}
            {selectedNode && selectedNode.evidenceIds.length > 0 && (
              <div className="contents">
                <dt className="text-muted">Evidence</dt>
                <dd>
                  <p className="mb-1.5 font-medium text-ink">
                    {KIND_LABEL[selectedNode.kind]}: {selectedNode.label}
                  </p>
                  <EvidenceRecords node={selectedNode} state={state} />
                </dd>
              </div>
            )}
          </dl>
        </section>
      )}

      {path.length > 0 && (
        <section aria-labelledby="decision-trace">
          <h3 id="decision-trace" className="text-base font-semibold text-ink">
            Decision trace
          </h3>
          <ol className="mt-2 divide-y divide-line rounded-xl border border-line bg-panel">
            {path.map((p) => (
              <li key={p.id}>
                {interactive(p.id) ? (
                  <button
                    type="button"
                    onClick={() => pick(p.id)}
                    aria-pressed={selected === p.id}
                    className={`flex min-h-11 w-full items-start gap-2.5 px-3 py-2.5 text-left text-[13px] leading-5 text-ink-2 hover:bg-panel-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${selected === p.id ? "bg-panel-2 text-ink" : ""}`}
                  >
                    <KindIcon kind={p.kind} className="mt-[3px] shrink-0 text-muted" />
                    <span className="flex-1">{p.text}</span>
                    <span aria-hidden className="shrink-0 text-muted">
                      ›
                    </span>
                  </button>
                ) : (
                  <div className="flex items-start gap-2.5 px-3 py-2.5 text-[13px] leading-5 text-ink-2">
                    <KindIcon kind={p.kind} className="mt-[3px] shrink-0 text-muted" />
                    <span>{p.text}</span>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </section>
  );
}
