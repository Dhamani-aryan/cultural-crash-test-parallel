import { describe, expect, it } from "vitest";
import { comparePlans } from "@/lib/crashtest/compare";
import { runCrashTest } from "@/lib/crashtest/run";
import type { ComponentAssessment, ComponentStatus, PlanEvaluation, RunState, Slot } from "@/lib/crashtest/types";
import { LONDON_BRIEF, W, worldClient, worldLlm } from "./world";

const SLOTS: Slot[] = ["artist_music", "brand_collaboration", "event_place", "creative_direction"];

function comp(slot: Slot, label: string, status: ComponentStatus, over: Partial<ComponentAssessment> = {}): ComponentAssessment {
  const scored = status !== "unresolved" && status !== "no_support";
  return {
    slot,
    label,
    status,
    total: scored ? (status === "supported" ? 0.9 : 0.4) : undefined,
    coverage: status === "unresolved" ? "insufficient" : "adequate",
    dimensions:
      status === "unresolved"
        ? []
        : [{ key: "audience", score: scored ? 0.8 : undefined, weight: 0.35, evidenceIds: [`E-${slot}-${label}`], explanation: "x" }],
    finding: `${label} finding`,
    contradicted: status === "no_support",
    ...over,
  };
}

function evaluation(components: ComponentAssessment[], over: Partial<PlanEvaluation> = {}): PlanEvaluation {
  const totals = components.flatMap((c) => (c.total === undefined ? [] : [c.total]));
  return {
    iteration: 0,
    rubricVersion: "crash-v1",
    totalScore: totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : undefined,
    supported: components.filter((c) => c.status === "supported").length,
    scored: totals.length,
    contradicted: components.filter((c) => c.contradicted).length,
    components,
    hardConstraintViolations: [],
    weakest: [],
    accepted: true,
    ...over,
  };
}

function state(first: ComponentAssessment[], last: ComponentAssessment[], over: Partial<RunState> = {}): RunState {
  const ids = [...first, ...last].flatMap((c) => c.dimensions.flatMap((d) => d.evidenceIds));
  return {
    evaluations: [evaluation(first), evaluation(last)],
    evidenceLedger: ids.map((evidenceId) => ({ evidenceId })),
    ...over,
  } as unknown as RunState;
}

const same = (slot: Slot) => comp(slot, `same-${slot}`, "supported");

describe("comparePlans", () => {
  it("prefers the agent when it removes a contradicted choice", () => {
    const first = [comp("artist_music", "Big Tex", "no_support"), ...SLOTS.slice(1).map(same)];
    const last = [comp("artist_music", "Grey Lane", "supported"), ...SLOTS.slice(1).map(same)];
    const c = comparePlans(state(first, last))!;
    expect(c.outcome).toBe("agent");
    expect(c.decidedBy).toBe("contradicted");
    expect(c.componentComparisons[0].outcome).toBe("agent");
    expect(c.componentComparisons.slice(1).every((x) => x.outcome === "same")).toBe(true);
  });

  it("can prefer the baseline", () => {
    const first = [comp("artist_music", "Grey Lane", "supported"), ...SLOTS.slice(1).map(same)];
    const last = [comp("artist_music", "Big Tex", "no_support"), ...SLOTS.slice(1).map(same)];
    expect(comparePlans(state(first, last))!.outcome).toBe("baseline");
  });

  it("calls it mixed when each plan wins a different choice and they're level overall", () => {
    const first = [comp("artist_music", "A", "supported"), comp("brand_collaboration", "B", "weak"), same("event_place"), same("creative_direction")];
    const last = [comp("artist_music", "A2", "weak"), comp("brand_collaboration", "B2", "supported"), same("event_place"), same("creative_direction")];
    const c = comparePlans(state(first, last))!;
    expect(c.outcome).toBe("mixed");
    expect(c.componentComparisons.map((x) => x.outcome)).toEqual(["baseline", "agent", "same", "same"]);
  });

  it("says when there isn't enough evidence", () => {
    const first = SLOTS.map((s) => comp(s, `x-${s}`, "unresolved"));
    const last = SLOTS.map((s) => comp(s, `y-${s}`, "unresolved"));
    const c = comparePlans(state(first, last))!;
    expect(c.outcome).toBe("insufficient_evidence");
    expect(c.componentComparisons.every((x) => x.outcome === "insufficient_evidence")).toBe(true);
  });

  it("puts hard constraints first", () => {
    const first = [comp("artist_music", "A", "supported"), ...SLOTS.slice(1).map(same)];
    const last = [comp("artist_music", "A2", "supported"), ...SLOTS.slice(1).map(same)];
    const s = state(first, last);
    s.evaluations[1].hardConstraintViolations = ["Uses an excluded name"];
    const c = comparePlans(s)!;
    expect(c.outcome).toBe("baseline");
    expect(c.decidedBy).toBe("hard_constraints");
  });

  it("decides the winner in code: the model's verdict text can't change it", () => {
    const first = [comp("artist_music", "Grey Lane", "supported"), ...SLOTS.slice(1).map(same)];
    const last = [comp("artist_music", "Big Tex", "no_support"), ...SLOTS.slice(1).map(same)];
    const c = comparePlans(state(first, last, { verdict: "The agent's plan is clearly better in every way." }))!;
    expect(c.outcome).toBe("baseline");
  });

  it("cites only evidence that exists in the ledger, on a real run", async () => {
    const { client } = worldClient();
    const { llm } = worldLlm();
    const run = await runCrashTest({ qloo: client, llm }, LONDON_BRIEF);
    const c = comparePlans(run)!;
    expect(c.outcome).toBe("agent");
    const ids = new Set(run.evidenceLedger.map((r) => r.evidenceId));
    const cited = c.componentComparisons.flatMap((x) => x.evidenceIds);
    expect(cited.length).toBeGreaterThan(0);
    for (const id of cited) expect(ids.has(id)).toBe(true);
  });
});

describe("user choices and the exploration switch", () => {
  const thinUserChoice = { ...LONDON_BRIEF, existingChoices: [{ slot: "artist_music" as const, name: "Canal Echo" }] };

  it("keeps a thin, uncontradicted user choice when exploration is off", async () => {
    const { client } = worldClient();
    const { llm } = worldLlm({ draft: { artist: "Canal Echo" } });
    const run = await runCrashTest({ qloo: client, llm }, { ...thinUserChoice, exploreUserChoices: false });
    expect(run.plan!.components.find((c) => c.slot === "artist_music")?.label).toBe("Canal Echo");
  });

  it("may upgrade it when exploration is on, but only to a Supported local pick", async () => {
    const { client } = worldClient();
    const { llm } = worldLlm({ draft: { artist: "Canal Echo" } });
    const run = await runCrashTest({ qloo: client, llm }, { ...thinUserChoice, exploreUserChoices: true });
    expect(run.plan!.components.find((c) => c.slot === "artist_music")?.label).toBe("Grey Lane");
  });

  it("never changes a locked user choice, even with exploration on", async () => {
    const { client } = worldClient();
    const { llm } = worldLlm({ draft: { artist: "Canal Echo" } });
    const run = await runCrashTest({ qloo: client, llm }, {
      ...thinUserChoice,
      exploreUserChoices: true,
      constraints: [{ id: "lock", kind: "hard", lockSlot: "artist_music", description: "Booked" }],
    });
    expect(run.plan!.components.find((c) => c.slot === "artist_music")?.label).toBe("Canal Echo");
    expect(run.changes.filter((c) => c.slot === "artist_music")).toHaveLength(0);
  });

  it("still replaces an unlocked user choice the evidence contradicts", async () => {
    const { client } = worldClient();
    const { llm } = worldLlm();
    const run = await runCrashTest({ qloo: client, llm }, { ...LONDON_BRIEF, existingChoices: [{ slot: "artist_music", name: "Big Tex" }] });
    expect(run.plan!.components.find((c) => c.slot === "artist_music")?.label).toBe(W.localRapper.name);
  });
});
