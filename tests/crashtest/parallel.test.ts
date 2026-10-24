import { afterEach, describe, expect, it } from "vitest";
import {
  adjudicate,
  JUDGE_SYSTEM,
  mergeIdentical,
  rotatedOrders,
  stripCommercialClaims,
} from "@/lib/crashtest/adjudicate";
import { judgeHybrid, optimize, type OptimizerDeps } from "@/lib/crashtest/hybrid";
import { createLedger } from "@/lib/crashtest/ledger";
import { RULES } from "@/lib/crashtest/matrix";
import { TARGET_MARKETS, marketById } from "@/lib/markets";
import { runCrashTest } from "@/lib/crashtest/run";
import { generateLlmDraft } from "@/lib/crashtest/tracks";
import {
  LaunchBriefSchema,
  SLOTS,
  type CandidatePlan,
  type LaunchBriefInput,
  type PlanEvaluation,
  type RunState,
} from "@/lib/crashtest/types";
import {
  ADJUDICATION_VERSION,
  EVIDENCE_RUBRIC_VERSION,
  PARALLEL_VERSION,
} from "@/lib/crashtest/version";
import { marketsFromText } from "@/lib/intake/validate";
import { runKey } from "@/lib/server/handlers";
import { SCENARIOS } from "../../eval/scenario-cases";
import { LONDON_BRIEF, worldClient, worldLlm, type WorldOptions } from "./world";

type LlmOver = Parameters<typeof worldLlm>[0];

async function run(
  brief: LaunchBriefInput = LONDON_BRIEF,
  llmOver: LlmOver = {},
  world: WorldOptions = {},
  opts: { maxQlooCalls?: number; random?: boolean } = {},
) {
  const fake = worldLlm(llmOver);
  const state = await runCrashTest({ qloo: worldClient(world).client, llm: fake.llm }, brief, {
    architecture: "parallel",
    blindId: opts.random ? undefined : (n) => `P${n}`,
    limits: opts.maxQlooCalls ? { maxQlooCalls: opts.maxQlooCalls } : undefined,
    runVersion: "test",
  });
  return { state, p: state.parallel!, calls: fake.calls };
}
const cand = (s: RunState, id: string) => s.parallel!.candidates.find((c) => c.candidateId === id)!;
const label = (c: CandidatePlan, slot: (typeof SLOTS)[number]) =>
  c.plan.components.find((x) => x.slot === slot)?.label;
const judgeCalls = (calls: { system: string; prompt: string }[]) =>
  calls.filter((c) => c.system.startsWith("You compare anonymous launch plans"));
/** Model calls made before the first adjudication: the three tracks' generation. */
const beforeJudging = (calls: { system: string; prompt: string }[]) =>
  calls.slice(
    0,
    calls.findIndex((c) => c.system.startsWith("You compare")),
  );

describe("parallel architecture: independent tracks", () => {
  it("1. the LLM track sees only the brief: no Qloo results, candidates or agent plan", async () => {
    const { calls } = await run();
    const draft = calls.filter((c) => c.system.startsWith("You are a brand strategist"));
    expect(draft).toHaveLength(1);
    // Names only Qloo (or the agent) could know never reach the LLM-only draft.
    for (const qlooOnly of [
      "Grey Lane",
      "Coast Kid",
      "Fieldnote",
      "Canal Echo",
      "Industrial",
      "Utilitarian",
      "Monochrome",
      "P0",
      "P1",
    ])
      expect(draft[0].prompt).not.toContain(qlooOnly);
    // The generator has no Qloo client parameter at all: (llm, frozen brief, market).
    expect(generateLlmDraft.length).toBe(3);
  });

  it("2. the agent's initial track never reads the LLM's choices", async () => {
    const { state, calls } = await run(LONDON_BRIEF, {
      draft: {
        artist: "Zed Unheard",
        brand: "Qwerty Label",
        venue: "Nowhere Hall",
        direction: "Baroque neon",
      },
    });
    const llmNames = ["Zed Unheard", "Qwerty Label", "Nowhere Hall", "Baroque neon"];
    const generation = beforeJudging(calls).filter(
      (c) =>
        !c.system.startsWith("You are a brand strategist") &&
        !c.system.startsWith("Map a creative direction"),
    );
    expect(generation.length).toBeGreaterThan(0);
    // After all three tracks finish, every plan's components get the same shared role screen;
    // that screen (and only it) may name the LLM's choices, and nothing of the agent runs after it.
    const isRole = (c: { system: string }) => c.system.startsWith("You screen candidates");
    const shared = generation.findIndex(
      (c) => isRole(c) && llmNames.some((n) => c.prompt.includes(n)),
    );
    expect(shared).toBeGreaterThan(0);
    expect(generation.slice(shared).every(isRole)).toBe(true);
    for (const c of generation.slice(0, shared))
      for (const n of llmNames) expect(c.prompt).not.toContain(n);
    for (const r of state.parallel!.agent!.pools) expect(llmNames).not.toContain(r.name);
    const agent = cand(state, "agent");
    for (const comp of agent.plan.components) {
      expect(["Zed Unheard", "Qwerty Label", "Nowhere Hall", "Baroque neon"]).not.toContain(
        comp.label,
      );
      // Every agent entity was screened from a Qloo list, not proposed by a model.
      if (comp.entity)
        expect(
          state.trials!.some((t) => t.entityId === comp.entity!.id && t.source === "qloo_list"),
        ).toBe(true);
    }
  });

  it("3. the user plan keeps exactly what was given; missing slots stay not specified", async () => {
    const { state } = await run({
      ...LONDON_BRIEF,
      existingChoices: [{ slot: "event_place", name: "Yard Market" }],
    });
    const u = cand(state, "user");
    expect(u.plan.components.map((c) => c.slot)).toEqual(["event_place"]);
    expect(u.open).toEqual(
      ["artist_music", "brand_collaboration", "creative_direction"].map((slot) => ({
        slot,
        state: "not_specified",
        reason: "You didn't specify this.",
      })),
    );
    expect(u.sources).toEqual({ event_place: "user" });
  });

  it("4. a fixed user choice survives every track, alternative, hybrid and the final plan", async () => {
    const { state, p } = await run({
      ...LONDON_BRIEF,
      existingChoices: [{ slot: "artist_music", name: "Big Tex" }],
      constraints: [
        { id: "c1", description: "Keep Big Tex", kind: "hard", lockSlot: "artist_music" },
      ],
    });
    expect(p.candidates.length).toBeGreaterThanOrEqual(3);
    for (const c of p.candidates) {
      const a = c.plan.components.find((x) => x.slot === "artist_music")!;
      expect(a).toMatchObject({ label: "Big Tex", origin: "user_provided", locked: true });
    }
    expect(state.plan!.components.find((c) => c.slot === "artist_music")?.label).toBe("Big Tex");
    expect(p.verdict.userChoicesPreserved).toEqual([
      { slot: "artist_music", label: "Big Tex", locked: true, preserved: true },
    ]);
  });

  it("5. a user's choice Qloo doesn't know is kept everywhere and flagged, never upgraded", async () => {
    const { state, p } = await run({
      ...LONDON_BRIEF,
      existingChoices: [{ slot: "brand_collaboration", name: "Hackney Clay Collective" }],
    });
    // The user's plan keeps it exactly; the agent is free to test alternatives, but its own
    // record of the choice says unverified, never a failure, and it stays in the agent's pool.
    expect(label(cand(state, "user"), "brand_collaboration")).toBe("Hackney Clay Collective");
    const pooled = p.agent!.pools.find((r) => r.name === "Hackney Clay Collective")!;
    expect(pooled).toMatchObject({
      source: "user",
      outcome: "pool",
      screens: { role: "unknown", brief: "unknown" },
    });
    expect(pooled.screens.notes).toContain("not in Qloo: unverified");
    expect(state.plan!.components.find((c) => c.slot === "brand_collaboration")).toMatchObject({
      label: "Hackney Clay Collective",
      resolution: "not_found",
    });
    expect(p.matrix.componentStates[p.verdict.candidateId!].brand_collaboration).toBe(
      "needs_human",
    );
    expect(p.verdict.humanChecks.join(" ")).toMatch(/Hackney Clay Collective/);
    // Unknown is not a contradiction, in any plan that keeps it.
    const claims = p.matrix.claims.filter(
      (c) =>
        c.slot === "brand_collaboration" &&
        c.dimension === "entity" &&
        p.candidates.find((k) => k.candidateId === c.candidateId) &&
        label(cand(state, c.candidateId), "brand_collaboration") === "Hackney Clay Collective",
    );
    expect(claims.length).toBeGreaterThan(0);
    for (const c of claims) expect(c.stance).toBe("unknown");
  });

  it("gives the user's named choices namesake protection, identically in every track", async () => {
    // Qloo's only "Big Tex" is American; the user means one from India, so it must not be tested as him.
    const { p } = await run(
      { ...LONDON_BRIEF, existingChoices: [{ slot: "artist_music", name: "Big Tex" }] },
      { choiceCountry: "India" },
    );
    const bigTex = p.candidates.flatMap((c) =>
      c.plan.components.filter((x) => x.slot === "artist_music" && x.label === "Big Tex"),
    );
    // The user's plan, the LLM's (which keeps the named choice) and every agent plan that tests it.
    expect(bigTex.length).toBeGreaterThanOrEqual(3);
    for (const a of bigTex)
      expect(a).toMatchObject({ resolution: "ambiguous", entity: null, origin: "user_provided" });
    expect(p.agent!.pools.find((r) => r.name === "Big Tex")).toMatchObject({
      source: "user",
      entityId: undefined,
    });
    expect(p.candidates.find((c) => c.candidateId === "user")!.plan.components[0]).toMatchObject({
      label: "Big Tex",
      entity: null,
    });
  });

  it("6. model-suggested anchors may be broadened; anchors the user named may not", async () => {
    const hypo = await run(
      { ...LONDON_BRIEF, audienceAnchors: [] },
      { anchors: [{ name: "Nobody Known", country: "UK" }] },
    );
    expect(
      hypo.calls.some((c) => c.system.startsWith("Suggest broader, established audience anchors")),
    ).toBe(true);
    expect(hypo.p.anchorSource).toBe("model_hypothesis");
    expect(hypo.state.plan!.anchors.map((a) => a.name)).toEqual(["Northcap", "Deckhouse"]);
    expect(hypo.p.verdict.humanChecks.join(" ")).toMatch(/model-suggested anchors/);

    const fake = worldLlm();
    const named = await runCrashTest(
      { qloo: worldClient().client, llm: fake.llm },
      { ...LONDON_BRIEF, audienceAnchors: ["Nobody Known"] },
      { architecture: "parallel" },
    );
    expect(fake.calls.some((c) => c.system.startsWith("Suggest broader"))).toBe(false);
    expect(named.stopReason).toBe("insufficient_data");
  });
});

describe("parallel architecture: shared evidence", () => {
  it("7. hard constraints veto every track equally", async () => {
    const { state, p, calls } = await run({
      ...LONDON_BRIEF,
      constraints: [
        { id: "x", description: "No Mossgrove", kind: "hard", excludeNames: ["Mossgrove"] },
      ],
    });
    expect(label(cand(state, "llm"), "brand_collaboration")).toBe("Mossgrove");
    expect(p.matrix.hardFailures.llm.length).toBeGreaterThan(0);
    expect(p.initial.eliminated).toHaveProperty("llm");
    expect(p.final.eliminated).toHaveProperty("llm");
    for (const c of judgeCalls(calls))
      expect(c.prompt).not.toContain("Collaboration brand: Mossgrove");
    expect(state.plan!.components.some((c) => c.label === "Mossgrove")).toBe(false);
    // The same rule vetoes any candidate: every one with a violation has a hard failure.
    for (const c of p.candidates)
      if (c.evaluation?.hardConstraintViolations.length)
        expect(p.matrix.hardFailures[c.candidateId].length).toBeGreaterThan(0);
  });

  it("8. claims keep support, contradiction and unknown apart", async () => {
    const { p } = await run();
    const stances = new Set(p.matrix.claims.map((c) => c.stance));
    expect(stances).toEqual(new Set(["supports", "contradicts", "unknown"]));
    // Big Tex isn't followed by this audience here: a contradiction, from Qloo.
    expect(
      p.matrix.claims.find(
        (c) => c.candidateId === "llm" && c.slot === "artist_music" && c.dimension === "audience",
      ),
    ).toMatchObject({ stance: "contradicts", source: "qloo_affinity" });
    // Venue feasibility is never measured, so it is unknown, never support or failure.
    expect(
      p.matrix.claims
        .filter((c) => c.dimension === "feasibility")
        .every((c) => c.stance === "unknown"),
    ).toBe(true);
    // Qloo and logical evidence are separate sources.
    expect(p.matrix.claims.some((c) => c.source === "logical_rubric")).toBe(true);
    expect(p.matrix.claims.some((c) => c.source.startsWith("qloo_"))).toBe(true);
  });

  it("9. every claim cites ledger records or a declared rule, and every rule exists", async () => {
    const { state, p } = await run();
    const ids = new Set(state.evidenceLedger.map((r) => r.evidenceId));
    for (const c of p.matrix.claims) {
      expect(c.evidenceIds.length > 0 || !!c.ruleId, c.claimId).toBe(true);
      for (const id of c.evidenceIds) expect(ids.has(id), `${c.claimId} cites ${id}`).toBe(true);
      if (c.source === "logical_rubric" || c.source === "constraint")
        expect(c.ruleId, c.claimId).toBeDefined();
      if (c.ruleId) expect(Object.keys(RULES)).toContain(c.ruleId);
    }
  });
});

describe("parallel architecture: blind adjudication", () => {
  it("10. blind IDs and judge prompts reveal no track", async () => {
    const { p, calls } = await run(LONDON_BRIEF, {}, {}, { random: true });
    for (const c of p.candidates) {
      expect(c.blindId).toMatch(/^P-[0-9A-F]{4}$/);
      expect(c.blindId.toLowerCase()).not.toMatch(/user|llm|agent|hybrid/);
    }
    expect(new Set(p.candidates.map((c) => c.blindId)).size).toBe(p.candidates.length);
    const prompts = judgeCalls(calls);
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    for (const c of prompts) {
      expect(c.prompt).not.toMatch(/\b(llm|agent|hybrid|track|evidence-first)\b/i);
      for (const k of p.candidates) expect(c.prompt).not.toContain(k.candidateId);
    }
    expect(JUDGE_SYSTEM).not.toMatch(/agent|llm|user|should win/i);
  });

  it("11. order rotation moves every plan", async () => {
    expect(rotatedOrders(["a", "b", "c"])).toEqual([
      ["a", "b", "c"],
      ["b", "c", "a"],
    ]);
    expect(rotatedOrders(["a", "b"])).toEqual([
      ["a", "b"],
      ["b", "a"],
    ]);
    const { p } = await run();
    for (const adj of [p.initial, p.final]) {
      if (adj.orderResults.length < 2) continue;
      const [x, y] = adj.orderResults.map((r) => r.order);
      for (const id of x) expect(y.indexOf(id)).not.toBe(x.indexOf(id));
    }
  });

  it("12. a judge that follows position, not evidence, is reported unstable", async () => {
    const firstShown = (prompt: string) => {
      const first = prompt.match(/^Plan (\S+)/m)![1];
      return {
        verdict: "winner",
        winner: first,
        decisive: [`${first}.1`],
        counter: [],
        dimensionWinners: [],
        rationale: "First plan.",
      };
    };
    const { p } = await run(LONDON_BRIEF, { judge: firstShown });
    expect(p.initial.verdict).toBe("unstable");
    expect(p.initial.winnerCandidateId).toBeNull();
    expect(p.final.verdict).toBe("unstable");
    expect(p.verdict).toMatchObject({ stable: false, decidedBy: "evidence_order" });
    expect(p.verdict.humanChecks.join(" ")).toMatch(/changed with the order/);
  });

  it("removes outcome claims the evidence can't show from a verdict", () => {
    const r = stripCommercialClaims("Plan P1 fits the audience. It will drive sales in London.");
    expect(r).toEqual({
      text: "Plan P1 fits the audience.",
      removed: ["It will drive sales in London."],
    });
  });
});

describe("parallel architecture: any plan can win", () => {
  it("13. the user's plan wins when it is the plan every track arrives at", async () => {
    const { p } = await run({
      ...LONDON_BRIEF,
      existingChoices: [
        { slot: "artist_music", name: "Grey Lane" },
        { slot: "brand_collaboration", name: "Mossgrove" },
        { slot: "event_place", name: "Yard Market" },
        { slot: "creative_direction", name: "Industrial and utilitarian" },
      ],
    });
    expect(p.initial.merged).toMatchObject({ llm: "user", agent: "user" });
    expect(p.verdict).toMatchObject({ candidateId: "user", track: "user", stable: true });
  });

  it("14. the LLM's plan can win", async () => {
    // Qloo lists no music act here, so the agent leaves the act open; the LLM names one.
    const { p } = await run(
      LONDON_BRIEF,
      { draft: { artist: "Grey Lane" } },
      { noCandidates: ["artist"] },
    );
    expect(cand({ parallel: p } as RunState, "agent").open.map((o) => o.slot)).toContain(
      "artist_music",
    );
    expect(p.verdict).toMatchObject({ candidateId: "llm", track: "llm" });
  });

  it("15. the agent's plan can win", async () => {
    const { p } = await run();
    expect(p.verdict).toMatchObject({ candidateId: "agent", track: "agent", stable: true });
  });

  it("16. a hybrid can win, and then the agent's plan loses", async () => {
    // Qloo lists no brand here, so the agent leaves the brand open; the LLM's act is contradicted.
    const { state, p } = await run(LONDON_BRIEF, {}, { noCandidates: ["brand"] });
    expect(cand(state, "agent").open.map((o) => o.slot)).toEqual(["brand_collaboration"]);
    expect(p.verdict.track).toBe("hybrid");
    expect(p.verdict.sources).toMatchObject({ artist_music: "agent", brand_collaboration: "llm" });
    expect(p.verdict.rejectedAlternatives.map((r) => r.candidateId)).toContain("agent");
  });

  it("17. no plan with a hard violation can win, whatever the judge says", async () => {
    // A judge that always tries to pick a plan containing the excluded brand.
    const wantsMossgrove = (prompt: string) => {
      const block = prompt.split("\n\n").find((b) => b.includes("Collaboration brand: Mossgrove"));
      const id = block?.match(/^Plan (\S+)/)?.[1] ?? "P0";
      return {
        verdict: "winner",
        winner: id,
        decisive: [`${id}.1`],
        counter: [],
        dimensionWinners: [],
        rationale: "",
      };
    };
    const { p } = await run(
      {
        ...LONDON_BRIEF,
        constraints: [
          { id: "x", description: "No Mossgrove", kind: "hard", excludeNames: ["Mossgrove"] },
        ],
      },
      { judge: wantsMossgrove },
    );
    const winner = p.verdict.candidateId;
    expect(winner).not.toBe("llm");
    if (winner) expect(p.matrix.hardFailures[winner]).toEqual([]);
  });
});

describe("parallel architecture: bounded improvement", () => {
  const evaluation = (
    slots: Partial<Record<(typeof SLOTS)[number], "supported" | "weak">>,
    contradicted = 0,
    violations: string[] = [],
  ): PlanEvaluation => ({
    iteration: 0,
    rubricVersion: "crash-v1",
    totalScore: Object.values(slots).filter((s) => s === "supported").length / 4,
    supported: Object.values(slots).filter((s) => s === "supported").length,
    scored: Object.keys(slots).length,
    contradicted,
    components: Object.entries(slots).map(([slot, status]) => ({
      slot: slot as (typeof SLOTS)[number],
      label: slot,
      status: status!,
      coverage: "adequate",
      dimensions: [],
      finding: "",
      contradicted: false,
    })),
    hardConstraintViolations: violations,
    weakest: [],
    accepted: !contradicted,
  });

  it("19. a hybrid that breaks a rule or loses a supported choice is rejected", () => {
    const prev = evaluation({ artist_music: "supported", event_place: "weak" });
    expect(
      judgeHybrid(prev, evaluation({ artist_music: "supported", event_place: "supported" }), [])
        .accepted,
    ).toBe(true);
    expect(
      judgeHybrid(prev, evaluation({ artist_music: "weak", event_place: "supported" }), [])
        .rejectionCode,
    ).toBe("plan_regression");
    expect(
      judgeHybrid(
        prev,
        evaluation({ artist_music: "supported", event_place: "supported" }, 0, ["x"]),
        [],
      ).rejectionCode,
    ).toBe("constraint_conflict");
    expect(
      judgeHybrid(prev, evaluation({ artist_music: "supported", event_place: "supported" }), [
        "breaks the brief",
      ]).rejectionCode,
    ).toBe("hard_failure");
    expect(judgeHybrid(prev, prev, []).rejectionCode).toBe("no_improvement");
    // Better on Qloo but drops a brand attribute or a named choice: the brief comes first.
    expect(
      judgeHybrid(prev, evaluation({ artist_music: "supported", event_place: "supported" }), [], {
        before: 3,
        after: 2,
      }).rejectionCode,
    ).toBe("brief_fit_lost");
    expect(
      judgeHybrid(prev, evaluation({ artist_music: "supported", event_place: "supported" }), [], {
        before: 3,
        after: 3,
      }).accepted,
    ).toBe(true);
  });

  it("matches brand attributes by stem, so a direction isn't faulted for a word form", async () => {
    // "utilitarianism" (the attribute) and "utilitarian" (the direction) are the same term.
    const { p } = await run({ ...LONDON_BRIEF, brandAttributes: ["utilitarianism"] });
    expect(
      p.matrix.claims.find(
        (c) => c.candidateId === "llm" && c.claimId.endsWith("/creative_direction/attributes"),
      ),
    ).toMatchObject({ stance: "supports" });
  });

  it("18. hybrids are accepted only after a complete-plan re-test", async () => {
    const { p } = await run(LONDON_BRIEF, {}, { noCandidates: ["brand"] });
    const accepted = p.rounds.flatMap((r) => r.attempts.filter((a) => a.accepted));
    expect(accepted.length).toBeGreaterThan(0);
    for (const a of accepted) {
      const h = p.candidates.find((c) => c.candidateId === a.candidateId)!;
      // Evaluated as the whole plan: every component it has was scored together.
      expect(h.evaluation!.components.map((c) => c.slot)).toEqual(
        h.plan.components.map((c) => c.slot),
      );
      expect(a.retest!.violationsAfter).toBeLessThanOrEqual(a.retest!.violationsBefore);
      expect(
        a.retest!.lostSupported.length === 0 ||
          a.retest!.contradictedAfter < a.retest!.contradictedBefore,
      ).toBe(true);
    }
    // Every rejected attempt records why.
    for (const a of p.rounds.flatMap((r) => r.attempts.filter((x) => !x.accepted)))
      expect(a.reason.length).toBeGreaterThan(0);
  });

  it("20. rounds and the Qloo budget stop deliberation deterministically", async () => {
    // An optimizer whose every hybrid tests better still stops at its round limit.
    let n = 0;
    const base: CandidatePlan = {
      candidateId: "agent",
      track: "agent",
      blindId: "P0",
      briefFingerprint: "f",
      plan: { anchors: [], components: [] },
      open: SLOTS.map((slot) => ({ slot, state: "abstained", reason: "none" })),
      sources: {},
      evaluation: evaluation({}),
      assumptions: [],
      provenance: { qlooCalls: 0, llmCalls: 0, ms: 0, generatedAt: "" },
    };
    const deps: OptimizerDeps = {
      evaluate: async (plan) =>
        evaluation(Object.fromEntries(plan.components.map((c) => [c.slot, "supported"]))),
      search: async (slot) => ({
        proposals: [
          {
            slot,
            after: {
              slot,
              label: `x${++n}`,
              origin: "agent_repair",
              locked: false,
              resolution: "resolved",
              entity: null,
              tags: [],
              placeCategory: null,
            },
            reason: "",
            expectedEffect: "",
            evidenceIds: [],
            considered: [],
          },
        ],
        trials: [],
      }),
      matrix: (cands) => ({
        rubricVersion: "",
        candidateIds: [],
        claims: [],
        coverageByCandidate: {},
        completenessByCandidate: {},
        hardFailures: Object.fromEntries(cands.map((c) => [c.candidateId, []])),
        componentStates: {},
      }),
      newIds: () => ({ candidateId: `h${n}`, blindId: `B${n}` }),
    };
    const brief = LaunchBriefSchema.parse(LONDON_BRIEF);
    const r = await optimize(
      { brief, contenders: [base], incumbentId: "agent", maxRounds: 2 },
      deps,
    );
    expect(r).toMatchObject({ stop: "round_limit" });
    expect(r.rounds).toHaveLength(2);

    // A full run under a small Qloo budget stops at exactly that budget, the same way every time.
    const a = await run(LONDON_BRIEF, {}, {}, { maxQlooCalls: 40 });
    const b = await run(LONDON_BRIEF, {}, {}, { maxQlooCalls: 40 });
    expect(a.state.stopReason).toBe("api_budget_limit");
    expect(a.state.qlooCallsUsed).toBe(40);
    expect([b.state.stopReason, b.state.qlooCallsUsed]).toEqual([
      a.state.stopReason,
      a.state.qlooCallsUsed,
    ]);
  });
});

describe("parallel architecture: provenance and safety", () => {
  afterEach(() => {
    delete process.env.RECOMMENDATION_ARCHITECTURE;
  });

  it("21. results and recordings carry the architecture and rubric versions", async () => {
    const { state, p } = await run();
    expect(state.architecture).toBe("parallel");
    expect(p).toMatchObject({
      architectureVersion: PARALLEL_VERSION,
      evidenceRubricVersion: EVIDENCE_RUBRIC_VERSION,
      adjudicationVersion: ADJUDICATION_VERSION,
      baseRubricVersion: "crash-v1",
    });
    expect(p.candidates.every((c) => c.briefFingerprint === p.briefFingerprint)).toBe(true);
    const brief = LaunchBriefSchema.parse(LONDON_BRIEF);
    process.env.RECOMMENDATION_ARCHITECTURE = "sequential";
    const sequential = runKey(brief);
    process.env.RECOMMENDATION_ARCHITECTURE = "parallel";
    expect(runKey(brief)).not.toBe(sequential);
  });

  it("records every track's own time, Qloo checks and model calls", async () => {
    const { p } = await run();
    for (const scope of ["llm", "agent", "adjudication"] as const)
      expect(p.usage[scope].llmCalls).toBeGreaterThan(0);
    expect(p.usage.llm.qlooChecks).toBeGreaterThan(0);
    expect(p.usage.agent.qlooChecks).toBeGreaterThan(0);
    expect(p.candidates.find((c) => c.candidateId === "llm")!.provenance.model).toBe("fake");
  });

  it("merges identical plans before judging", async () => {
    const { p } = await run();
    const twins = [
      p.candidates[1],
      { ...p.candidates[1], candidateId: "agent", track: "agent" as const },
    ];
    expect(mergeIdentical(twins).merged).toEqual({ agent: "llm" });
  });

  it("adjudication with no plan passing the hard rules abstains", async () => {
    const { p, state } = await run();
    const matrix = {
      ...p.matrix,
      hardFailures: Object.fromEntries(p.candidates.map((c) => [c.candidateId, ["breaks"]])),
    };
    const r = await adjudicate({
      llm: worldLlm().llm,
      stage: "final",
      candidates: p.candidates.slice(0, 3),
      matrix,
      brief: state.brief,
      market: marketById("london")!,
      ledger: createLedger(() => 0),
    });
    expect(r).toMatchObject({ verdict: "insufficient_evidence", winnerCandidateId: null });
    expect(Object.keys(r.eliminated)).toEqual(["user", "llm", "agent"]);
  });

  it("24. every one of the 15 scenarios still resolves to exactly the supported city it names", () => {
    expect(SCENARIOS).toHaveLength(15);
    for (const s of SCENARIOS) {
      const market = TARGET_MARKETS.find((m) => s.id.endsWith(`-${m.id}`));
      expect(market, s.id).toBeDefined();
      expect(marketsFromText(s.prompt), s.id).toEqual([market!.id]);
    }
  });
});
