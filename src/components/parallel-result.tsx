"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import {
  parallelView,
  toParallelMarkdown,
  type CellView,
  type ClaimView,
  type RowView,
} from "@/lib/crashtest/parallel-view";
import {
  SLOT_LABEL,
  STOP_LABEL,
  type RunState,
  type Slot,
  type UsageScope,
} from "@/lib/crashtest/types";
import type { OperationalAudit } from "@/lib/operational/types";

const eyebrow = "font-mono text-[10px] uppercase tracking-[0.11em] text-muted";

const SOURCE_TONE: Record<string, string> = {
  "Qloo evidence": "border-accent/25 bg-accent/10 text-accent",
  "Qloo entity data": "border-accent/25 bg-accent/10 text-accent",
  "User constraint": "border-ink/15 bg-panel-2 text-ink-2",
  "Your brief": "border-ink/15 bg-panel-2 text-ink-2",
  "Official venue source": "border-supported/25 bg-supported/10 text-supported",
  "Human check": "border-weak/30 bg-weak/10 text-weak",
  "Stress test": "border-weak/30 bg-weak/10 text-weak",
  "Application rule": "border-ink/15 bg-panel-2 text-ink-2",
};

function SourceBadge({ source }: { source: string }) {
  return (
    <span
      className={`mr-1.5 inline-flex rounded border px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.08em] ${SOURCE_TONE[source] ?? SOURCE_TONE["Application rule"]}`}
    >
      {source}
    </span>
  );
}

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

const STATE_SURFACE: Record<CellView["state"], string> = {
  supported:
    "border-supported/20 bg-gradient-to-br from-supported/[0.10] via-supported/[0.035] to-transparent",
  plausible_thin:
    "border-weak/20 bg-gradient-to-br from-weak/[0.09] via-weak/[0.025] to-transparent",
  conflicting:
    "border-conflict/20 bg-gradient-to-br from-conflict/[0.10] via-conflict/[0.035] to-transparent",
  rejected:
    "border-nosupport/20 bg-gradient-to-br from-nosupport/[0.10] via-nosupport/[0.035] to-transparent",
  unverified: "border-line bg-gradient-to-br from-ink/[0.035] to-transparent",
  needs_human: "border-line bg-gradient-to-br from-ink/[0.035] to-transparent",
  not_specified: "border-line/80 bg-panel-2/25",
  abstained: "border-line/80 bg-panel-2/25",
};

const STATE_DOT: Record<CellView["state"], string> = {
  supported: "bg-supported",
  plausible_thin: "bg-weak",
  conflicting: "bg-conflict",
  rejected: "bg-nosupport",
  unverified: "bg-unresolved",
  needs_human: "bg-unresolved",
  not_specified: "bg-muted",
  abstained: "bg-muted",
};

function Cell({
  c,
  emphasis = false,
  selected = false,
  source,
}: {
  c: CellView;
  emphasis?: boolean;
  selected?: boolean;
  source?: string | null;
}) {
  return (
    <div
      className={`min-h-[78px] min-w-0 break-words rounded-lg border px-3 py-3 ${STATE_SURFACE[c.state]}`}
    >
      <div className="flex items-start justify-between gap-2">
        <p
          className={`text-sm leading-5 text-ink ${emphasis ? "font-semibold" : c.state === "not_specified" || c.state === "abstained" ? "text-muted" : "font-medium"}`}
        >
          {c.label}
        </p>
        {selected && (
          <span className="shrink-0 rounded-full border border-supported/25 bg-supported/10 px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-[0.08em] text-supported">
            Selected
          </span>
        )}
      </div>
      <div className={`mt-2 flex items-center gap-1.5 text-[11px] font-medium ${STATE_TONE[c.state]}`}>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATE_DOT[c.state]}`} aria-hidden />
        <span>{c.status}</span>
      </div>
      {source && <p className="mt-1 text-[11px] leading-4 text-muted">{source}</p>}
    </div>
  );
}

function concise(text: string, limit = 170): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  const clipped = normalized.slice(0, limit + 1);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, lastSpace > limit * 0.7 ? lastSpace : limit).replace(/[,:;\s]+$/, "")}…`;
}

type ClaimKind = "support" | "concern" | "confirm";

function humanClaim(claim: ClaimView, kind: ClaimKind): string {
  const namedChoice = claim.text.match(/(?:Keeps|Replaces) "([^"]+)"/)?.[1];
  if (claim.dimension === "Constraint compliance" && namedChoice) {
    return kind === "support"
      ? `Keeps your original choice, ${namedChoice}.`
      : `This changes your original choice, ${namedChoice}.`;
  }

  const city = claim.text
    .match(/\bin ([A-Z][A-Za-zÀ-ÖØ-öø-ÿ .'-]+?)(?:\s*\(|[.;]|$)/)?.[1]
    ?.trim();
  const language: Record<string, Record<ClaimKind, string>> = {
    "Audience fit": {
      support: `Strong cultural fit with the intended audience${city ? ` in ${city}` : ""}.`,
      concern: "The audience fit was weaker than the leading alternatives.",
      confirm: "There was not enough audience evidence to confirm the fit.",
    },
    "Local relevance": {
      support: "Meaningful connection to the launch city.",
      concern: "The choice feels less locally relevant than the alternatives.",
      confirm: "Its local relevance still needs confirmation.",
    },
    "Cross-slot coherence": {
      support: "Works well with the other choices in the plan.",
      concern: "Fits less naturally with the rest of the plan.",
      confirm: "Its fit with the complete plan remains uncertain.",
    },
    "Brief and role fit": {
      support: "Fits the role and direction described in the brief.",
      concern: "May not fully match the role required by the brief.",
      confirm: "Its role in the launch still needs confirmation.",
    },
    "Entity correctness": {
      support: "Matched to the intended real-world artist, brand or venue.",
      concern: "The available information may refer to the wrong real-world match.",
      confirm: "There was not enough information to verify this choice confidently.",
    },
    Feasibility: {
      support: "The available information supports this as a workable choice.",
      concern: "A practical issue may prevent this choice from working.",
      confirm: "Practical suitability still needs direct confirmation.",
    },
    Distinctiveness: {
      support: "Adds a distinctive angle without weakening the overall plan.",
      concern: "Feels more generic than the strongest alternatives.",
      confirm: "Its distinctiveness could not be established confidently.",
    },
    Diversity: {
      support: "Adds useful variety to the complete plan.",
      concern: "Overlaps too heavily with another choice in the plan.",
      confirm: "Its contribution to the plan still needs review.",
    },
    "Evidence coverage": {
      support: "Supported by enough evidence to compare confidently.",
      concern: "The evidence was thinner than for the leading alternatives.",
      confirm: "More evidence is needed before relying on this choice.",
    },
    "Constraint compliance": {
      support: "Follows the requirements set in your brief.",
      concern: "Conflicts with a requirement in your brief.",
      confirm: "A requirement in the brief still needs confirmation.",
    },
  };
  return language[claim.dimension]?.[kind] ?? concise(claim.text);
}

function ClaimList({
  title,
  claims,
  tone,
  kind,
}: {
  title: string;
  claims: ClaimView[];
  tone: string;
  kind: ClaimKind;
}) {
  if (!claims.length) return null;
  const claim = claims.find((item) => item.decisive) ?? claims[0];
  return (
    <div className="min-w-0">
      <p className={`text-[11px] font-semibold ${tone}`}>{title}</p>
      <p className="mt-1 flex gap-2 text-xs leading-5 text-ink-2">
        <span className={tone} aria-hidden>
          •
        </span>
        <span>{humanClaim(claim, kind)}</span>
      </p>
    </div>
  );
}

function plainSupportReason(r: RowView): string | null {
  const support = r.support.find((claim) => claim.decisive) ?? r.support[0];
  if (!support) return null;
  if (support.source !== "Qloo evidence" && support.source !== "Qloo entity data")
    return support.text;
  const fit: Record<Slot, string> = {
    artist_music: "music choice",
    brand_collaboration: "collaboration partner",
    event_place: "venue",
    creative_direction: "creative direction",
  };
  return `${r.final.label} was the strongest ${fit[r.slot]} match found for the intended audience and the rest of the plan.`;
}

function EvidenceDelta({ rows, operational }: { rows: RowView[]; operational?: OperationalAudit }) {
  const changed = rows.filter(
    (row) =>
      row.you.candidateId &&
      row.you.state !== "not_specified" &&
      row.you.state !== "abstained" &&
      row.you.label !== row.final.label,
  );
  const qlooChanged = changed.filter((row) =>
    row.support.some(
      (claim) =>
        claim.decisive && (claim.source === "Qloo evidence" || claim.source === "Qloo entity data"),
    ),
  );
  return (
    <section
      aria-labelledby="qloo-delta"
      className="rounded-xl border border-accent/20 bg-accent/[0.04] px-5 py-5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p id="qloo-delta" className={eyebrow}>
          What changed because of Qloo?
        </p>
        <SourceBadge source="Qloo evidence" />
      </div>
      {qlooChanged.length ? (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {qlooChanged.map((row) => (
            <article key={row.slot} className="rounded-lg border border-line bg-panel px-4 py-4">
              <p className="text-xs font-bold uppercase tracking-[0.06em] text-ink">{row.title}</p>
              <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-3">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.08em] text-muted">Original</p>
                  <p className="mt-1 text-sm font-medium text-ink-2">{row.you.label}</p>
                </div>
                <span aria-hidden className="text-lg text-accent">
                  →
                </span>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.08em] text-muted">Recommended</p>
                  <p className="mt-1 text-sm font-semibold text-ink">{row.final.label}</p>
                </div>
              </div>
              <p className="mt-3 text-xs leading-5 text-ink-2">{plainSupportReason(row)}</p>
            </article>
          ))}
        </div>
      ) : (
        <p className="mt-3 max-w-3xl text-sm leading-6 text-ink-2">
          Qloo did not justify replacing one of your stated choices. The final plan kept the choices
          that remained competitive after the complete plans were tested.
        </p>
      )}
      {operational?.override && (
        <p className="mt-3 text-xs leading-5 text-muted">
          The venue changed for a separate reason: an official-source operational conflict, not a
          Qloo cultural score.
        </p>
      )}
    </section>
  );
}

function operationalConflict(reason: string): string {
  return reason
    .replace(/^.*?failed the operational check:\s*/i, "")
    .replace(/\s+No operationally viable alternative was established\.?$/i, "")
    .trim();
}

function rowReason(r: RowView, operational?: OperationalAudit): string {
  const override = r.slot === "event_place" ? operational?.override : undefined;
  if (override && r.final.label === override.toVenue) {
    const kept = r.you.label === override.toVenue;
    return `An official-source check ruled out ${override.fromVenue}. We ${kept ? `kept your next-ranked choice, ${override.toVenue}` : `used the next-ranked choice, ${override.toVenue}`}.`;
  }
  const support = plainSupportReason(r);
  const concern = r.counter.find((claim) => claim.decisive) ?? r.counter[0];
  const hasUserChoice =
    !!r.you.candidateId && r.you.state !== "not_specified" && r.you.state !== "abstained";
  const sameAsUser = hasUserChoice && r.you.label === r.final.label;
  const opening = sameAsUser
    ? `We kept your choice, ${r.final.label}.`
    : hasUserChoice
      ? `We changed this choice from ${r.you.label} to ${r.final.label}.`
      : `The final plan uses ${r.final.label}.`;
  const evidence = support
    ? ` ${concise(support)}`
    : concern
      ? ` It remained the strongest complete-plan option despite one concern.`
      : " No tested alternative produced a stronger complete plan.";
  return `${opening}${evidence}`;
}

function Row({ r, operational }: { r: RowView; operational?: OperationalAudit }) {
  return (
    <tbody className="border-t-2 border-line first:border-t-0">
      <tr className="align-top">
        <th
          scope="row"
          className="w-[14%] border-r border-line bg-panel-2/30 px-4 py-5 text-left text-xs font-bold uppercase tracking-[0.06em] text-ink"
        >
          {r.title}
        </th>
        <td className="w-[19%] px-2.5 py-3">
          <Cell c={r.you} />
        </td>
        <td className="w-[19%] border-l border-line px-2.5 py-3">
          <Cell c={r.llm} />
        </td>
        <td className="w-[19%] border-l border-line px-2.5 py-3">
          <Cell c={r.agent} />
        </td>
        <td className="w-[29%] border-l-2 border-ink/20 bg-panel-2/30 px-2.5 py-3">
          <Cell c={r.final} emphasis selected source={r.final.source} />
        </td>
      </tr>
      <tr>
        <td colSpan={5} className="border-t border-line bg-panel-2/25 px-4 py-2">
          <details>
            <summary className="min-h-9 cursor-pointer py-1 text-xs font-medium text-accent">
              Why this won
            </summary>
            <p className="max-w-3xl pb-3 text-[13px] leading-5 text-ink-2">
              {rowReason(r, operational)}
            </p>
            <div className="grid max-w-4xl gap-2 pb-3 md:grid-cols-3">
              <ClaimList
                title="Key support"
                claims={r.support}
                tone="text-supported"
                kind="support"
              />
              <ClaimList
                title="Main concern"
                claims={r.counter}
                tone="text-conflict"
                kind="concern"
              />
              <ClaimList
                title="Still to confirm"
                claims={r.uncertain}
                tone="text-unresolved"
                kind="confirm"
              />
            </div>
          </details>
        </td>
      </tr>
    </tbody>
  );
}

function DecisionOverview({ state, rows }: { state: RunState; rows: RowView[] }) {
  const p = state.parallel!;
  const screened = p.agent
    ? new Set(p.agent.pools.map((candidate) => `${candidate.slot}:${candidate.name}`)).size
    : 0;
  const bundles = p.agent?.bundlesTested ?? 0;
  const changed = rows.filter(
    (row) =>
      row.you.candidateId &&
      row.you.state !== "not_specified" &&
      row.you.state !== "abstained" &&
      row.you.label !== row.final.label,
  );
  const kept = rows.filter(
    (row) =>
      row.you.candidateId &&
      row.you.state !== "not_specified" &&
      row.you.state !== "abstained" &&
      row.you.label === row.final.label,
  );
  const stated = rows.filter(
    (row) =>
      row.you.candidateId && row.you.state !== "not_specified" && row.you.state !== "abstained",
  ).length;
  const override = p.operational?.override;
  const finalVenue = rows.find((row) => row.slot === "event_place")?.final.label;
  const venueCheck = p.operational?.checks.find((check) => check.venue === finalVenue);
  return (
    <section
      aria-labelledby="decision-summary"
      className="rounded-xl border border-line bg-panel px-5 py-5 shadow-sm"
    >
      <p className={eyebrow}>Recommendation in plain language</p>
      <h3 id="decision-summary" className="mt-1 text-lg font-semibold tracking-[-0.02em] text-ink">
        Why this is the final plan
      </h3>
      <div className="mt-3 space-y-2 text-sm leading-6 text-ink-2">
        <p>
          {kept.length
            ? `We kept ${kept.length} of your ${stated} stated choices because they remained competitive when the complete plans were compared.`
            : "The final plan did not preserve any stated choice without re-testing it."}
          {changed.length
            ? ` We changed ${changed.map((row) => `${row.title.toLowerCase()} to ${row.final.label}`).join(" and ")}.`
            : " No choice was changed merely to make the plan different."}
        </p>
        {changed.map((row) => {
          const reason = plainSupportReason(row);
          return reason ? <p key={row.slot}>Why: {reason}</p> : null;
        })}
        {override && (
          <p>
            Qloo&apos;s cultural comparison initially preferred {override.fromVenue}. The live
            official-source check found that {operationalConflict(override.reason)}. The web check
            did not create a new recommendation or rewrite the cultural scores; it ruled out that
            finalist, so the final plan{" "}
            {override.toVenue
              ? `uses the highest-ranked remaining option, ${override.toVenue}`
              : "leaves the venue unresolved"}
            .
          </p>
        )}
        {!override && venueCheck?.status === "verified_fit" && (
          <p>
            The live web check also confirmed that {venueCheck.venue} is operationally plausible for
            the proposed event. Booking terms, availability and final production requirements still
            need direct confirmation.
          </p>
        )}
        {!override && venueCheck?.status === "unverified" && (
          <p>
            The cultural case for {venueCheck.venue} was strongest, but the live web check could not
            confirm enough current operational information. Treat the venue recommendation as
            provisional until capacity, event format and product-demonstration conditions are
            confirmed directly.
          </p>
        )}
        {!override && venueCheck?.status === "verified_conflict" && (
          <p>
            The live web check found an operational conflict for {venueCheck.venue}. The venue
            should not be treated as approved until that conflict is resolved by a person.
          </p>
        )}
        {p.agent && (
          <p>
            The three columns below are the finalists, not the whole search. The evidence agent
            screened {screened} candidate choices across the four decision areas and tested{" "}
            {bundles} complete plan combination{bundles === 1 ? "" : "s"}. The strongest agent plan
            was then compared with your plan and the independent LLM plan.
          </p>
        )}
      </div>
    </section>
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

export function OperationalVerification({ audit }: { audit: OperationalAudit }) {
  return (
    <section aria-label="Operational verification" className="space-y-3 border-t border-line pt-5">
      <p className={eyebrow}>Operational verification</p>
      {audit.override && (
        <p className="max-w-3xl text-sm font-medium leading-6 text-ink">
          The cultural comparison recommended {audit.override.fromVenue}. The operational check
          caught this: {audit.override.reason} We therefore moved to{" "}
          {audit.override.toVenue ?? "no final venue"}.
        </p>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {audit.checks.map((check) => (
          <article key={check.venue} className="rounded-xl border border-line bg-panel px-4 py-4">
            <div className="flex items-start justify-between gap-3">
              <h3 className="font-semibold text-ink">{check.venue}</h3>
              <span
                className={`text-[10px] font-semibold uppercase tracking-[0.08em] ${
                  check.status === "verified_fit"
                    ? "text-supported"
                    : check.status === "verified_conflict"
                      ? "text-conflict"
                      : "text-unresolved"
                }`}
              >
                {check.status === "verified_fit"
                  ? "Feasible"
                  : check.status === "verified_conflict"
                    ? "Conflict caught"
                    : "Unverified"}
              </span>
            </div>
            <p className="mt-2 text-sm leading-6 text-ink-2">{check.finding}</p>
            {check.facts.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-5 text-ink-2">
                {check.facts.map((fact) => (
                  <li key={fact}>{fact}</li>
                ))}
              </ul>
            )}
            {check.sources.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1">
                {check.sources.map((source) => (
                  <a
                    key={source.url}
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs font-medium text-accent hover:underline"
                  >
                    {source.title}
                  </a>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
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

const JudgeGraphView = dynamic(() => import("./judge-graph-view"), {
  ssr: false,
  loading: () => (
    <p className="py-16 text-center text-sm text-muted">Loading the decision graph…</p>
  ),
});

function JudgeReceipt({ state, rows }: { state: RunState; rows: RowView[] }) {
  const changedFromUser = rows.filter(
    (row) => row.you.candidateId && row.you.label !== row.final.label,
  ).length;
  const changedFromLlm = rows.filter(
    (row) => row.llm.candidateId && row.llm.label !== row.final.label,
  ).length;
  const qlooSupport = rows.reduce(
    (count, row) =>
      count +
      row.support.filter(
        (claim) => claim.source === "Qloo evidence" || claim.source === "Qloo entity data",
      ).length,
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
    <dl
      aria-label="Decision receipt"
      className="grid overflow-hidden rounded-xl border border-line bg-panel sm:grid-cols-3"
    >
      {facts.map((fact, index) => (
        <div
          key={fact.label}
          className={`px-4 py-4 ${index ? "border-t border-line sm:border-l sm:border-t-0" : ""}`}
        >
          <dt className={eyebrow}>{fact.label}</dt>
          <dd className="mt-1 text-[15px] font-semibold leading-5 text-ink">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ParallelRunResult({ state }: { state: RunState }) {
  const [showDetails, setShowDetails] = useState(false);
  const [focus, setFocus] = useState<Slot | null>(null);
  const [step, setStep] = useState<number | null>(null);
  const detailsRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!showDetails) return;
    const frame = requestAnimationFrame(() => {
      detailsRef.current?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [showDetails]);

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
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className={eyebrow}>
            {state.marketLabel} ·{" "}
            {state.provenance?.mode === "recorded" ? "Recorded run" : "Live run"} · three
            independent plans
          </p>
          <h2 className="mt-2 max-w-2xl text-2xl font-semibold tracking-[-0.035em] text-ink">
            {s.headline}: {s.winner}
          </h2>
        </div>
        <button
          type="button"
          aria-expanded={showDetails}
          aria-controls="decision-details-panel"
          onClick={() => setShowDetails((visible) => !visible)}
          className="min-h-10 rounded-lg border border-line bg-panel px-4 text-sm font-semibold text-ink transition-colors hover:bg-panel-2"
        >
          {showDetails ? "Hide details" : "View details"}
        </button>
      </header>

      <DecisionOverview state={state} rows={view.rows} />

      <EvidenceDelta rows={view.rows} operational={p.operational} />

      <section aria-labelledby="parallel-comparison">
        <div className="mb-4">
          <h3
            id="parallel-comparison"
            className="text-xl font-semibold tracking-[-0.025em] text-ink"
          >
            Plan comparison
          </h3>
        </div>
        <div className="overflow-x-auto rounded-xl border border-line bg-panel shadow-sm">
          <table className="w-full min-w-[760px] table-fixed border-collapse lg:min-w-0">
            <colgroup>
              <col className="w-[15%]" />
              <col className="w-[18%]" />
              <col className="w-[18%]" />
              <col className="w-[22%]" />
              <col className="w-[27%]" />
            </colgroup>
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
              <Row key={r.slot} r={r} operational={p.operational} />
            ))}
          </table>
        </div>
      </section>

      {showDetails && (
        <section
          ref={detailsRef}
          id="decision-details-panel"
          aria-label="Decision details"
          className="scroll-mt-6 space-y-7 border-t border-line pt-7"
        >
          <p className={`max-w-2xl text-[15px] leading-6 ${s.stable ? "text-ink-2" : "text-weak"}`}>
            {s.stability}
          </p>

          <dl className="flex flex-wrap gap-x-8 gap-y-3">
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

          <JudgeReceipt state={state} rows={view.rows} />

          {p.operational && <OperationalVerification audit={p.operational} />}

          <ol
            aria-label="Agent method"
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted"
          >
            {[
              "Freeze brief",
              "Generate independently",
              "Test with Qloo",
              "Compare blind",
              "Stress-test",
              "Select",
            ].map((label, index) => (
              <li
                key={label}
                className="flex items-center gap-2"
                aria-current={step === index + 1 ? "step" : undefined}
              >
                {index > 0 && <span aria-hidden>→</span>}
                <span className={step === index + 1 ? "font-semibold text-accent" : undefined}>
                  {label}
                </span>
              </li>
            ))}
          </ol>

          <JudgeGraphView state={state} focus={focus} onFocus={setFocus} onStep={setStep} />

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
                      {SLOT_LABEL[b.slot]}: {b.label} ({b.status.replace("_", " ")}, {b.candidateId}
                      )
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
                Three plans were made independently: yours as given, the LLM&apos;s without Qloo,
                and the evidence-first agent&apos;s from screened Qloo candidates only.
              </li>
              <li>
                Each was tested by the same Qloo checks and turned into evidence claims; rules of
                the brief were checked in code first.
              </li>
              <li>
                A blind judge compared them twice, in two orders; a verdict that changed with the
                order is reported as unstable.
              </li>
              <li>
                Hybrids and targeted searches were each re-tested as complete plans and kept only
                for a material improvement.
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
        </section>
      )}
    </div>
  );
}
