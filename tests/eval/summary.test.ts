import { describe, expect, it } from "vitest";
import type { CaseRow } from "../../eval/run";
import { comparisonBlockers, decide, gates, summarize, type PlausibilityTally, type RunFile } from "../../eval/summary";

const scored = (supported: number) => ({ supported, total: 0.6, statuses: {} });
function row(id: string, draft: number, final: number, opts: Partial<{ evidence: "agent" | "tie" | "draft"; ms: number; violations: number; unknown: number; checks: number }> = {}): CaseRow {
  return {
    id,
    split: "heldout",
    city: "London",
    draft: [],
    final: [],
    draftUnresolved: [],
    inRun: { draft: scored(draft), final: scored(final) },
    heldOut: { anchors: [], missing: [], draft: scored(draft), final: scored(final) },
    evidenceJudge: opts.evidence ? ({ preferred: opts.evidence, consistent: true } as CaseRow["evidenceJudge"]) : null,
    judge: { preferred: "draft", consistent: true } as CaseRow["judge"],
    run: {
      stopReason: "acceptance_criteria_met",
      stopDetail: undefined,
      currentIteration: 1,
      qlooCallsUsed: opts.checks ?? 100,
      llmCalls: 4,
      ms: opts.ms ?? 60_000,
      changes: [
        { slot: "artist_music", before: "a", after: "b", reverted: false },
        { slot: "artist_music", before: "a", after: "c", reverted: true },
      ],
      metrics: {
        violations: opts.violations ?? 0,
        unknownUserChoicesChanged: opts.unknown ?? 0,
        accepted: 1,
        rejected: 1,
        abstained: 1,
        qlooChecks: opts.checks ?? 100,
        qlooReused: 10,
        qlooCacheHits: 40,
        qlooRequests: 50,
      },
    },
    error: null,
  };
}

describe("eval summary", () => {
  it("counts exactly, with the median and slowest run", () => {
    const s = summarize([row("a", 0, 2, { evidence: "agent", ms: 30_000 }), row("b", 1, 1, { evidence: "tie", ms: 50_000 }), row("c", 2, 1, { evidence: "draft", ms: 90_000 })]);
    expect(s).toMatchObject({ heldOutDraft: 3, heldOutFinal: 4, slots: 12, improved: 1, unchanged: 1, worsened: 1, accepted: 3, rejected: 3, abstained: 3, qlooRequests: 150, qlooCacheHits: 120, medianMs: 50_000, slowestMs: 90_000 });
    expect(s.evidence).toEqual({ agent: 1, tie: 1, draft: 1, judged: 3, consistent: 3 });
  });

  it("says 'not measured' rather than inventing request counts", () => {
    const r = row("a", 0, 1);
    r.run.metrics!.qlooRequests = null;
    expect(summarize([r, row("b", 0, 1)]).qlooRequests).toBeNull();
  });
});

/** A fully valid plausibility run of seven cases, all reviewed and graded, none implausible. */
const tally = (over: Partial<PlausibilityTally> = {}): PlausibilityTally => ({ cases: 7, rows: 7, uniqueIds: 7, valid: 7, graded: 7, implausible: 0, problems: 0, ...over });

describe("merge gates", () => {
  const A = summarize([row("a", 0, 2, { evidence: "agent" }), row("b", 0, 2, { evidence: "agent" })]);
  const allGraded = tally();

  it("leave the human gate undecided until every case is reviewed and graded", () => {
    const B = summarize([row("a", 0, 3, { evidence: "agent" }), row("b", 0, 2, { evidence: "tie" })]);
    const human = (p: Parameters<typeof gates>[2]) => gates(A, B, p).find((x) => x.name.startsWith("No reviewed plausibility"))!.pass;
    expect(human(null)).toBeNull();
    expect(human(tally({ graded: 0 }))).toBeNull();
    expect(human(tally({ graded: 6 }))).toBeNull();
    expect(human(tally({ graded: 2, implausible: 1 }))).toBe(false);
    expect(human(allGraded)).toBe(true);
    // Every case graded is not enough while the run itself is invalid.
    expect(human(tally({ problems: 1 }))).toBeNull();
    expect(human(tally({ valid: 6 }))).toBeNull();
    expect(human(tally({ rows: 8 }))).toBeNull();
    expect(human(tally({ uniqueIds: 6 }))).toBeNull();
    expect(gates(A, B, null).filter((x) => x.pass === false)).toEqual([]);
  });

  it("fail on a held-out reduction, an evidence loss, a violation or a cost blow-up", () => {
    const B = summarize([row("a", 0, 1, { evidence: "draft", violations: 1, checks: 300 }), row("b", 0, 2, { evidence: "agent", unknown: 1 })]);
    const failed = gates(A, B, tally({ implausible: 1 })).filter((x) => x.pass === false).map((x) => x.name);
    expect(failed).toEqual([
      "Zero hard-constraint violations",
      "Zero Qloo-unknown user choices replaced",
      "No evidence-judge losses",
      "No reduction in total held-out support",
      "No reviewed plausibility case implausible",
      "No material cost or latency regression (≤ 25% more)",
    ]);
  });
});

describe("merge decision", () => {
  const ids = ["a", "b"];
  const file = (over: Partial<RunFile> = {}, cases = [row("a", 0, 2, { evidence: "agent" }), row("b", 0, 2, { evidence: "agent" })]): RunFile => ({
    ranAt: "2026-10-22T00:00:00Z",
    runVersion: "crash:v14",
    ranking: "v1",
    frozen: "b1",
    model: "agent-model",
    judgeModel: "judge-model",
    cases,
    ...over,
  });
  const ctx = { expectedCaseIds: ids, baseline: { id: "b1", caseIds: ids } };
  const allGraded = tally();
  const verdict = (a: RunFile, b: RunFile, plaus: Parameters<typeof gates>[2] = allGraded, c: Parameters<typeof comparisonBlockers>[2] = ctx) => {
    const blockers = comparisonBlockers(a, b, c);
    return { ...decide(gates(summarize(a.cases), summarize(b.cases), plaus), blockers), blockers };
  };

  it("allows a merge only on a valid comparison with every required gate passed", () => {
    const d = verdict(file(), file({ ranking: "v2" }));
    expect(d.blockers).toEqual([]);
    expect(d.verdict).toBe("merge_b");
  });

  it("is incomplete, not a merge, while the human plausibility gate is undecided", () => {
    const d = verdict(file(), file({ ranking: "v2" }), null);
    expect(d.blockers).toEqual([]);
    expect(d).toMatchObject({ verdict: "incomplete", text: expect.stringMatching(/^Decision: incomplete; do not merge B/) });
    expect(verdict(file(), file({ ranking: "v2" }), tally({ graded: 3 })).verdict).toBe("incomplete");
  });

  it("is incomplete when a required measurement is missing", () => {
    const b = file({ ranking: "v2" });
    b.cases[0].run.metrics = undefined;
    expect(verdict(file(), b).verdict).toBe("incomplete");
  });

  it("blocks a run with a missing case or an incompletely scored brief", () => {
    const missing = verdict(file(), file({ ranking: "v2" }, [row("a", 0, 2, { evidence: "agent" })]));
    expect(missing.verdict).not.toBe("merge_b");
    expect(missing.blockers).toEqual(expect.arrayContaining(["B is missing expected case(s): b.", "B is missing baseline case(s): b."]));
    const unscored = row("b", 0, 2);
    const d = verdict(file(), file({ ranking: "v2" }, [row("a", 0, 2, { evidence: "agent" }), unscored]));
    expect(d.verdict).toBe("incomplete");
    expect(d.blockers).toEqual(["B b is not fully scored (no evidence-judge verdict)."]);
  });

  it("blocks mismatched, missing or live baselines", () => {
    expect(verdict(file(), file({ ranking: "v2", frozen: "b2" })).blockers).toContain("Different baselines: A b1, B b2.");
    expect(verdict(file({ frozen: null }), file({ ranking: "v2" })).blockers).toContain("A is a live run, not from a frozen baseline.");
    const gone = verdict(file(), file({ ranking: "v2" }), allGraded, { ...ctx, baseline: null });
    expect(gone.blockers).toContain("Baseline b1 was not found.");
    expect(gone.verdict).toBe("incomplete");
  });

  it("blocks differing or unrecorded agent and judge models", () => {
    expect(verdict(file(), file({ ranking: "v2", model: "other" })).blockers).toContain("Different agent model: A agent-model, B other.");
    expect(verdict(file(), file({ ranking: "v2", judgeModel: "other" })).blockers).toContain("Different judge model: A judge-model, B other.");
    const old = verdict(file({ judgeModel: undefined }), file({ ranking: "v2", judgeModel: undefined }));
    expect(old.blockers).toContain("Judge model not recorded (A: missing, B: missing).");
    expect(old.verdict).toBe("incomplete");
    expect(verdict(file(), file({ ranking: "v2", runVersion: "crash:v15" })).verdict).toBe("incomplete");
  });

  it("still keeps A when a gate fails, and says the comparison is invalid too", () => {
    const d = verdict(file(), file({ ranking: "v2", frozen: "b2" }, [row("a", 0, 1, { evidence: "agent" }), row("b", 0, 2, { evidence: "agent" })]));
    expect(d.verdict).toBe("keep_a");
    expect(d.text).toMatch(/also invalid for merging/);
  });

});
