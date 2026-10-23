import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunResult } from "@/components/run-result";
import { parallelView, toParallelMarkdown } from "@/lib/crashtest/parallel-view";
import { toMarkdown } from "@/lib/crashtest/report";
import { runCrashTest } from "@/lib/crashtest/run";
import type { LaunchBriefInput, RunState } from "@/lib/crashtest/types";
import { LONDON_BRIEF, worldClient, worldLlm } from "../crashtest/world";

const parallel = (brief: LaunchBriefInput = LONDON_BRIEF, llm: Parameters<typeof worldLlm>[0] = {}, world: Parameters<typeof worldClient>[0] = {}) =>
  runCrashTest({ qloo: worldClient(world).client, llm: worldLlm(llm).llm }, brief, { architecture: "parallel", blindId: (n) => `P${n}`, runVersion: "test" });

describe("parallel results", () => {
  it("shows You, LLM, Evidence-first agent and Final verdict for every choice, with Not specified for open user slots", async () => {
    const html = renderToStaticMarkup(<RunResult state={await parallel({ ...LONDON_BRIEF, existingChoices: [{ slot: "event_place", name: "Yard Market" }] })} />);
    for (const h of ["Choice", "You", "LLM", "Evidence-first agent", "Final verdict"]) expect(html).toMatch(new RegExp(`<th[^>]*>${h}</th>`));
    expect(html.match(/<th scope="row"[^>]*>/g)).toHaveLength(4);
    expect(html.match(/Not specified/g)!.length).toBe(3);
    // Reasons start collapsed behind a visible "Why this won" control.
    expect(html.match(/<details><summary[^>]*>Why this won<\/summary>/g)).toHaveLength(4);
  });

  it("summarises the winner, stability, rules, coverage, counts, cost and checks at the top", async () => {
    const state = await parallel();
    const html = renderToStaticMarkup(<RunResult state={state} />);
    expect(html).toContain("Best complete plan: The evidence-first agent’s plan");
    expect(html).toContain("Stable: the same verdict in both blind orders.");
    for (const s of ["Hard rules passed", "Evidence coverage", "Supported / thin / unverified", "Qloo checks · model calls", "To confirm"]) expect(html).toContain(s);
    expect(html).not.toMatch(/predicted sales|guaranteed|will sell/i);
  });

  it("names where each final choice came from", async () => {
    const view = parallelView(await parallel(LONDON_BRIEF, {}, { noCandidates: ["brand"] }))!;
    expect(view.summary.winnerTrack).toBe("H");
    expect(view.rows.find((r) => r.slot === "artist_music")!.final.source).toBe("From the evidence-first agent");
    expect(view.rows.find((r) => r.slot === "brand_collaboration")!.final.source).toBe("From the LLM");
  });

  it("shows unknown evidence as unknown, not as failure", async () => {
    const view = parallelView(await parallel({ ...LONDON_BRIEF, existingChoices: [{ slot: "brand_collaboration", name: "Hackney Clay Collective" }] }))!;
    const brand = view.rows.find((r) => r.slot === "brand_collaboration")!;
    expect(brand.final.state).toBe("needs_human");
    expect(brand.counter.map((c) => c.text).join(" ")).not.toMatch(/Hackney/);
    expect(brand.uncertain.map((c) => c.text).join(" ")).toMatch(/isn't in Qloo/);
    const html = renderToStaticMarkup(<RunResult state={await parallel({ ...LONDON_BRIEF, existingChoices: [{ slot: "brand_collaboration", name: "Hackney Clay Collective" }] })} />);
    expect(html).toMatch(/text-unresolved[^>]*>Needs human confirmation/);
  });

  it("22. a replayed (serialised) state gives the same comparison, decision path and report", async () => {
    const state = await parallel(LONDON_BRIEF, {}, { noCandidates: ["brand"] });
    const replayed = JSON.parse(JSON.stringify({ ...state, provenance: { mode: "recorded", recordedAt: "2026-10-22T00:00:00Z", runVersion: "test" } })) as RunState;
    expect(parallelView(replayed)).toEqual(parallelView(state));
    expect(toParallelMarkdown(replayed)).toEqual(toParallelMarkdown(state));
    const html = (s: RunState) => renderToStaticMarkup(<RunResult state={s} />).replace(/Live run|Recorded run/, "");
    expect(html(replayed)).toEqual(html(state));
  });

  it("draws three branches from the brief into one blind comparison and a final verdict", async () => {
    const { path } = parallelView(await parallel(LONDON_BRIEF, {}, { noCandidates: ["brand"] }))!;
    expect(path.edges.filter((e) => e.source === "brief" && e.relation === "generated").map((e) => e.target)).toEqual(["track:user", "track:llm", "track:agent"]);
    expect(path.nodes.find((n) => n.id === "adjudication:initial")).toBeDefined();
    expect(path.nodes.some((n) => n.kind === "hybrid" && n.state === "accepted")).toBe(true);
    expect(path.nodes.at(-1)).toMatchObject({ id: "final", kind: "final" });
    const ids = new Set(path.nodes.map((n) => n.id));
    for (const e of path.edges) expect(ids.has(e.source) && ids.has(e.target), `${e.source}→${e.target}`).toBe(true);
  });

  it("downloads the parallel report from the shared report entry point", async () => {
    const state = await parallel();
    const md = toMarkdown(state);
    expect(md).toContain("| Choice | You | LLM | Evidence-first agent | Final verdict |");
    expect(md).toContain("## Human checks still required");
    expect(md).toContain("## Rejected alternatives");
  });

  it("explains a run that stopped before comparing", async () => {
    const state = await runCrashTest({ qloo: worldClient().client, llm: worldLlm().llm }, LONDON_BRIEF, { architecture: "parallel", limits: { maxQlooCalls: 5 } });
    const html = renderToStaticMarkup(<RunResult state={state} />);
    expect(html).toContain("The run stopped before the plans could be compared");
  });
});
