export type FailurePattern =
  | "run_error"
  | "zero_support"
  | "no_evidence_gain"
  | "blind_order_instability"
  | "anchor_sensitivity"
  | "brief_contradiction"
  | "role_uncertainty";

export interface ScenarioSummaryLike {
  id: string;
  stopReason?: string | null;
  error?: string | null;
  initialSupported?: number | null;
  finalSupported?: number | null;
  stable?: boolean | null;
  provisional?: boolean | null;
}

interface ClaimLike {
  candidateId?: string;
  ruleId?: string;
  dimension?: string;
  stance?: string;
}

interface CheckLike {
  kind?: string;
  outcome?: string;
}

export interface ScenarioStateLike {
  parallel?: {
    verdict?: { candidateId?: string | null };
    matrix?: { claims?: ClaimLike[] };
    stability?: { checks?: CheckLike[] };
  };
}

export interface PatternCase {
  id: string;
  patterns: FailurePattern[];
}

const ORDER: FailurePattern[] = [
  "run_error",
  "brief_contradiction",
  "role_uncertainty",
  "anchor_sensitivity",
  "blind_order_instability",
  "zero_support",
  "no_evidence_gain",
];

/** Classify only observed failures. A stable, improving result produces no patterns and is skipped. */
export function failurePatterns(summary: ScenarioSummaryLike, state?: ScenarioStateLike): FailurePattern[] {
  const found = new Set<FailurePattern>();
  if (summary.stopReason === "error" || summary.error) found.add("run_error");
  if (summary.finalSupported === 0) found.add("zero_support");
  if (
    summary.initialSupported != null &&
    summary.finalSupported != null &&
    summary.finalSupported <= summary.initialSupported
  )
    found.add("no_evidence_gain");

  const checks = state?.parallel?.stability?.checks ?? [];
  if (checks.some((c) => c.kind === "blind_order" && c.outcome === "reversed"))
    found.add("blind_order_instability");
  if (checks.some((c) => c.kind === "anchor_dropout" && c.outcome === "reversed"))
    found.add("anchor_sensitivity");
  // Older summaries may not expose check kinds, but still tell us the verdict is provisional.
  if ((summary.provisional || summary.stable === false) && !checks.some((c) => c.outcome === "reversed"))
    found.add("blind_order_instability");

  const winner = state?.parallel?.verdict?.candidateId;
  const claims = (state?.parallel?.matrix?.claims ?? []).filter((c) => !winner || c.candidateId === winner);
  if (
    claims.some(
      (c) =>
        c.stance === "contradicts" &&
        (c.dimension === "role_fit" || c.ruleId === "R-neighborhood"),
    )
  )
    found.add("brief_contradiction");
  if (
    claims.some(
      (c) =>
        c.stance === "unknown" &&
        (c.ruleId === "R-role-check" || c.ruleId === "R-host-tier"),
    )
  )
    found.add("role_uncertainty");

  return ORDER.filter((p) => found.has(p));
}

/**
 * Greedy set cover: choose the fewest useful scenarios that cover the most distinct failure
 * patterns. Ties are deterministic. This is a test selector, not a quality score.
 */
export function selectPatternRepresentatives(cases: PatternCase[]): PatternCase[] {
  const remaining = new Set(cases.flatMap((c) => c.patterns));
  const pool = cases.filter((c) => c.patterns.length).sort((a, b) => a.id.localeCompare(b.id));
  const selected: PatternCase[] = [];
  while (remaining.size) {
    const best = pool
      .filter((c) => !selected.includes(c))
      .map((c) => ({ c, gain: c.patterns.filter((p) => remaining.has(p)).length }))
      .filter((x) => x.gain)
      .sort((a, b) => b.gain - a.gain || a.c.id.localeCompare(b.c.id))[0];
    if (!best) break;
    selected.push(best.c);
    best.c.patterns.forEach((p) => remaining.delete(p));
  }
  return selected;
}

