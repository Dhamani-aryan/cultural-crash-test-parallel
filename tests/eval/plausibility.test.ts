import { describe, expect, it } from "vitest";
import { nameKey } from "@/lib/engine/stats";
import { caseKey, checkPlausibility, PLAUSIBILITY, type PlausibilityFile, type PlausibilityRow } from "../../eval/plausibility";

describe("plausibility cases", () => {
  it("never use the choice under test as an audience anchor (Qloo would test it against itself)", () => {
    for (const c of PLAUSIBILITY) {
      const anchors = new Set((c.brief.audienceAnchors ?? []).map(nameKey));
      for (const choice of c.brief.existingChoices ?? []) expect(anchors.has(nameKey(choice.name)), `${c.id}: ${choice.name}`).toBe(false);
    }
  });

  it("cover every requirement the plan lists, with several expecting the original to stay", () => {
    expect(new Set(PLAUSIBILITY.map((c) => c.covers)).size).toBe(6);
    expect(PLAUSIBILITY.filter((c) => c.expect === "keep").length).toBeGreaterThanOrEqual(3);
    expect(new Set(PLAUSIBILITY.map((c) => c.brief.marketId)).size).toBeGreaterThanOrEqual(4);
  });
});

describe("plausibility run validation", () => {
  // Copies with reviewed set, for the gate's arithmetic only; the real cases stay unreviewed.
  const reviewedCases = PLAUSIBILITY.map((c) => ({ ...c, reviewed: true }));
  const B = { runVersion: "crash:v14", ranking: "v2", model: "agent-model" };
  const graded = { verdict: "credible" as const, reason: "A plausible act for this launch.", reviewer: "Test Reviewer" };
  const rowFor = (c: (typeof PLAUSIBILITY)[number], over: Partial<PlausibilityRow> = {}): PlausibilityRow => ({
    id: c.id,
    caseKey: caseKey(c),
    reviewed: true,
    expect: c.expect,
    original: "Original",
    final: "Final",
    changed: true,
    expectationHeld: true,
    flagged: false,
    status: "supported",
    review: graded,
    error: null,
    ...over,
  });
  const file = (rows = reviewedCases.map((c) => rowFor(c)), over: Partial<PlausibilityFile> = {}): PlausibilityFile => ({ ranAt: "2026-10-22T00:00:00Z", ...B, rows, ...over });
  const check = (f: PlausibilityFile, cases = reviewedCases) => checkPlausibility(f, cases, B);

  it("accepts exactly one current, error-free, graded row per case", () => {
    const r = check(file());
    expect(r.problems).toEqual([]);
    expect(r.tally).toEqual({ cases: 7, rows: 7, uniqueIds: 7, valid: 7, graded: 7, implausible: 0, problems: 0 });
  });

  it("rejects a missing case", () => {
    const r = check(file(reviewedCases.slice(1).map((c) => rowFor(c))));
    expect(r.problems).toEqual([`Plausibility case ${PLAUSIBILITY[0].id} has no row.`]);
    expect(r.tally).toMatchObject({ rows: 6, uniqueIds: 6, valid: 6 });
  });

  it("rejects a duplicate row and counts unique ids", () => {
    const rows = reviewedCases.map((c) => rowFor(c));
    const r = check(file([...rows, rowFor(reviewedCases[0], { review: { ...graded, verdict: "implausible" } })]));
    expect(r.problems).toEqual([`Plausibility case ${PLAUSIBILITY[0].id} has 2 rows.`]);
    // Neither copy counts, so a duplicate can't hide or invent a grade.
    expect(r.tally).toMatchObject({ rows: 8, uniqueIds: 7, valid: 6, graded: 6, implausible: 0 });
  });

  it("rejects a row for a case that isn't in the current suite", () => {
    const r = check(file([...reviewedCases.map((c) => rowFor(c)), rowFor(reviewedCases[0], { id: "retired-case" })]));
    expect(r.problems).toEqual(["Plausibility row for an unknown case: retired-case."]);
    expect(r.tally).toMatchObject({ rows: 8, uniqueIds: 8, valid: 7 });
  });

  it("rejects stale rows: a changed case, or no recorded fingerprint", () => {
    const changed = { ...reviewedCases[0], expect: reviewedCases[0].expect === "keep" ? ("replace_ok" as const) : ("keep" as const) };
    const r = check(file(), [changed, ...reviewedCases.slice(1)]);
    expect(r.problems).toEqual([`Plausibility case ${changed.id} is stale: the case changed after it ran.`]);
    expect(r.tally.valid).toBe(6);
    const old = check(file(reviewedCases.map((c, i) => rowFor(c, i === 1 ? { caseKey: undefined } : {}))));
    expect(old.problems).toEqual([`Plausibility case ${PLAUSIBILITY[1].id} is stale: its case fingerprint was not recorded.`]);
  });

  it("rejects a run from another agent version, ranking or model, or one that didn't record them", () => {
    expect(check(file(undefined, { runVersion: "crash:v13" })).problems).toEqual(["Plausibility run is stale: agent version crash:v13, B crash:v14."]);
    expect(check(file(undefined, { ranking: "v1" })).problems).toEqual(["Plausibility run is stale: ranking v1, B v2."]);
    expect(check(file(undefined, { model: "other-model" })).problems).toEqual(["Plausibility run is stale: agent model other-model, B agent-model."]);
    expect(check(file(undefined, { model: undefined })).problems).toEqual(["Plausibility run's agent model not recorded (run: missing, B: agent-model)."]);
  });

  it("rejects errored rows", () => {
    const r = check(file(reviewedCases.map((c, i) => rowFor(c, i === 0 ? { error: "Qloo timeout", final: null, review: null } : i === 1 ? { final: null } : {}))));
    expect(r.problems).toEqual([`Plausibility case ${PLAUSIBILITY[0].id} errored: Qloo timeout.`, `Plausibility case ${PLAUSIBILITY[1].id} errored: no final choice.`]);
    expect(r.tally).toMatchObject({ valid: 5, graded: 5 });
  });

  it("counts a grade only for a reviewed case with a verdict, a reason and a reviewer", () => {
    const unreviewed = reviewedCases.map((c, i) => (i === 0 ? { ...c, reviewed: false } : c));
    const r1 = check(file(), unreviewed);
    expect(r1.problems).toEqual([]);
    expect(r1.tally).toMatchObject({ valid: 7, graded: 6 });
    const r2 = check(file(reviewedCases.map((c, i) => rowFor(c, i === 0 ? { review: { ...graded, reviewer: " " } } : i === 1 ? { review: null } : {}))));
    expect(r2.problems).toEqual([`Plausibility case ${PLAUSIBILITY[0].id} has an incomplete grade (needs verdict, reason and reviewer).`]);
    expect(r2.tally).toMatchObject({ valid: 7, graded: 5 });
  });

  it("counts implausible grades on valid rows", () => {
    const r = check(file(reviewedCases.map((c, i) => rowFor(c, i < 2 ? { review: { ...graded, verdict: "implausible" } } : {}))));
    expect(r.tally).toMatchObject({ graded: 7, implausible: 2 });
  });

});
