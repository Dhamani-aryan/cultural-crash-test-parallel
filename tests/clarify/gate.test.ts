import { describe, expect, it } from "vitest";
import { answerPatches, foreignNames, isMaterial, runGate } from "@/lib/clarify/gate";
import { detect } from "@/lib/clarify/detect";
import { identityFacts } from "@/lib/clarify/preflight";
import { CLARIFY_BUDGET } from "@/lib/clarify/types";
import { LaunchBriefSchema } from "@/lib/crashtest/types";
import { marketById } from "@/lib/markets";
import { FIXTURES } from "../../eval/clarification-fixtures";
import { worldClient } from "../crashtest/world";

const NONE = { eligibility: false, constraintState: false, eventRole: false, winnerOrder: false, identity: false };
// Two explicit instructions that contradict: still a question after P2.1.
const lesBrief = LaunchBriefSchema.parse({
  productCategory: "Streetwear",
  launchGoal: "Launch event",
  audienceDescription: "Young creatives",
  marketId: "london",
  sourceText: "The pop-up must be in Shoreditch, though anywhere in London is fine.",
});
const ny = marketById("london")!;

describe("materiality", () => {
  it("asks only when eligibility, a constraint, the event role or identity changes", () => {
    expect(isMaterial(NONE)).toBe(false);
    for (const k of ["eligibility", "constraintState", "eventRole", "identity"] as const) expect(isMaterial({ ...NONE, [k]: true })).toBe(true);
    // A trade-off between plan directions needs plans: never at preflight.
    expect(isMaterial({ ...NONE, winnerOrder: true })).toBe(false);
    expect(isMaterial({ ...NONE, winnerOrder: true }, "with_plans")).toBe(true);
  });

  it("works from the brief alone: no Qloo results reach it or the model", async () => {
    // The only facts it takes from Qloo are preflight identity facts (namesakes of the user's own names).
    const prompts: string[] = [];
    const llm = { provider: "fake", model: "fake", generateText: async ({ prompt }: { prompt: string }) => (prompts.push(prompt), { text: '{"proposals":[]}', usage: null, model: "fake", ms: 1 }) };
    const r = await runGate({ brief: lesBrief, market: ny, llm });
    expect(r).toMatchObject({ decision: "clarify", generator: "ok" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toMatch(/affinity|rank|qloo|candidate/i);
    expect(await runGate({ brief: lesBrief, market: ny, llm: null })).toMatchObject({ decision: "clarify", generator: "skipped" });
  });
});

describe("candidate leakage", () => {
  it("flags names the brief and the city don't give, but not sentence openings or the city's areas", () => {
    const allowed = "We're planning a pop-up on the Lower East Side. New York NYC Manhattan";
    expect(foreignNames(["Nearby downtown Manhattan is acceptable"], allowed)).toEqual([]);
    expect(foreignNames(["How strict is the Lower East Side location?"], allowed)).toEqual([]);
    expect(foreignNames(["Should the partner be Brindle Works?"], allowed)).toEqual(["Brindle Works"]);
    expect(foreignNames(["It must be close. Should we use Kith?"], allowed)).toEqual(["Kith"]);
    expect(foreignNames(["Keep it simple. Which comes first?"], allowed)).toEqual([]);
  });
});

describe("answers", () => {
  it("validates the question, the options and the input kind, and is idempotent", async () => {
    const { questions } = await runGate({ brief: lesBrief, market: ny, llm: null });
    const [q] = questions;
    const at = "2026-10-24T00:00:00Z";
    expect(answerPatches(q, { questionId: "other", selectedOptionIds: [q.options[0].id], delegated: false, answeredAt: at })).toEqual({ ok: false, error: `answer is for other, not ${q.id}` });
    expect(answerPatches(q, { questionId: q.id, selectedOptionIds: ["nope"], delegated: false, answeredAt: at })).toMatchObject({ ok: false });
    expect(answerPatches(q, { questionId: q.id, selectedOptionIds: [q.options[0].id, q.options[1].id], delegated: false, answeredAt: at })).toEqual({ ok: false, error: "only one option may be chosen" });
    expect(answerPatches(q, { questionId: q.id, selectedOptionIds: [], delegated: false, answeredAt: at })).toMatchObject({ ok: false });
    // The same answer twice gives the same patches; a repeated option id counts once.
    const a = { questionId: q.id, selectedOptionIds: [q.options[0].id, q.options[0].id], delegated: false, answeredAt: at };
    expect(answerPatches(q, a)).toEqual(answerPatches(q, a));
    expect(answerPatches(q, a)).toMatchObject({ ok: true, patches: q.options[0].patches });
  });
});

describe("the budget", () => {
  it("can never be exceeded, for any fixture, turn, question count or per-turn request", async () => {
    for (const f of FIXTURES)
      for (let turnsUsed = 0; turnsUsed <= 3; turnsUsed++)
        for (let questionsAsked = 0; questionsAsked <= 4; questionsAsked++)
          for (const perTurn of [1, 2, 5]) {
            const r = await runGate({ brief: LaunchBriefSchema.parse(f.brief), market: marketById(f.brief.marketId)!, identities: f.identities, llm: null, budget: { turnsUsed, questionsAsked }, perTurn });
            const left = Math.max(0, Math.min(CLARIFY_BUDGET.maxQuestions - questionsAsked, Math.min(perTurn, CLARIFY_BUDGET.maxPerTurn)));
            const where = `${f.id} turns=${turnsUsed} asked=${questionsAsked} perTurn=${perTurn}`;
            expect(r.questions.length, where).toBeLessThanOrEqual(turnsUsed >= CLARIFY_BUDGET.maxTurns ? 0 : left);
            // Always concludes: ready, or a question within budget; nothing material is silently lost:
            // every deterministic finding is asked, deferred or assumed (and recorded).
            if (r.decision === "ready") expect(r.questions, where).toEqual([]);
            const found = detect(LaunchBriefSchema.parse(f.brief), marketById(f.brief.marketId)!, f.identities ?? []).uncertainties.map((u) => u.id);
            for (const id of found) expect(r.audit.some((a) => a.id === id), `${where}: ${id}`).toBe(true);
            if (!r.deferred.length && r.decision === "ready") for (const a of r.audit.filter((x) => x.origin === "deterministic")) expect(["assumed", "dropped"], where).toContain(a.outcome);
          }
  });

  it("asks two questions only when asked to, never more than the per-turn cap", async () => {
    const f = FIXTURES.find((x) => x.id === "budget-priority-and-defer")!;
    const r = await runGate({ brief: LaunchBriefSchema.parse(f.brief), market: ny, identities: f.identities, llm: null, perTurn: 2 });
    expect(r.questions.map((q) => q.reason)).toEqual(["conflict", "conflict"]);
    expect(r.deferred).toHaveLength(1);
  });
});

describe("identity preflight", () => {
  it("turns the existing namesake protection into identity facts, and leaves clear names alone", async () => {
    const brief = LaunchBriefSchema.parse({
      productCategory: "Streetwear",
      launchGoal: "Pop-up launch",
      audienceDescription: "Fans",
      marketId: "london",
      existingChoices: [
        { slot: "artist_music", name: "Big Tex" },
        { slot: "brand_collaboration", name: "Mossgrove" },
        { slot: "event_place", name: "Yard Market" },
      ],
    });
    const countries = new Map([
      ["big tex", "India"],
      ["mossgrove", "United Kingdom"],
    ]);
    const facts = await identityFacts(worldClient().client, brief, marketById("london")!, countries);
    expect(facts).toEqual([{ slot: "artist_music", name: "Big Tex", expectedCountry: "India", qlooDescription: "American rapper." }]);
    // And the gate asks which one is meant; delegating keeps it unresolved and provisional.
    const r = await runGate({ brief, market: marketById("london")!, identities: facts, llm: null });
    expect(r.questions[0]).toMatchObject({ reason: "entity_identity", delegationIsProvisional: true });
  });
});
