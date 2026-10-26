import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunResult } from "@/components/run-result";
import { OperationalVerification } from "@/components/parallel-result";
import { parallelView, toParallelMarkdown } from "@/lib/crashtest/parallel-view";
import { buildParallelJudgeGraph } from "@/lib/crashtest/parallel-judge-graph";
import { visibleGraph } from "@/lib/crashtest/judge-graph";
import { layoutGraph } from "@/lib/crashtest/judge-layout";
import { buildReplay } from "@/lib/crashtest/judge-replay";
import { toMarkdown } from "@/lib/crashtest/report";
import { runCrashTest } from "@/lib/crashtest/run";
import type { LaunchBriefInput, RunState } from "@/lib/crashtest/types";
import { LONDON_BRIEF, worldClient, worldLlm } from "../crashtest/world";

const parallel = (
  brief: LaunchBriefInput = LONDON_BRIEF,
  llm: Parameters<typeof worldLlm>[0] = {},
  world: Parameters<typeof worldClient>[0] = {},
) =>
  runCrashTest({ qloo: worldClient(world).client, llm: worldLlm(llm).llm }, brief, {
    architecture: "parallel",
    blindId: (n) => `P${n}`,
    runVersion: "test",
  });

describe("parallel results", () => {
  it("shows the operational override and official sources in the details projection", () => {
    const html = renderToStaticMarkup(
      <OperationalVerification
        audit={{
          version: "operational:v1",
          checkedAt: "2026-10-25T00:00:00.000Z",
          override: {
            fromCandidateId: "agent",
            fromVenue: "For Your Eyes Only",
            toCandidateId: "user",
            toVenue: "Barbican Conservatory",
            reason: "For Your Eyes Only is a strip club, not the required launch setting.",
          },
          checks: [
            {
              venue: "Barbican Conservatory",
              city: "London",
              status: "verified_fit",
              finding: "The official hire page supports product launches for this audience size.",
              facts: ["The stated event capacity covers 220 guests."],
              limitations: ["Dates and price remain unverified."],
              sources: [
                {
                  title: "Official venue hire page",
                  url: "https://example.com/venue",
                  snippet: "Product launches",
                  sourceType: "official",
                  retrievedAt: "2026-10-25T00:00:00.000Z",
                },
              ],
            },
          ],
        }}
      />,
    );
    expect(html).toContain("The cultural comparison recommended For Your Eyes Only");
    expect(html).toContain("We therefore moved to");
    expect(html).toContain("Barbican Conservatory");
    expect(html).toContain("Official venue hire page");
    expect(html).toContain('href="https://example.com/venue"');
  });

  it("explains that an operational override rejects a finalist rather than inventing a web recommendation", async () => {
    const state = await parallel();
    const candidates = state.parallel!.candidates;
    const from = candidates.find(
      (candidate) => candidate.candidateId === state.parallel!.verdict.candidateId,
    )!;
    const to = candidates.find(
      (candidate) =>
        candidate.candidateId !== from.candidateId &&
        candidate.plan.components.some((component) => component.slot === "event_place"),
    )!;
    const fromVenue = from.plan.components.find(
      (component) => component.slot === "event_place",
    )!.label;
    const toVenue = to.plan.components.find((component) => component.slot === "event_place")!.label;
    state.parallel!.operational = {
      version: "operational:v1",
      checkedAt: "2026-10-25T00:00:00.000Z",
      checks: [],
      override: {
        fromCandidateId: from.candidateId,
        fromVenue,
        toCandidateId: to.candidateId,
        toVenue,
        reason: `${fromVenue} failed the operational check: its official site identifies it as the wrong venue type.`,
      },
    };
    state.parallel!.verdict = { ...state.parallel!.verdict, candidateId: to.candidateId };
    const html = renderToStaticMarkup(<RunResult state={state} />);
    expect(html).toContain(`Qloo&#x27;s cultural comparison initially preferred ${fromVenue}`);
    expect(html).toContain("official site identifies it as the wrong venue type");
    expect(html).toContain("did not create a new recommendation");
    expect(html).toContain(`highest-ranked remaining option, ${toVenue}`);
  });

  it("shows You, LLM, Evidence-first agent and Final verdict for every choice, with Not specified for open user slots", async () => {
    const html = renderToStaticMarkup(
      <RunResult
        state={await parallel({
          ...LONDON_BRIEF,
          existingChoices: [{ slot: "event_place", name: "Yard Market" }],
        })}
      />,
    );
    for (const h of ["Choice", "You", "LLM", "Evidence-first agent", "Final verdict"])
      expect(html).toMatch(new RegExp(`<th[^>]*>${h}</th>`));
    expect(html.match(/<th scope="row"[^>]*>/g)).toHaveLength(4);
    expect(html.match(/Not specified/g)!.length).toBe(3);
    // Reasons start collapsed behind a visible "Why this won" control.
    expect(html.match(/<details><summary[^>]*>Why this won<\/summary>/g)).toHaveLength(4);
    expect(html).toContain("Selected");
    expect(html).toContain("from-supported/[0.10]");
    expect(html).toContain("from-conflict/[0.10]");
    expect(html).not.toContain("Other picks:");
  });

  it("keeps the marketer view focused and places judge diagnostics behind one details control", async () => {
    const state = await parallel();
    const html = renderToStaticMarkup(<RunResult state={state} />);
    expect(html).toContain("Best complete plan: The evidence-first agent’s plan");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("View details");
    expect(html).toContain("Plan comparison");
    expect(html).toContain("Recommendation in plain language");
    expect(html).toContain("What changed because of Qloo?");
    expect(html).toContain("Qloo evidence");
    expect(html).toContain("The three columns below are the finalists, not the whole search");
    expect(html).toContain("candidate choices across the four decision areas");
    expect(html).toContain("complete plan combination");
    expect(html).not.toContain("Decision stability");
    expect(html).not.toContain("Qloo checks · model calls");
    expect(html).not.toContain("How the verdict was reached");
    expect(html).not.toContain("Decision graph");
    expect(html).not.toMatch(/predicted sales|guaranteed|will sell/i);
  });

  it("labels official-source evidence separately from Qloo evidence", async () => {
    const state = await parallel();
    const winner = state.parallel!.verdict.candidateId!;
    state.parallel!.matrix.claims.push({
      claimId: `${winner}/event_place/official-test`,
      candidateId: winner,
      slot: "event_place",
      dimension: "feasibility",
      stance: "supports",
      source: "official_source",
      claim: "The official venue page confirms the required event format.",
      evidenceIds: [],
      ruleId: "R-official-test",
      strength: "strong",
      limitations: [],
    });
    const venue = parallelView(state)!.rows.find((row) => row.slot === "event_place")!;
    expect(venue.support.find((claim) => claim.claimId.endsWith("official-test"))?.source).toBe(
      "Official venue source",
    );
    // The default table intentionally shows only the decisive support claim. The full receipt
    // retains the correctly labelled official-source claim behind View details.
    const html = renderToStaticMarkup(<RunResult state={state} />);
    expect(html).toContain("View details");
  });

  it("surfaces an unresolved live venue check in marketer language", async () => {
    const state = await parallel();
    const venue = parallelView(state)!.rows.find((row) => row.slot === "event_place")!.final.label;
    state.parallel!.operational = {
      version: "operational:v1",
      checkedAt: "2026-10-25T00:00:00.000Z",
      checks: [
        {
          venue,
          city: "London",
          status: "unverified",
          finding: "Not enough current information.",
          facts: [],
          limitations: [],
          sources: [],
        },
      ],
    };
    const html = renderToStaticMarkup(<RunResult state={state} />);
    expect(html).toContain(`The cultural case for ${venue} was strongest`);
    expect(html).toContain("Treat the venue recommendation as provisional");
  });

  it("projects the parallel run into the same collision-safe decision graph used by the UI", async () => {
    const state = await parallel();
    const graph = buildParallelJudgeGraph(state);
    const overview = visibleGraph(graph);
    expect(graph.decisions).toHaveLength(4);
    expect(overview.nodes.map((node) => node.kind).sort()).toEqual([
      "brief",
      "final_choice",
      "final_choice",
      "final_choice",
      "final_choice",
      "plan",
    ]);
    expect(
      graph.edges.filter(
        (edge) =>
          edge.relation === "generated_independently" || edge.relation === "supplied_by_user",
      ),
    ).toHaveLength(12);
    expect(graph.edges.filter((edge) => edge.relation === "compared_blind")).toHaveLength(12);
    expect(graph.nodes.some((node) => node.kind === "qloo_evidence")).toBe(true);

    const ledger = new Set(state.evidenceLedger.map((record) => record.evidenceId));
    for (const node of graph.nodes)
      for (const evidenceId of node.evidenceIds) expect(ledger.has(evidenceId)).toBe(true);

    for (const decision of graph.decisions) {
      const focused = visibleGraph(graph, decision.slot);
      const layout = layoutGraph(graph, decision.slot);
      expect(focused.nodes.every((node) => layout.positions[node.id])).toBe(true);
      expect(buildReplay(graph, decision.slot).events.length).toBeGreaterThan(0);
    }
  });

  it("names where each final choice came from", async () => {
    const view = parallelView(await parallel(LONDON_BRIEF, {}, { noCandidates: ["brand"] }))!;
    expect(view.summary.winnerTrack).toBe("H");
    expect(view.rows.find((r) => r.slot === "artist_music")!.final.source).toBe(
      "From the evidence-first agent",
    );
    expect(view.rows.find((r) => r.slot === "brand_collaboration")!.final.source).toBe(
      "From the LLM",
    );
  });

  it("shows unknown evidence as unknown, not as failure", async () => {
    const view = parallelView(
      await parallel({
        ...LONDON_BRIEF,
        existingChoices: [{ slot: "brand_collaboration", name: "Hackney Clay Collective" }],
      }),
    )!;
    const brand = view.rows.find((r) => r.slot === "brand_collaboration")!;
    expect(brand.final.state).toBe("needs_human");
    expect(brand.counter.map((c) => c.text).join(" ")).not.toMatch(/Hackney/);
    expect(brand.uncertain.map((c) => c.text).join(" ")).toMatch(/isn't in Qloo/);
    const html = renderToStaticMarkup(
      <RunResult
        state={await parallel({
          ...LONDON_BRIEF,
          existingChoices: [{ slot: "brand_collaboration", name: "Hackney Clay Collective" }],
        })}
      />,
    );
    expect(html).toMatch(/text-unresolved[\s\S]{0,300}Needs human confirmation/);
  });

  it("never presents a zero-support ordering as a validated best plan", async () => {
    const state = await parallel();
    const winner = state.parallel!.verdict.candidateId!;
    state.parallel!.matrix.componentStates[winner] = Object.fromEntries(
      Object.keys(state.parallel!.matrix.componentStates[winner] ?? {}).map((slot) => [
        slot,
        "unverified",
      ]),
    );
    const view = parallelView(state)!;
    expect(view.summary).toMatchObject({
      headline: "Insufficient Qloo evidence",
      stable: false,
      provisional: true,
      counts: { supported: 0 },
    });
    expect(view.summary.stability).toMatch(/hypothesis for human validation/);
  });

  it("keeps a stable ordering provisional while its chosen plan contradicts the brief", async () => {
    const state = await parallel();
    const winner = state.parallel!.verdict.candidateId!;
    state.parallel!.matrix.claims.push({
      candidateId: winner,
      slot: "event_place",
      ruleId: "R-neighborhood",
      dimension: "local",
      stance: "contradicts",
      strength: "moderate",
      claimId: `${winner}/event_place/test-neighborhood`,
      claim: "The venue is outside the neighbourhood named in the brief.",
      evidenceIds: [],
      limitations: [],
      source: "logical_rubric",
    });
    const view = parallelView(state)!;
    expect(view.summary).toMatchObject({
      headline: "Provisional plan",
      stable: false,
      provisional: true,
    });
    expect(view.summary.stability).toMatch(/explicit brief contradiction/);
  });

  it("22. a replayed (serialised) state gives the same comparison, decision path and report", async () => {
    const state = await parallel(LONDON_BRIEF, {}, { noCandidates: ["brand"] });
    const replayed = JSON.parse(
      JSON.stringify({
        ...state,
        provenance: { mode: "recorded", recordedAt: "2026-10-22T00:00:00Z", runVersion: "test" },
      }),
    ) as RunState;
    expect(parallelView(replayed)).toEqual(parallelView(state));
    expect(toParallelMarkdown(replayed)).toEqual(toParallelMarkdown(state));
    const html = (s: RunState) =>
      renderToStaticMarkup(<RunResult state={s} />).replace(/Live run|Recorded run/, "");
    expect(html(replayed)).toEqual(html(state));
  });

  it("draws three branches from the brief into one blind comparison and a final verdict", async () => {
    const { path } = parallelView(await parallel(LONDON_BRIEF, {}, { noCandidates: ["brand"] }))!;
    expect(
      path.edges
        .filter((e) => e.source === "brief" && e.relation === "generated")
        .map((e) => e.target),
    ).toEqual(["track:user", "track:llm", "track:agent"]);
    expect(path.nodes.find((n) => n.id === "adjudication:initial")).toBeDefined();
    expect(path.nodes.some((n) => n.kind === "hybrid" && n.state === "accepted")).toBe(true);
    expect(path.nodes.at(-1)).toMatchObject({ id: "final", kind: "final" });
    const ids = new Set(path.nodes.map((n) => n.id));
    for (const e of path.edges)
      expect(ids.has(e.source) && ids.has(e.target), `${e.source}→${e.target}`).toBe(true);
  });

  it("downloads the parallel report from the shared report entry point", async () => {
    const state = await parallel();
    const md = toMarkdown(state);
    expect(md).toContain("| Choice | You | LLM | Evidence-first agent | Final verdict |");
    expect(md).toContain("## Human checks still required");
    expect(md).toContain("## Rejected alternatives");
  });

  it("explains a run that stopped before comparing", async () => {
    const state = await runCrashTest(
      { qloo: worldClient().client, llm: worldLlm().llm },
      LONDON_BRIEF,
      { architecture: "parallel", limits: { maxQlooCalls: 5 } },
    );
    const html = renderToStaticMarkup(<RunResult state={state} />);
    expect(html).toContain("The run stopped before the plans could be compared");
  });
});
