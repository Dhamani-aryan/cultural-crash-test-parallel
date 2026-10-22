import { describe, expect, it } from "vitest";
import { fuseRanks, RRF_K } from "@/lib/crashtest/repair";
import { runCrashTest } from "@/lib/crashtest/run";
import { LONDON_BRIEF, W, worldClient, worldLlm } from "./world";

describe("reciprocal rank fusion", () => {
  it("adds 1 / (k + rank) per list and keeps each candidate's rank in every view", () => {
    const f = fuseRanks([
      { view: "audience", ids: ["a", "b", "c"] },
      { view: "local", ids: ["c", "a"] },
      { view: "coherence", ids: ["b"] },
    ]);
    expect(f.get("a")!.score).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 2));
    expect(f.get("a")!.views).toEqual({ audience: 1, local: 2 });
    expect(f.get("c")!.views).toEqual({ audience: 3, local: 1 });
    // A candidate near the top of two views ranks first overall.
    const order = [...f].sort((x, y) => y[1].score - x[1].score).map(([id]) => id);
    expect(order[0]).toBe("a");
  });

  it("counts a candidate once per view even if a list repeats it", () => {
    const f = fuseRanks([{ view: "audience", ids: ["a", "a"] }]);
    expect(f.get("a")).toEqual({ score: 1 / (RRF_K + 1), views: { audience: 1 } });
  });
});

describe("ranking v2 (multi-view retrieval) in a full run", () => {
  it("repairs the same choice, records each view and the fused rank, and keeps v1 as the default", async () => {
    const v1 = await runCrashTest({ qloo: worldClient().client, llm: worldLlm().llm }, LONDON_BRIEF, { ranking: "v1" });
    const v2 = await runCrashTest({ qloo: worldClient().client, llm: worldLlm().llm }, LONDON_BRIEF, { ranking: "v2" });
    expect(v2.changes.find((c) => !c.reverted)).toMatchObject({ slot: "artist_music", before: "Big Tex", after: "Grey Lane" });
    const grey = v2.trials!.find((t) => t.name === "Grey Lane")!;
    expect(grey.views).toMatchObject({ audience: 1, local: 1 });
    expect(grey.fusedRank).toBe(1);
    // Every view is in the ledger, and the trial cites only those it appeared in.
    const purposes = v2.evidenceLedger.map((r) => r.purpose);
    expect(purposes.some((p) => /candidates for this audience/.test(p))).toBe(true);
    expect(purposes.some((p) => /own top list/.test(p))).toBe(true);
    const ids = new Set(v2.evidenceLedger.map((r) => r.evidenceId));
    for (const id of grey.evidenceIds) expect(ids.has(id)).toBe(true);
    // v1 keeps its single combined list and no view ranks.
    expect(v1.trials!.find((t) => t.name === "Grey Lane")!.views).toBeUndefined();
  });
});

describe("ranking v2 provenance of an accepted change", () => {
  const run = (over: Parameters<typeof worldLlm>[0]) =>
    runCrashTest({ qloo: worldClient().client, llm: worldLlm(over).llm }, LONDON_BRIEF, { ranking: "v2" });
  const recordIds = (s: Awaited<ReturnType<typeof run>>, purpose: RegExp) =>
    s.evidenceLedger.filter((r) => purpose.test(r.purpose)).map((r) => r.evidenceId);

  it("cites only the views the accepted candidate appeared in", async () => {
    // Canal Echo comes only from the agent's own suggestions: in no Qloo list view.
    const s = await run({ propose: ["Canal Echo"], pick: W.canalEcho.id });
    const change = s.changes.find((c) => !c.reverted)!;
    expect(change).toMatchObject({ slot: "artist_music", after: "Canal Echo" });
    expect(s.trials!.find((t) => t.name === "Canal Echo")!.views).toEqual({ proposals: 1 });
    const absent = [
      ...recordIds(s, /^Find music act candidates for this audience/),
      ...recordIds(s, /^Find music act candidates that fit the rest of the plan/),
      ...recordIds(s, /own top list for this kind of music act/),
    ];
    expect(absent.length).toBeGreaterThanOrEqual(3);
    for (const id of absent) expect(change.triggeringEvidenceIds).not.toContain(id);
    // Its own scoring and the screen are cited, and so is the controller's assessment evidence.
    const [scoring] = recordIds(s, /^Score the agent's own music act suggestions/);
    const [screenId] = recordIds(s, /^Screen candidates for locality/);
    expect(change.triggeringEvidenceIds).toEqual(expect.arrayContaining([scoring, screenId, ...recordIds(s, /^Is Big Tex local to London/)]));
  });

  it("omits the suggestion-scoring record when the accepted candidate wasn't a suggestion", async () => {
    const s = await run({ propose: ["Canal Echo"], pick: W.localRapper.id });
    const change = s.changes.find((c) => !c.reverted)!;
    expect(change.after).toBe("Grey Lane");
    const [scoring] = recordIds(s, /^Score the agent's own music act suggestions/);
    expect(scoring).toBeDefined();
    expect(change.triggeringEvidenceIds).not.toContain(scoring);
    expect(change.triggeringEvidenceIds).toEqual(expect.arrayContaining(recordIds(s, /^Find music act candidates for this audience/)));
  });
});
