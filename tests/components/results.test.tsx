import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildDecisionTrace } from "@/lib/crashtest/decision-trace";
import { buildDecisions } from "@/lib/crashtest/explain";
import { buildJudgeGraph } from "@/lib/crashtest/judge-graph";
import { runCrashTest } from "@/lib/crashtest/run";
import type { LaunchBriefInput, RunState } from "@/lib/crashtest/types";
import { ComparisonTable, decisionNarrative } from "@/components/plan-comparison";
import JudgeGraphView from "@/components/judge-graph-view";
import { RunResult } from "@/components/run-result";
import { LONDON_BRIEF, worldClient, worldLlm } from "../crashtest/world";

const finished = (brief: LaunchBriefInput = LONDON_BRIEF) => runCrashTest({ qloo: worldClient().client, llm: worldLlm().llm }, brief, { runVersion: "test" });
const withUserChoice = () => finished({ ...LONDON_BRIEF, existingChoices: [{ slot: "event_place", name: "Yard Hall" }] });
const recorded = (s: RunState): RunState => ({ ...s, provenance: { mode: "recorded", recordedAt: "2026-10-20T09:00:00.000Z", runVersion: "test" } });

describe("results comparison", () => {
  it("introduces the three stages", async () => {
    const html = renderToStaticMarkup(<RunResult state={await withUserChoice()} />);
    expect(html).toContain("Here&#x27;s how the three plans compare.");
    expect(html).toContain("You specified 1 of 4 choices");
    expect(html).toContain("Your direction, the LLM draft and the agent&#x27;s recommendation");
  });

  it("shows User, LLM and Agent side by side for every choice", async () => {
    const html = renderToStaticMarkup(<ComparisonTable decisions={buildDecisions(await withUserChoice())} />);
    expect(html).toMatch(/<th[^>]*>You<\/th>/);
    expect(html).toMatch(/<th[^>]*>LLM<\/th>/);
    expect(html).toMatch(/<th[^>]*>Agent<\/th>/);
    expect(html.match(/<th scope="row"[^>]*>Why<\/th>/g)).toHaveLength(4);
    expect(html).toContain("Not specified");
    expect(html).toContain("Added by the LLM");
    expect(html).toContain("Carried forward from you");
  });

  it("writes reasons as plain sentences: no provenance chips, notes or helper copy", async () => {
    const ds = buildDecisions(await finished({ ...LONDON_BRIEF, constraints: [{ id: "l", kind: "hard", lockSlot: "event_place", description: "Booked" }] }));
    const html = renderToStaticMarkup(<ComparisonTable decisions={ds} />);
    for (const chip of ["QLOO AUDIENCE RESULT", "Qloo audience result", "Full-plan re-test", "User constraint", "Qloo local result"]) expect(html).not.toContain(chip);
    expect(html).not.toContain("Note:");
    expect(html).not.toContain("Each choice is shown side by side");
    expect(html).not.toContain("is not a prediction of commercial success");
  });

  it("orders a changed reason: original, test result, alternative, its evidence, the re-test", async () => {
    const d = buildDecisions(await finished()).find((x) => x.changed)!;
    const text = decisionNarrative(d);
    const at = (s: string) => text.indexOf(s);
    expect(at("The LLM proposed Big Tex.")).toBe(0);
    expect(at("No audience support was returned")).toBeGreaterThan(0);
    expect(at("The agent chose Grey Lane.")).toBeGreaterThan(at("No audience support was returned"));
    expect(at("Grey Lane ranked #1")).toBeGreaterThan(at("The agent chose Grey Lane."));
    expect(at("After the full plan was re-tested")).toBeGreaterThan(at("Grey Lane ranked #1"));
  });

  it("states a retained choice and who supplied it, then what kept it", async () => {
    const venue = buildDecisions(await withUserChoice()).find((d) => d.slot === "event_place")!;
    expect(decisionNarrative(venue)).toMatch(/^You chose Yard Hall\. /);
  });

  it("frames the result with a receipt in accurate terms, a Table-first switch and the agent loop, without loading the graph", async () => {
    const html = renderToStaticMarkup(<RunResult state={await withUserChoice()} />);
    expect(html).toContain("What the agent did");
    expect(html).toMatch(/4 choices tested · \d+ candidates? considered · \d+ re-tested · 2 accepted · 2 retained/);
    expect(html).toMatch(/\d+ Qloo checks/);
    expect(html).not.toContain("Qloo queries");
    expect(html).not.toContain("sent to Qloo"); // not measured in this run, so not claimed
    expect(html).toMatch(/Live run · \d{1,2} \w{3} \d{4}/);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Table</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Decision graph</);
    expect(html).toContain("Draft without Qloo");
    expect(html).not.toContain("<canvas");
    expect(html.match(/Decision trace →/g)).toHaveLength(4);
  });

  it("keeps a restored recorded run labelled recorded, with the recording's date", async () => {
    const saved = JSON.parse(JSON.stringify(recorded(await finished()))) as RunState;
    const html = renderToStaticMarkup(<RunResult state={saved} />);
    expect(html).toContain("London · Recorded run");
    expect(html).toContain("Recorded run · 20 Oct 2026");
    expect(html).not.toContain("Live run");
  });
});

describe("decision graph view", () => {
  // Under the test runner there is no WebGL, so the view renders without the canvas: the fallback a browser without WebGL gets.
  const view = (s: RunState, focus: "artist_music" | null) =>
    renderToStaticMarkup(<JudgeGraphView state={s} decisions={buildDecisions(s)} focus={focus} onFocus={() => {}} onStep={() => {}} />);

  it("shows Decision details and a Decision trace for the focused choice, with no helper copy", async () => {
    const html = view(await finished(), "artist_music");
    expect(html).toContain("3D view unavailable in this browser.");
    expect(html).not.toContain("<canvas");
    expect(html).toContain("Big Tex → Grey Lane");
    expect(html.indexOf("Decision details")).toBeLessThan(html.indexOf("Decision trace"));
    for (const f of ["Original", "What the test returned", "Alternatives tested", "Why accepted", "Full-plan result"]) expect(html).toContain(`>${f}</dt>`);
    expect(html).not.toContain("Drag to orbit");
    expect(html).not.toContain("Select a decision to see");
    expect(html).not.toContain("not cause and effect");
  });

  it("makes evidence and candidate rows buttons with a chevron, and leaves other rows as plain text", async () => {
    const html = view(await finished(), "artist_music");
    const trace = html.slice(html.indexOf('id="decision-trace"'));
    expect(trace).toMatch(/<button type="button" aria-pressed="false" class="flex min-h-11 w-full[^"]*"><svg[^>]*>.*?<\/svg><span class="flex-1">Qloo evidence \(did not support\)/);
    expect(trace).toMatch(/<button[^>]*>.*?Candidate tested \(tested against\): Grey Lane — Accepted after the full-plan re-test/);
    expect(trace).toMatch(/<div class="flex items-start[^"]*"><svg[^>]*>.*?<\/svg><span>Your brief \(added by LLM\): Open slot/);
    expect(trace).not.toContain("underline");
    expect(trace).toContain("›");
  });

  it("opens on an overview without helper copy", async () => {
    const html = view(await finished(), null);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Overview/);
    expect(html).not.toContain("Your brief leads to four decisions");
    expect(html).not.toContain("Decision details");
  });

  it("the table, the trace and the graph reach the same conclusions", async () => {
    const s = await finished({ ...LONDON_BRIEF, existingChoices: [{ slot: "event_place", name: "Yard Hall" }] });
    const ds = buildDecisions(s);
    const trace = buildDecisionTrace(s);
    const graph = buildJudgeGraph(s, ds);
    for (const d of ds) {
      const t = trace.find((x) => x.slot === d.slot)!;
      const final = graph.nodes.find((n) => n.id === `${d.slot}:final`)!;
      const llm = graph.nodes.find((n) => n.id === `${d.slot}:llm`)!;
      expect([t.changed, graph.decisions.find((g) => g.slot === d.slot)!.changed]).toEqual([d.changed, d.changed]);
      expect([t.baseline.label, llm.label]).toEqual([d.baseline.label, d.baseline.label]);
      expect([t.final.label, final.label]).toEqual([d.revised.label, d.revised.label]);
      expect(t.acceptedChange?.after).toBe(d.acceptedChange?.after);
    }
  });
});
