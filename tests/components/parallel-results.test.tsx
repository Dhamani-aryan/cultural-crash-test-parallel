import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunResult } from "@/components/run-result";
import { OperationalVerification } from "@/components/parallel-result";
import { parallelView, preferenceAccount, toParallelMarkdown, vetoAccount } from "@/lib/crashtest/parallel-view";
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
            reason: "For Your Eyes Only failed the operational check: its official site says it is a strip club.",
            fromSource: "agent",
            fromQlooCategory: "cocktail bar",
            kind: "wrong_establishment",
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
    expect(html).toContain("The evidence agent picked For Your Eyes Only, which Qloo lists as a cocktail bar.");
    expect(html).toContain("its official site says it is a strip club.");
    expect(html).toContain("Qloo&#x27;s record of For Your Eyes Only is inaccurate: the error is in Qloo&#x27;s data, not in how the plan was chosen.");
    expect(html).toContain("The plan now uses Barbican Conservatory.");
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
    // A recording from before the conflict kind was kept: the account stays factual, with no blame assigned.
    expect(html).toContain(`The cultural comparison picked ${fromVenue}.`);
    expect(html).toContain("official site identifies it as the wrong venue type");
    expect(html).not.toContain("error is in Qloo");
    expect(html).toContain(`The plan now uses ${toVenue}.`);
    expect(html).toContain("Changed by the web check");
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

  it("shows both choices when the selected and agent options are equally plausible but thin", async () => {
    // Only considered, so the agent may test its own artist against it.
    const state = await parallel({
      ...LONDON_BRIEF,
      sourceText: "We're considering Big Tex for the music.",
      existingChoices: [{ slot: "artist_music", name: "Big Tex" }],
    });
    const p = state.parallel!;
    const user = p.candidates.find((candidate) => candidate.candidateId === "user")!;
    const agent = p.candidates.find((candidate) => candidate.candidateId === "agent")!;
    const slot = "artist_music" as const;
    const userLabel = user.plan.components.find((component) => component.slot === slot)!.label;
    const agentLabel = agent.plan.components.find((component) => component.slot === slot)!.label;
    p.verdict = { ...p.verdict, candidateId: "user", track: "user", plan: user.plan };
    p.matrix.componentStates.user = {
      ...p.matrix.componentStates.user,
      [slot]: "plausible_thin",
    };
    p.matrix.componentStates.agent = {
      ...p.matrix.componentStates.agent,
      [slot]: "plausible_thin",
    };

    const row = parallelView(state)!.rows.find((item) => item.slot === slot)!;
    expect(row.final.label).toBe(userLabel);
    expect(row.final.alternative).toBe(agentLabel);
    expect(row.final.status).toBe("Both workable — choose by logistics");

    const html = renderToStaticMarkup(<RunResult state={state} />);
    expect(html).toContain("Both workable — choose by logistics");
    expect(html).toContain("Options");
    expect(html).toContain("availability, budget, logistics and direct brand fit");
  });

  it("credits the evidence agent when it independently reached the recommended plan", async () => {
    const state = await parallel();
    const p = state.parallel!;
    const user = p.candidates.find((candidate) => candidate.candidateId === "user")!;
    const agent = p.candidates.find((candidate) => candidate.candidateId === "agent")!;
    const own = agent.plan;
    expect(own.components.map((c) => c.label)).not.toEqual(user.plan.components.map((c) => c.label));
    p.verdict = { ...p.verdict, candidateId: "user", track: "user", plan: user.plan };
    agent.plan = user.plan;
    expect(parallelView(state)!.summary.winner).toBe("Your plan, matched by the evidence-first agent");
    agent.plan = own;
    expect(parallelView(state)!.summary.winner).toBe("Your plan");
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

  it("keeps understandable rank evidence while hiding raw affinity scores", async () => {
    const state = await parallel();
    const winner = state.parallel!.verdict.candidateId!;
    const claimId = `${winner}/artist_music/plain-language-test`;
    state.parallel!.matrix.claims.push({
      claimId,
      candidateId: winner,
      slot: "artist_music",
      dimension: "audience",
      stance: "supports",
      source: "qloo_affinity",
      claim:
        "Example artist: #1 of 50 for this audience in London (affinity 0.979); strongest link: Palace Skateboards (0.36).",
      evidenceIds: [],
      ruleId: "R-qloo-audience",
      strength: "strong",
      limitations: [],
    });
    state.parallel!.final.decisiveClaimIds = [claimId];

    const html = renderToStaticMarkup(<RunResult state={state} />);
    expect(html).toContain(
      "Strong audience fit. Ranked first among 50 artist candidates tested for this London audience.",
    );
    expect(html).not.toContain("affinity 0.979");
    expect(html).not.toContain("#1 of 50");
    expect(html).not.toContain("strongest link:");
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

describe("vetoAccount", () => {
  const base = { fromCandidateId: "llm", fromVenue: "Old Hall", toCandidateId: "user", toVenue: "New Hall", fromSource: "llm" as const };
  it("calls a closed venue out-of-date Qloo data", () => {
    expect(vetoAccount({ ...base, reason: "Old Hall failed the operational check: it closed in 2025.", kind: "closed" })).toBe(
      "The LLM picked Old Hall. The web check of its official source found: it closed in 2025. So Qloo's record of Old Hall is out of date: the error is in Qloo's data, not in how the plan was chosen. The plan now uses New Hall.",
    );
  });
  it("calls a capacity limit a practical fact, not a data error", () => {
    const text = vetoAccount({ ...base, reason: "Old Hall failed the operational check: it holds 80.", kind: "capacity", toVenue: null });
    expect(text).toContain("a practical limit that Qloo's taste data doesn't cover");
    expect(text).not.toContain("error is in Qloo");
    expect(text).toContain("No other venue passed the check, so the venue is left open.");
  });
});

describe("preferenceAccount", () => {
  it("says who picked each venue, what the cited facts showed and why the plan moved", () => {
    expect(
      preferenceAccount({
        fromCandidateId: "agent",
        fromVenue: "Studio 73",
        fromSource: "agent",
        toCandidateId: "llm",
        toVenue: "Foro Indie Rocks!",
        toSource: "llm",
        concerns: ["outside the area the brief names"],
        note: "It is in Condesa, not Roma Norte.",
      }),
    ).toBe(
      "Studio 73 (picked by the evidence agent) led the Qloo comparison, but cited web sources show it is outside the area the brief names. It is in Condesa, not Roma Norte. Foro Indie Rocks! (picked by the LLM) keeps the same named choices without that problem, so the plan uses Foro Indie Rocks!.",
    );
  });

  it("shows the switch under What changed because of Qloo", async () => {
    const state = await parallel();
    const p = state.parallel!;
    const llm = p.candidates.find((c) => c.candidateId === "llm")!;
    const toVenue = llm.plan.components.find((c) => c.slot === "event_place")!.label;
    p.verdict = { ...p.verdict, candidateId: "llm", track: "llm", plan: llm.plan };
    p.operational = {
      version: "operational:v2",
      checkedAt: "2026-10-30T00:00:00.000Z",
      checks: [],
      preference: { fromCandidateId: "agent", fromVenue: "Members Club", fromSource: "agent", toCandidateId: "llm", toVenue, toSource: "llm", concerns: ["not open to the launch's guests"], note: "It is a private members' club." },
    };
    const html = renderToStaticMarkup(<RunResult state={state} />);
    expect(html).toContain("Changed by the web check");
    expect(html).toContain("Members Club (picked by the evidence agent) led the Qloo comparison");
  });
});
