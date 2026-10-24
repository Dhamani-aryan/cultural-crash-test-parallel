"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import {
  parallelView,
  toParallelMarkdown,
  type CellView,
  type ClaimView,
  type RowView,
} from "@/lib/crashtest/parallel-view";
import { SLOT_LABEL, STOP_LABEL, type RunState, type Slot, type UsageScope } from "@/lib/crashtest/types";

const eyebrow = "font-mono text-[10px] uppercase tracking-[0.11em] text-muted";

/** Unknown and unverified are grey, never the failure colour: missing evidence isn't a failure. */
const STATE_TONE: Record<CellView["state"], string> = {
  supported: "text-supported",
  plausible_thin: "text-weak",
  conflicting: "text-conflict",
  rejected: "text-nosupport",
  unverified: "text-unresolved",
  needs_human: "text-unresolved",
  not_specified: "text-muted",
  abstained: "text-muted",
};

function Cell({
  c,
  emphasis = false,
  source,
}: {
  c: CellView;
  emphasis?: boolean;
  source?: string | null;
}) {
  return (
    <div>
      <p
        className={`text-[15px] leading-5 text-ink ${emphasis ? "font-semibold" : c.state === "not_specified" || c.state === "abstained" ? "text-muted" : "font-medium"}`}
      >
        {c.label}
      </p>
      <p className={`mt-1 text-xs font-medium leading-4 ${STATE_TONE[c.state]}`}>{c.status}</p>
      {source && <p className="mt-0.5 text-xs leading-4 text-muted">{source}</p>}
      {c.note && <p className="mt-0.5 text-xs leading-4 text-muted">{c.note}</p>}
    </div>
  );
}

function ClaimList({ title, claims, tone }: { title: string; claims: ClaimView[]; tone: string }) {
  if (!claims.length) return null;
  return (
    <div>
      <p className={`text-xs font-semibold ${tone}`}>{title}</p>
      <ul className="mt-1 space-y-1">
        {claims.map((c) => (
          <li key={c.claimId} className="text-[13px] leading-5 text-ink-2">
            <span className="text-muted">
              {c.dimension} · {c.source}
              {c.decisive ? " · decisive" : ""}:
            </span>{" "}
            {c.text}
            {c.limitations.length > 0 && (
              <span className="text-muted"> ({c.limitations.join(" ")})</span>
            )}
            {c.evidenceIds.length > 0 && (
              <span className="font-mono text-[11px] text-muted">
                {" "}
                [{c.evidenceIds.join(", ")}]
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Row({ r }: { r: RowView }) {
  return (
    <tbody className="border-t-2 border-line first:border-t-0">
      <tr className="align-top">
        <th
          scope="row"
          className="w-[14%] border-r border-line bg-panel-2/30 px-4 py-5 text-left text-xs font-bold uppercase tracking-[0.06em] text-ink"
        >
          {r.title}
        </th>
        <td className="w-[19%] px-4 py-5">
          <Cell c={r.you} />
        </td>
        <td className="w-[19%] border-l border-line px-4 py-5">
          <Cell c={r.llm} />
        </td>
        <td className="w-[19%] border-l border-line px-4 py-5">
          <Cell c={r.agent} />
        </td>
        <td className="w-[29%] border-l-2 border-ink/20 bg-panel-2/40 px-4 py-5">
          <Cell c={r.final} emphasis source={r.final.source} />
        </td>
      </tr>
      <tr>
        <td colSpan={5} className="border-t border-line bg-panel-2/25 px-4 py-2">
          <details>
            <summary className="min-h-9 cursor-pointer py-1 text-xs font-medium text-accent">
              Why this won
            </summary>
            <div className="grid gap-3 pb-3 pt-1 md:grid-cols-3">
              <ClaimList title="Evidence for it" claims={r.support} tone="text-supported" />
              <ClaimList title="Evidence against it" claims={r.counter} tone="text-conflict" />
              <ClaimList
                title="Unknown or unverified"
                claims={r.uncertain}
                tone="text-unresolved"
              />
            </div>
            {r.alternatives.length > 0 && (
              <p className="pb-2 text-xs text-muted">
                Other picks:{" "}
                {r.alternatives
                  .map((a) => `${a.track}: ${a.label} (${a.status.toLowerCase()})`)
                  .join(" · ")}
              </p>
            )}
          </details>
        </td>
      </tr>
    </tbody>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-[8rem]">
      <dt className={eyebrow}>{label}</dt>
      <dd className="mt-1 text-[15px] font-semibold text-ink">{value}</dd>
    </div>
  );
}

const SCOPE_LABEL: Record<UsageScope, string> = {
  shared: "Shared (brief and anchors)",
  user: "Your plan",
  llm: "LLM plan",
  agent: "Evidence-first agent",
  adjudication: "Blind adjudication",
  improvement: "Improvement loop",
};

const STABILITY_TONE = {
  preserved: "text-supported",
  tied: "text-weak",
  reversed: "text-conflict",
  unavailable: "text-unresolved",
} as const;

type ResultView = "table" | "graph";

const JudgeGraphView = dynamic(() => import("./judge-graph-view"), {
  ssr: false,
  loading: () => <p className="py-16 text-center text-sm text-muted">Loading the decision graph…</p>,
});

function JudgeReceipt({ state, rows }: { state: RunState; rows: RowView[] }) {
  const changedFromUser = rows.filter(
    (row) => row.you.candidateId && row.you.label !== row.final.label,
  ).length;
  const changedFromLlm = rows.filter(
    (row) => row.llm.candidateId && row.llm.label !== row.final.label,
  ).length;
  const qlooSupport = rows.reduce(
    (count, row) => count + row.support.filter((claim) => claim.source === "Qloo").length,
    0,
  );
  const facts = [
    {
      label: "Plan delta",
      value: `${changedFromUser} from you · ${changedFromLlm} from LLM`,
    },
    {
      label: "Qloo contribution",
      value: `${qlooSupport} supporting claims · ${state.qlooUsage?.checks ?? state.qlooCallsUsed} checks`,
    },
    {
      label: "Decision test",
      value: `3 plans · 2 blind orders`,
    },
  ];
  return (
    <dl aria-label="Decision receipt" className="grid overflow-hidden rounded-xl border border-line bg-panel sm:grid-cols-3">
      {facts.map((fact, index) => (
        <div key={fact.label} className={`px-4 py-4 ${index ? "border-t border-line sm:border-l sm:border-t-0" : ""}`}>
          <dt className={eyebrow}>{fact.label}</dt>
          <dd className="mt-1 text-[15px] font-semibold leading-5 text-ink">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ViewSwitch({ view, onChange }: { view: ResultView; onChange: (view: ResultView) => void }) {
  return (
    <div role="group" aria-label="Result view" className="inline-flex overflow-hidden rounded-lg border border-line bg-panel">
      {(["table", "graph"] as const).map((item) => (
        <button
          key={item}
          type="button"
          aria-pressed={view === item}
          onClick={() => onChange(item)}
          className={`min-h-10 px-4 text-sm font-medium transition-colors ${view === item ? "bg-ink text-bg" : "text-ink-2 hover:bg-panel-2"}`}
        >
          {item === "table" ? "Comparison table" : "Decision graph"}
        </button>
      ))}
    </div>
  );
}

export function ParallelRunResult({ state }: { state: RunState }) {
  const [viewMode, setViewMode] = useState<ResultView>("table");
  const [focus, setFocus] = useState<Slot | null>(null);
  const [step, setStep] = useState<number | null>(null);
  const view = parallelView(state);
  const p = state.parallel;
  if (!view || !p)
    return (
      <p className="text-[15px] text-ink-2">
        The run stopped before the plans could be compared
        {state.stopReason ? `: ${STOP_LABEL[state.stopReason]}` : ""}
        {state.stopDetail ? ` (${state.stopDetail})` : "."}
      </p>
    );
  const s = view.summary;
  const v = p.verdict;
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([toParallelMarkdown(state)], { type: "text/markdown" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `crash-test-${state.marketLabel.toLowerCase()}-parallel.md`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-7 pt-3">
      <header>
        <p className={eyebrow}>
          {state.marketLabel} ·{" "}
          {state.provenance?.mode === "recorded" ? "Recorded run" : "Live run"} · three independent
          plans
        </p>
        <h2 className="mt-2 max-w-2xl text-2xl font-semibold tracking-[-0.035em] text-ink">
          {s.headline}: {s.winner}
        </h2>
        <p
          className={`mt-2 max-w-2xl text-[15px] leading-6 ${s.stable ? "text-ink-2" : "text-weak"}`}
        >
          {s.stability}
        </p>
        <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
          <Stat
            label="Hard rules passed"
            value={
              s.hardConstraints.total
                ? `${s.hardConstraints.passed} of ${s.hardConstraints.total}`
                : "None set"
            }
          />
          <Stat label="Evidence coverage" value={`${Math.round(s.coverage * 100)}%`} />
          <Stat
            label="Supported / thin / unverified"
            value={`${s.counts.supported} / ${s.counts.thin} / ${s.counts.unverified + s.counts.needsHuman}`}
          />
          <Stat label="Qloo checks · model calls" value={`${s.qlooChecks} · ${s.modelCalls}`} />
          {s.stress && (
            <Stat
              label="Decision stability"
              value={`${s.stress.preserved}/${s.stress.completed} preserved${s.stress.reversed ? ` · ${s.stress.reversed} reversed` : s.stress.tied ? ` · ${s.stress.tied} tied` : ""}`}
            />
          )}
          <Stat
            label="To confirm"
            value={`${s.humanChecks} check${s.humanChecks === 1 ? "" : "s"}`}
          />
        </dl>
      </header>

      <JudgeReceipt state={state} rows={view.rows} />

      <div className="space-y-3">
        <ViewSwitch
          view={viewMode}
          onChange={(next) => {
            setViewMode(next);
            setStep(null);
          }}
        />
        <ol aria-label="Agent method" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          {["Freeze brief", "Generate independently", "Test with Qloo", "Compare blind", "Stress-test", "Select"].map((label, index) => (
            <li key={label} className="flex items-center gap-2" aria-current={step === index + 1 ? "step" : undefined}>
              {index > 0 && <span aria-hidden>→</span>}
              <span className={step === index + 1 ? "font-semibold text-accent" : undefined}>{label}</span>
            </li>
          ))}
        </ol>
      </div>

      {viewMode === "table" ? <section aria-labelledby="parallel-comparison">
        <div className="mb-4">
          <p className={eyebrow}>Plan comparison</p>
          <h3
            id="parallel-comparison"
            className="mt-1 text-xl font-semibold tracking-[-0.025em] text-ink"
          >
            Your direction, the LLM alone, the evidence-first agent, and the final verdict
          </h3>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            The LLM and the agent planned independently from the same brief; neither saw the other.
            All plans were tested by the same Qloo checks and compared blind.
          </p>
        </div>
        <div className="overflow-x-auto rounded-xl border border-line bg-panel shadow-sm">
          <table className="w-full min-w-[860px] border-collapse">
            <thead>
              <tr className="border-b border-line bg-[#e9e7e1] text-left">
                {["Choice", "You", "LLM", "Evidence-first agent", "Final verdict"].map((h, i) => (
                  <th
                    key={h}
                    className={`px-4 py-3.5 text-xs font-bold uppercase tracking-[0.08em] text-ink ${i === 0 ? "border-r border-line" : i === 4 ? "border-l-2 border-ink/20" : i > 1 ? "border-l border-line" : ""}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            {view.rows.map((r) => (
              <Row key={r.slot} r={r} />
            ))}
          </table>
        </div>
      </section> : (
        <JudgeGraphView
          state={state}
          focus={focus}
          onFocus={setFocus}
          onStep={setStep}
        />
      )}

      <section
        aria-label="How the verdict was reached"
        className="space-y-2 text-sm leading-6 text-ink-2"
      >
        <p className={eyebrow}>How the verdict was reached</p>
        <p>
          <span className="text-muted">First blind comparison:</span> {view.initialVerdict}
        </p>
        {p.rounds.map((r) => (
          <p key={r.round}>
            <span className="text-muted">Improvement round {r.round}:</span>{" "}
            {r.attempts.filter((a) => a.rejectionCode !== "duplicate").length
              ? r.attempts
                  .filter((a) => a.rejectionCode !== "duplicate")
                  .map(
                    (a) =>
                      `${a.kind === "search" ? "targeted search" : a.kind === "union" ? "strongest-component hybrid" : "swap"}${a.slot ? ` (${SLOT_LABEL[a.slot].toLowerCase()})` : ""} ${a.accepted ? "accepted after a full re-test" : `rejected: ${a.reason.toLowerCase()}`}`,
                  )
                  .join("; ")
              : "no new plan to test."}
          </p>
        ))}
        <p>
          <span className="text-muted">Final blind comparison:</span> {view.finalVerdict}
        </p>
        {p.stability && (
          <>
            <p>
              <span className="text-muted">Evidence stress tests:</span> {p.stability.preserved}{" "}
              preserved · {p.stability.tied} tied · {p.stability.reversed} reversed
              {p.stability.unavailable ? ` · ${p.stability.unavailable} unavailable` : ""}.
            </p>
            <details className="rounded-xl border border-line bg-panel px-4 py-3">
              <summary className="cursor-pointer text-xs font-semibold text-ink">
                View stability checks
              </summary>
              <div className="mt-3 divide-y divide-line">
                {p.stability.checks.map((check) => {
                  const winner = check.winnerCandidateId
                    ? p.candidates.find((c) => c.candidateId === check.winnerCandidateId)
                    : null;
                  const winnerLabel = winner
                    ? winner.track === "user"
                      ? "Your plan"
                      : winner.track === "llm"
                        ? "LLM plan"
                        : winner.track === "agent"
                          ? "Evidence-first agent"
                          : "Tested hybrid"
                    : null;
                  return (
                    <div
                      key={check.id}
                      className="grid gap-1 py-2.5 sm:grid-cols-[minmax(10rem,1fr)_8rem_minmax(10rem,1fr)] sm:gap-4"
                    >
                      <span className="font-medium text-ink">{check.label}</span>
                      <span
                        className={`text-xs font-semibold uppercase tracking-[0.06em] ${STABILITY_TONE[check.outcome]}`}
                      >
                        {check.outcome}
                      </span>
                      <span className="text-muted">
                        {winnerLabel ??
                          (check.outcome === "tied" ? "No single winner" : "Not completed")}
                      </span>
                    </div>
                  );
                })}
              </div>
            </details>
          </>
        )}
      </section>

      {v.humanChecks.length > 0 && (
        <section
          aria-label="Human checks still required"
          className="border-l-2 border-weak/60 pl-4 text-sm leading-6 text-ink-2"
        >
          <p className={eyebrow}>Human checks still required</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {v.humanChecks.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </section>
      )}

      <details className="border-t border-line pt-3">
        <summary className="cursor-pointer text-xs text-muted">
          Verdict details: preserved choices, assumptions, limitations and rejected alternatives
        </summary>
        <div className="mt-3 grid gap-4 text-xs leading-5 text-ink-2 md:grid-cols-2">
          <div>
            <p className="font-semibold text-ink">Best-supported components</p>
            <ul className="mt-1 space-y-0.5">
              {v.bestSupportedComponents.map((b) => (
                <li key={b.slot}>
                  {SLOT_LABEL[b.slot]}: {b.label} ({b.status.replace("_", " ")}, {b.candidateId})
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="font-semibold text-ink">Your choices preserved</p>
            <ul className="mt-1 space-y-0.5">
              {v.userChoicesPreserved.length ? (
                v.userChoicesPreserved.map((u) => (
                  <li key={u.slot}>
                    {SLOT_LABEL[u.slot]} “{u.label}”{u.locked ? " (fixed)" : ""}:{" "}
                    {u.preserved ? "kept" : "replaced"}
                  </li>
                ))
              ) : (
                <li>You named no choices.</li>
              )}
            </ul>
          </div>
          <div>
            <p className="font-semibold text-ink">Assumptions introduced</p>
            <ul className="mt-1 space-y-0.5">
              {v.assumptionsIntroduced.length ? (
                v.assumptionsIntroduced.map((a) => <li key={a}>{a}</li>)
              ) : (
                <li>None.</li>
              )}
            </ul>
          </div>
          <div>
            <p className="font-semibold text-ink">Evidence limitations</p>
            <ul className="mt-1 space-y-0.5">
              {v.evidenceLimitations.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </div>
          <div className="md:col-span-2">
            <p className="font-semibold text-ink">Rejected alternatives</p>
            <ul className="mt-1 space-y-0.5">
              {v.rejectedAlternatives.map((r) => (
                <li key={r.candidateId}>
                  {r.candidateId}: {r.reason}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </details>

      <details className="border-t border-line pt-3">
        <summary className="cursor-pointer text-xs text-muted">Method and run details</summary>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-ink-2">
          <li>
            Your brief was frozen ({p.briefFingerprint}) and one audience was chosen to measure
            every plan against (
            {p.anchorSource === "user"
              ? "your anchors"
              : "model-suggested anchors, shown for you to confirm"}
            ).
          </li>
          <li>
            Three plans were made independently: yours as given, the LLM&apos;s without Qloo, and
            the evidence-first agent&apos;s from screened Qloo candidates only.
          </li>
          <li>
            Each was tested by the same Qloo checks and turned into evidence claims; rules of the
            brief were checked in code first.
          </li>
          <li>
            A blind judge compared them twice, in two orders; a verdict that changed with the order
            is reported as unstable.
          </li>
          <li>
            Hybrids and targeted searches were each re-tested as complete plans and kept only for a
            material improvement.
          </li>
        </ol>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-ink-2">
          <dt className="text-muted">Stopped</dt>
          <dd>
            {state.stopReason ? STOP_LABEL[state.stopReason] : "–"}
            {state.stopDetail ? ` (${state.stopDetail})` : ""}
          </dd>
          {(Object.keys(SCOPE_LABEL) as UsageScope[]).map((k) => (
            <div key={k} className="contents">
              <dt className="text-muted">{SCOPE_LABEL[k]}</dt>
              <dd>
                {Math.round(p.usage[k].ms / 100) / 10} s · {p.usage[k].qlooChecks} Qloo checks ·{" "}
                {p.usage[k].llmCalls} model calls
              </dd>
            </div>
          ))}
          <dt className="text-muted">Qloo budget used</dt>
          <dd>
            {state.qlooCallsUsed} of {state.maxQlooCalls}
          </dd>
          <dt className="text-muted">Versions</dt>
          <dd>
            {state.provenance?.runVersion ?? "–"} · {p.baseRubricVersion} ·{" "}
            {p.evidenceRubricVersion} · {p.adjudicationVersion} (application-defined; not a
            forecast)
          </dd>
        </dl>
        <button
          type="button"
          onClick={download}
          className="mt-3 text-xs text-accent hover:underline"
        >
          Download report
        </button>
      </details>
    </div>
  );
}
