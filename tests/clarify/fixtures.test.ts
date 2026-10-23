import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { answerPatches, foreignNames, runGate } from "@/lib/clarify/gate";
import { CLARIFY_BUDGET, type GateResult } from "@/lib/clarify/types";
import { LaunchBriefSchema } from "@/lib/crashtest/types";
import type { LlmClient } from "@/lib/llm/types";
import { marketById } from "@/lib/markets";
import { FIXTURES, REVIEWED_AT, REVIEWED_BY, type ClarificationFixture, type GeneratorReply } from "../../eval/clarification-fixtures";

/** A scripted clarification model: the fixture's proposals, or a failed call. Records what it was shown. */
function scripted(reply: GeneratorReply) {
  const prompts: string[] = [];
  const llm: LlmClient = {
    provider: "fake",
    model: "fake",
    async generateText({ system, prompt }) {
      prompts.push(prompt);
      if (!system.startsWith("You review a product-launch brief")) throw new Error(`unexpected call: ${system.slice(0, 40)}`);
      if (reply === "fail") throw new Error("model down");
      return { text: JSON.stringify(reply), usage: null, model: "fake", ms: 1 };
    },
  };
  return { llm, prompts };
}

async function gate(f: ClarificationFixture) {
  const s = scripted(f.generator);
  const result = await runGate({
    brief: LaunchBriefSchema.parse(f.brief),
    market: marketById(f.brief.marketId)!,
    identities: f.identities,
    llm: s.llm,
    budget: f.budget,
    askedIds: f.askedIds,
    forbiddenNames: f.forbiddenNames,
  });
  return { result, prompts: s.prompts };
}

const questionText = (r: GateResult) => r.questions.flatMap((q) => [q.prompt, ...q.options.map((o) => o.label)]).join(" | ");

describe("the frozen clarification fixtures", () => {
  it("are recorded, and any edit to them is visible", () => {
    // Update this fingerprint only on a reviewed change (and record the reviewer in the fixture file).
    const fp = createHash("sha256").update(JSON.stringify(FIXTURES)).digest("hex").slice(0, 16);
    expect({ fp, reviewed: REVIEWED_BY !== null && REVIEWED_AT !== null }).toEqual({ fp: FIXTURE_FINGERPRINT, reviewed: false });
    expect(new Set(FIXTURES.map((f) => f.id)).size).toBe(FIXTURES.length);
    // The set covers every kind the plan requires.
    expect(new Set(FIXTURES.map((f) => f.kind))).toEqual(new Set(["clear", "ambiguous", "conflict", "identity", "answer", "unnecessary", "leading", "generator_failure", "budget"]));
  });

  for (const f of FIXTURES)
    it(`${f.id}: ${f.note}`, async () => {
      const { result: r, prompts } = await gate(f);
      expect(r.decision).toBe(f.expect.decision);
      // Never more than the budget allows, and never more than one question by default.
      expect(r.questions.length).toBeLessThanOrEqual(Math.min(CLARIFY_BUDGET.defaultPerTurn, CLARIFY_BUDGET.maxQuestions - (f.budget?.questionsAsked ?? 0)));
      if ((f.budget?.turnsUsed ?? 0) >= CLARIFY_BUDGET.maxTurns) expect(r.questions).toEqual([]);
      if (f.expect.decision === "clarify") {
        const [q] = r.questions;
        expect(f.expect.reasons).toContain(q.reason);
        if (f.expect.questionId) expect(q.id.startsWith(f.expect.questionId)).toBe(true);
        // Every question can be delegated, answered in free text, and cites the brief's own words.
        expect(q).toMatchObject({ allowCustom: true, allowDelegate: true });
        expect(q.options.length).toBeGreaterThanOrEqual(2);
        expect(q.sourcePhrases.length).toBeGreaterThan(0);
        expect(q.materialEffect.length).toBeGreaterThan(0);
      }
      for (const bad of f.expect.forbidden ?? []) expect(questionText(r).toLowerCase()).not.toContain(bad.toLowerCase());
      // No asked question, deterministic or proposed, names anything the brief and the city don't.
      const m = marketById(f.brief.marketId)!;
      const allowed = [f.brief.sourceText ?? "", f.brief.launchGoal, ...(f.brief.existingChoices ?? []).map((c) => c.name), ...(f.identities ?? []).map((i) => `${i.expectedCountry} ${i.qlooDescription}`), m.label, m.qlooLocation, ...(m.locationAliases ?? [])].join(" ");
      expect(foreignNames(r.questions.flatMap((x) => [x.prompt, ...x.options.map((o) => o.label)]), allowed)).toEqual([]);
      // The model is never shown candidate names.
      for (const n of f.forbiddenNames ?? []) for (const p of prompts) expect(p).not.toContain(n);
      for (const want of f.expect.resolutions ?? []) expect(r.resolutions.flatMap((x) => x.patches)).toContainEqual(want);
      if (f.expect.assumption) expect(r.assumptions.join(" ")).toContain(f.expect.assumption);
      if (f.expect.deferred !== undefined) expect(r.deferred).toHaveLength(f.expect.deferred);
      if (f.generator === "fail") expect(r.generator).toBe("failed");

      const [q] = r.questions;
      if (f.expect.delegated) {
        const d = answerPatches(q, { questionId: q.id, selectedOptionIds: [], delegated: true, answeredAt: "t" });
        expect(d).toMatchObject({ ok: true, provisional: f.expect.delegated.provisional, patches: f.expect.delegated.patches });
        if (d.ok) expect(d.assumption).toContain(f.expect.delegated.assumption);
      }
      for (const a of f.expect.answers ?? []) {
        const out = answerPatches(q, { questionId: q.id, selectedOptionIds: (a.options ?? []).map((n) => q.options[n - 1].id), customText: a.text, delegated: false, answeredAt: "t" });
        expect(out.ok).toBe(true);
        if (!out.ok) continue;
        if (a.patches) expect(out.patches).toEqual(a.patches);
        expect(out.needsInterpretation).toBe(a.needsInterpretation ?? false);
      }
      // Every uncertainty is accounted for, asked or not.
      expect(r.audit.filter((x) => x.outcome === "asked").map((x) => x.id)).toEqual(r.questions.map((x) => x.id));
    });
});

/** The fixtures' fingerprint as written (draft, before human review). */
const FIXTURE_FINGERPRINT = "d252961556cb6512";
