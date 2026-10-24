import { describe, expect, it } from "vitest";
import { agentReceipt, briefConstants, buildDecisions, changeCount, sameChoice, summarizeRun, type DecisionExplanation } from "@/lib/crashtest/explain";
import { runCrashTest } from "@/lib/crashtest/run";
import type { Component, LaunchBriefInput, RunState } from "@/lib/crashtest/types";
import { LONDON_BRIEF, worldClient, worldLlm } from "./world";

const run = (brief: LaunchBriefInput = LONDON_BRIEF, over: Parameters<typeof worldLlm>[0] = {}) =>
  runCrashTest({ qloo: worldClient().client, llm: worldLlm(over).llm }, brief);
const slot = (s: RunState, name: string) => buildDecisions(s).find((e) => e.slot === name)!;
const allText = (d: DecisionExplanation) =>
  [d.summaryReason, ...d.whyAway, ...d.whyToward, ...d.whyStayed, ...d.preservedConstraints, ...d.limitations, ...d.evidence.map((e) => e.value)].join(" ");

describe("buildDecisions", () => {
  it("gives a changed choice a short row reason, why-away and why-toward", async () => {
    const s = await run();
    const d = slot(s, "artist_music");
    expect(d).toMatchObject({ changed: true, baseline: { label: "Big Tex", status: "no_support" }, revised: { label: "Grey Lane", status: "supported" } });
    expect(d.summaryReason.length).toBeLessThanOrEqual(90);
    expect(d.reasonCodes).toContain("audience_contradiction");
    expect(d.whyAway).toHaveLength(2);
    expect(d.whyAway[0]).toMatch(/No audience support was returned for Big Tex/);
    expect(d.whyAway[1]).toMatch(/LLM added it without Qloo data/);
    expect(d.whyToward).toHaveLength(2);
    expect(d.whyToward[1]).toMatch(/moved from No support found to Supported/);
    expect(d.whyStayed).toEqual([]);
    expect(d.acceptedChange?.after).toBe("Grey Lane");
    expect(changeCount(s)).toBe(1);
  });

  it("keeps the three stages apart: unspecified slots stay null, user choices keep user provenance", async () => {
    const s = await run({ ...LONDON_BRIEF, existingChoices: [{ slot: "artist_music", name: "Big Tex" }] });
    const act = slot(s, "artist_music");
    expect(act.userChoice).toEqual({ label: "Big Tex", locked: false });
    expect(act.baseline.origin).toBe("user_provided");
    expect(act.whyAway[1]).toMatch(/You chose it but didn't lock it/);
    for (const other of ["brand_collaboration", "event_place", "creative_direction"]) {
      const d = slot(s, other);
      expect(d.userChoice).toBeNull();
      expect(d.baseline.origin).toBe("agent_proposed");
    }
  });

  it("says why a supported choice stayed", async () => {
    const d = slot(await run(), "event_place");
    expect(d.changed).toBe(false);
    expect(d.reasonCodes).toContain("already_supported");
    expect(d.summaryReason).toMatch(/^Already supported/);
    expect(d.whyStayed.join(" ")).toMatch(/nothing to fix/);
    expect(d.whyAway).toEqual([]);
  });

  it("shows a locked choice as fixed by the user, never as replaceable", async () => {
    const s = await run({
      ...LONDON_BRIEF,
      existingChoices: [{ slot: "artist_music", name: "Big Tex" }],
      constraints: [{ id: "l", kind: "hard", lockSlot: "artist_music", description: "Big Tex is booked" }],
    });
    const d = slot(s, "artist_music");
    expect(d.changed).toBe(false);
    expect(d.userChoice).toEqual({ label: "Big Tex", locked: true });
    expect(d.reasonCodes).toContain("constraint_locked");
    expect(d.whyStayed[0]).toMatch(/never open to replacement/);
    expect(d.evidence.find((e) => e.kind === "constraint")).toMatchObject({ source: "user", value: "Big Tex is booked" });
    expect(allText(d)).not.toMatch(/open to (alternatives|repair)/);
    // Another row names the lock among what stayed fixed.
    expect(slot(s, "event_place").preservedConstraints.join(" ")).toMatch(/Big Tex stayed in place/);
  });

  it("retains and flags a Qloo-unknown brand under a rule code can't verify", async () => {
    const s = await run(
      { ...LONDON_BRIEF, brandAttributes: ["workwear"], constraints: [{ id: "r", kind: "hard", description: "No luxury collaboration" }] },
      { draft: { brand: "Unknown Collective" } },
    );
    const d = slot(s, "brand_collaboration");
    expect(d.changed).toBe(false);
    expect(d.reasonCodes).toEqual(expect.arrayContaining(["user_rule_unverified", "qloo_unknown"]));
    expect(d.whyStayed.join(" ")).toMatch(/could not verify.*can't be fully checked/);
    expect(d.limitations.join(" ")).toMatch(/treat it as a hypothesis/);
    expect(d.preservedConstraints.join(" ")).toMatch(/“No luxury collaboration” stays in force/);
    expect(allText(d)).not.toMatch(/\bis (wrong|bad|unsuitable|a poor)\b/);
  });

  it("describes absent evidence with uncertainty, never as proof", async () => {
    const d = slot(await run(), "artist_music");
    expect(d.limitations.join(" ")).toMatch(/No support was returned in this test; that is not proof/);
    expect(d.evidence[0].value).toMatch(/Big Tex: No support returned in this test/);
  });

  it("keeps tried-and-rejected candidates apart from the accepted change", async () => {
    const s = await run();
    const reverted = { ...s.changes[0], after: "Coast Kid", reverted: true, observedEffect: "Music act n/a → 0.25 (weak)" };
    const d = slot({ ...s, changes: [reverted, ...s.changes] }, "artist_music");
    expect(d.acceptedChange?.after).toBe("Grey Lane");
    expect(d.alternatives.map((c) => c.after)).toEqual(["Coast Kid"]);
    expect(d.whyToward[1]).toMatch(/ahead of 1 other tested candidate\./);
  });

  it("evidence summaries cite only ledger records and name their source", async () => {
    const s = await run();
    const ids = new Set(s.evidenceLedger.map((r) => r.evidenceId));
    const ds = buildDecisions(s);
    const cited = ds.flatMap((d) => [...d.evidenceIds, ...d.evidence.flatMap((e) => e.evidenceIds)]);
    expect(cited.length).toBeGreaterThan(0);
    for (const id of cited) expect(ids.has(id)).toBe(true);
    for (const d of ds) {
      expect(d.evidence.map((e) => e.label).slice(0, 3)).toEqual(["Audience signal", "Local signal", "Plan signal"]);
      expect(d.evidence.find((e) => e.kind === "plan")?.source).toBe("application");
    }
  });

  it("takes preserved constraints from the recorded brief", async () => {
    const s = await run({ ...LONDON_BRIEF, constraints: [{ id: "x", kind: "hard", description: "No collaboration with Supreme", excludeNames: ["Supreme"] }] });
    const d = slot(s, "artist_music");
    expect(d.preservedConstraints).toContain("“No collaboration with Supreme” held: no excluded name entered the plan.");
    expect(d.preservedConstraints.at(-1)).toMatch(/audience, London market and launch goal did not change/);
  });

  it("orders changed choices first and numbers them", async () => {
    const ds = buildDecisions(await run());
    expect(ds[0].changed).toBe(true);
    expect(ds.map((d) => d.sequence)).toEqual([1, 2, 3, 4]);
  });

  it("never claims commercial success or a probability", async () => {
    const text = buildDecisions(await run()).map(allText).join(" ");
    expect(text).not.toMatch(/\b(will (succeed|sell|win)|guarantee|probability|chance of success)\b/i);
    expect(text).toMatch(/not a forecast of commercial success/);
  });

  it("treats a relabelled direction with the same tags as unchanged", () => {
    const c = (label: string): Component => ({
      slot: "creative_direction",
      label,
      origin: "agent_proposed",
      locked: false,
      resolution: "resolved",
      entity: null,
      tags: [{ id: "t1", name: "Industrial" }],
      placeCategory: null,
    });
    expect(sameChoice(c("Industrial"), c("Industrial, refined"))).toBe(true);
  });

  it("returns nothing for a run with no evaluation", () => {
    expect(buildDecisions({ evaluations: [] } as unknown as RunState)).toEqual([]);
    expect(summarizeRun({ evaluations: [] } as unknown as RunState)).toBeNull();
  });
});

describe("summarizeRun and briefConstants", () => {
  it("counts the three stages and states the delta truthfully", async () => {
    const s = await run({ ...LONDON_BRIEF, existingChoices: [{ slot: "event_place", name: "Yard Hall" }] });
    const sum = summarizeRun(s)!;
    expect(sum).toMatchObject({ changed: 2, retained: 2, total: 4, userSpecified: 1, llmAdded: 3, outcome: "agent" });
    expect(sum.headline).toBe("2 choices changed. 2 retained.");
    expect(sum.detail).toMatch(/fewer choice|more supported/);
    expect(sum.revisedSupported).toBeGreaterThan(sum.baselineSupported);
  });

  it("says so when nothing changed", async () => {
    const s = await run();
    const same = { ...s, plan: s.initialPlan, changes: [], evaluations: [s.evaluations[0], s.evaluations[0]] };
    const sum = summarizeRun(same)!;
    expect(sum.outcome).toBe("same");
    expect(sum.detail).toMatch(/No choice changed/);
  });

  it("lists the shared brief context once", async () => {
    const s = await run({ ...LONDON_BRIEF, brandAttributes: ["utilitarian"], constraints: [{ id: "x", kind: "hard", description: "No Supreme", excludeNames: ["Supreme"] }] });
    expect(briefConstants(s).map((c) => c.label)).toEqual(["Market", "Audience", "Goal", "Brand", "Rules"]);
  });
});

describe("agentReceipt", () => {
  it("counts only what the run recorded, in accurate terms", async () => {
    const s = await run({ ...LONDON_BRIEF, constraints: [{ id: "x", kind: "hard", description: "No Supreme", excludeNames: ["Supreme"] }] });
    const live = { ...s, finishedAt: "2026-10-22T10:00:00.000Z", provenance: { mode: "live" as const, runVersion: "t" } };
    const r = agentReceipt(live)!;
    expect(r).toMatchObject({
      choicesTested: 4,
      candidatesConsidered: s.trials!.length,
      alternativesTested: s.changes.length,
      accepted: 1,
      retained: 3,
      qlooChecks: s.qlooUsage!.checks,
      evidenceRecords: s.evidenceLedger.length,
      hardConstraints: 1,
      constraintsPreserved: 1,
      date: "22 Oct 2026",
    });
    const n = s.changes.length;
    expect(r.lines[1]).toBe(`${s.qlooUsage!.checks} Qloo checks · 1 constraint preserved · full plan re-tested ${n === 1 ? "once" : n === 2 ? "twice" : `${n} times`}`);
    expect(r.lines[2]).toBe("Live run · 22 Oct 2026");
  });

  it("dates a recorded run by its recording, and reports requests only when measured", async () => {
    const s = await run();
    const rec = { ...s, provenance: { mode: "recorded" as const, recordedAt: "2026-10-01T08:00:00.000Z", runVersion: "t" } };
    expect(agentReceipt(rec)!.lines[2]).toBe("Recorded run · 1 Oct 2026");
    expect(agentReceipt(rec)!.lines[1]).not.toMatch(/sent to Qloo/);
    const measured = { ...rec, qlooUsage: { ...s.qlooUsage!, cacheHits: 40, requests: 12 } };
    expect(agentReceipt(measured)!.lines[1]).toMatch(/Qloo checks · 12 sent to Qloo/);
  });

  it("leaves out constraints when the brief has none, and the mode when it wasn't recorded", async () => {
    const s = await run();
    expect(agentReceipt(s)!.lines[1]).not.toMatch(/constraint/);
    expect(agentReceipt({ ...s, provenance: undefined })!.lines[2]).not.toMatch(/run/);
  });
});
