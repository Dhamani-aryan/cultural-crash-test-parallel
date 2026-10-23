import { describe, expect, it } from "vitest";
import { interpretText } from "@/lib/clarify/interpret";
import { applyPatches } from "@/lib/clarify/patch";
import { answerSession, clarifiedContract, SessionError, startSession, type ClarifyEvent, type Session } from "@/lib/clarify/session";
import { CLARIFY_BUDGET } from "@/lib/clarify/types";
import { freezeBrief } from "@/lib/crashtest/tracks";
import { LaunchBriefSchema, type LaunchBriefInput } from "@/lib/crashtest/types";
import { LONDON_BRIEF, worldClient, worldLlm } from "../crashtest/world";

const brief = (sourceText: string, over: Partial<LaunchBriefInput> = {}): LaunchBriefInput => ({ ...LONDON_BRIEF, sourceText, ...over });
const deps = (over: Parameters<typeof worldLlm>[0] = {}) => ({ llm: worldLlm(over).llm, qloo: worldClient().client });
const of = <T extends ClarifyEvent["type"]>(events: ClarifyEvent[], type: T) => events.filter((e): e is Extract<ClarifyEvent, { type: T }> => e.type === type);
const question = (s: Session) => s.pending[0];
const rules = (s: Session) => (s.brief.constraints ?? []).map((c) => `${c.kind}: ${c.description}${c.lockSlot ? ` [lock ${c.lockSlot}]` : ""}`);

describe("a clear brief", () => {
  it("is ready without a question, with what the brief settles applied to it", async () => {
    const { session, events } = await startSession(
      brief("We've booked Yard Market for a pop-up around Shoreditch, and we're hoping to get Grey Lane for a set.", {
        existingChoices: [
          { slot: "event_place", name: "Yard Market" },
          { slot: "artist_music", name: "Grey Lane" },
        ],
      }),
      deps(),
    );
    expect(of(events, "clarification_required")).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(["assistant_message", "ready"]);
    expect(session.state).toBe("ready");
    // "Booked" became a machine-checked lock without asking; "hoping" and "around" are recorded.
    expect(rules(session)).toEqual([
      "hard: Keep the pop-up venue: Yard Market [lock event_place]",
      "soft: Grey Lane is only being considered; explore alternatives",
      "soft: A venue in or near Shoreditch is preferred; elsewhere is acceptable if it is clearly stronger",
    ]);
    // The user's own words are never edited.
    expect(session.brief.sourceText).toBe(session.original.sourceText);
    const ready = of(events, "ready")[0];
    expect(ready.fingerprint).toBe(freezeBrief(LaunchBriefSchema.parse(ready.clarifiedBrief)).fingerprint);
    // The recompiled contract reads the clarifications.
    expect(clarifiedContract(session).choices.find((c) => c.slot === "event_place")?.strength).toBe("locked");
  });
});

describe("one material question", () => {
  const ambiguous = () => startSession(brief("A pop-up in Shoreditch with live screen printing."), deps());

  it("asks it with a public question that carries no patches", async () => {
    const { session, events } = await ambiguous();
    const req = of(events, "clarification_required")[0];
    expect(session).toMatchObject({ state: "awaiting_clarification", turnsUsed: 1, questionsAsked: 1 });
    expect(req.questions).toHaveLength(1);
    expect(req.questions[0]).toMatchObject({ reason: "geography", allowCustom: true, allowDelegate: true });
    expect(JSON.stringify(req.questions)).not.toContain("patches");
    expect(req.session).toMatchObject({ maxTurns: CLARIFY_BUDGET.maxTurns, maxQuestions: CLARIFY_BUDGET.maxQuestions });
  });

  it("applies a button answer as a deterministic patch and becomes ready", async () => {
    const { session } = await ambiguous();
    const q = question(session);
    const out = await answerSession(session, [{ questionId: q.id, selectedOptionIds: [q.options[0].id] }], deps());
    expect(out.events.map((e) => e.type)).toEqual(["clarification_applied", "ready"]);
    expect(of(out.events, "clarification_applied")[0].acknowledgement).toMatch(/^Got it: It must be in Shoreditch\. I have enough information now/);
    expect(rules(out.session)).toContain("hard: The venue must be in Shoreditch");
    expect(out.session.audit).toContainEqual({ source: q.id, patch: { kind: "geography", place: "Shoreditch", strictness: "required" }, effect: "added a hard rule: The venue must be in Shoreditch" });
  });

  it("reads a typed message as the answer, keeps an unrelated one from answering, and records a custom one", async () => {
    const typed = await ambiguous();
    const q = question(typed.session);
    expect(interpretText(q, "It has to be in Shoreditch")).toEqual({ kind: "option", optionId: q.options[0].id });
    expect(interpretText(q, "Nearby is fine")).toEqual({ kind: "option", optionId: q.options[1].id });
    expect(interpretText(q, "anywhere but Shoreditch itself")).toMatchObject({ kind: "custom" });
    // The place the question asks about doesn't pick an option by itself.
    expect(interpretText(q, "Somewhere with a courtyard close to Shoreditch")).toEqual({ kind: "option", optionId: q.options[1].id });
    expect(interpretText(q, "We would like a courtyard space, ideally in Shoreditch")).toMatchObject({ kind: "custom" });
    expect(interpretText(q, "How long does a run take?")).toEqual({ kind: "unrelated" });
    expect(interpretText(q, "I'm not sure, use your judgement")).toEqual({ kind: "delegate" });

    const answered = await answerSession(typed.session, [{ message: "It has to be in Shoreditch" }], deps());
    expect(rules(answered.session)).toContain("hard: The venue must be in Shoreditch");

    const other = await ambiguous();
    const before = structuredClone(other.session);
    const off = await answerSession(other.session, [{ message: "How long does a run take?" }], deps());
    expect(off.events.map((e) => e.type)).toEqual(["assistant_message", "clarification_required"]);
    expect(off.session).toEqual(before);

    const custom = await ambiguous();
    const c = await answerSession(custom.session, [{ message: "We would like a courtyard space, ideally in Shoreditch" }], deps());
    expect(c.session.state).toBe("ready");
    expect(c.session.assumptions.join(" ")).toContain("We would like a courtyard space, ideally in Shoreditch");
  });

  it("'Decide for me' records the declared assumption and proceeds", async () => {
    const { session } = await ambiguous();
    const out = await answerSession(session, [{ questionId: question(session).id, delegated: true }], deps());
    expect(out.session.state).toBe("ready");
    expect(of(out.events, "clarification_applied")[0].acknowledgement).toMatch(/^I'll decide: Shoreditch is treated as preferred, not mandatory/);
    expect(of(out.events, "ready")[0].assumptions).toContain("Shoreditch is treated as preferred, not mandatory; a venue elsewhere is flagged if it wins.");
    expect(rules(out.session)).toContain("soft: A venue in or near Shoreditch is preferred; elsewhere is acceptable if it is clearly stronger");
  });

  it("is idempotent for a repeated submission, and rejects invalid ones", async () => {
    const { session } = await ambiguous();
    const q = question(session);
    const a = [{ questionId: q.id, selectedOptionIds: [q.options[0].id] }];
    const first = await answerSession(session, a, deps());
    const snapshot = structuredClone(first.session);
    const again = await answerSession(first.session, a, deps());
    expect(again).toMatchObject({ replayed: true, events: first.events });
    expect(again.session).toEqual(snapshot);
    // A different answer after the session is ready is refused.
    await expect(answerSession(first.session, [{ questionId: q.id, selectedOptionIds: [q.options[1].id] }], deps())).rejects.toMatchObject({ code: "invalid_state" });

    const fresh = await ambiguous();
    const fq = question(fresh.session);
    await expect(answerSession(fresh.session, [{ questionId: "nope", selectedOptionIds: [] }], deps())).rejects.toMatchObject({ code: "unknown_question" });
    await expect(answerSession(fresh.session, [{ questionId: fq.id, selectedOptionIds: ["nope"] }], deps())).rejects.toBeInstanceOf(SessionError);
    await expect(answerSession(fresh.session, [{ questionId: fq.id, selectedOptionIds: [fq.options[0].id, fq.options[1].id] }], deps())).rejects.toMatchObject({ code: "invalid_answer" });
    expect(fresh.session.state).toBe("awaiting_clarification");
  });
});

describe("the budget across turns", () => {
  it("asks at most two turns and three questions, then applies defaults and concludes", async () => {
    // Four material uncertainties: a conflict, a namesake, an act's strength and the area.
    const b = brief("We've booked Yard Market for a pop-up in Shoreditch, but please find a better venue if you can. We'd like Big Tex to perform.", {
      existingChoices: [
        { slot: "event_place", name: "Yard Market" },
        { slot: "artist_music", name: "Big Tex" },
      ],
    });
    const d = deps({ choiceCountry: "India" });
    const t1 = await startSession(b, d);
    expect(question(t1.session).reason).toBe("conflict");
    const t2 = await answerSession(t1.session, [{ questionId: question(t1.session).id, selectedOptionIds: [question(t1.session).options[0].id] }], d);
    expect(t2.session.state).toBe("awaiting_clarification");
    expect(question(t2.session).reason).toBe("entity_identity");
    const t3 = await answerSession(t2.session, [{ questionId: question(t2.session).id, delegated: true }], d);
    // No third turn: the rest is assumed, recorded, and the run can start.
    expect(t3.session).toMatchObject({ state: "ready", turnsUsed: 2, questionsAsked: 2 });
    expect(t3.session.assumptions.join(" ")).toMatch(/Big Tex is treated as preferred, not fixed/);
    expect(t3.session.assumptions.join(" ")).toMatch(/Shoreditch is treated as preferred/);
    // The delegated identity stays open: the result will be provisional.
    expect(t3.session.provisional.join(" ")).toMatch(/Big Tex/);
    expect(rules(t3.session)).toContain("hard: Keep the pop-up venue: Yard Market [lock event_place]");
    expect(t3.session.asked.length).toBeLessThanOrEqual(CLARIFY_BUDGET.maxQuestions);
  });
});

describe("the model", () => {
  it("failing never blocks: the session proceeds with the failure disclosed", async () => {
    const { session, events } = await startSession(brief("We're launching a skincare line with a pop-up and a sampling workshop."), deps({ clarify: "fail" }));
    expect(session.state).toBe("ready");
    expect(of(events, "ready")[0].assumptions.join(" ")).toMatch(/clarification model was unavailable/);
  });

  it("a multi-choice question takes several answers as several patches", async () => {
    const clarify = {
      proposals: [
        {
          reason: "geography",
          what: "What 'local' requires of the partner.",
          sourcePhrases: ["a local brand partner"],
          affectedSlots: ["brand_collaboration"],
          interpretations: [
            { label: "Founded in the city", consequence: "" },
            { label: "Independent rather than global", consequence: "" },
            { label: "Culturally relevant here", consequence: "" },
          ],
          multi: true,
          changesEligibility: true,
          changesConstraint: false,
          changesEventRole: false,
          identityRisk: false,
          safeDefault: "Local relevance is preferred, not mandatory.",
          prompt: "Which of these must the partner be? Select any that are required.",
        },
      ],
    };
    const { session } = await startSession(brief("A pop-up for our streetwear label with a local brand partner."), deps({ clarify }));
    const q = question(session);
    expect(q.inputKind).toBe("multi_choice");
    const out = await answerSession(session, [{ questionId: q.id, selectedOptionIds: [q.options[0].id, q.options[1].id] }], deps({ clarify }));
    expect(rules(out.session)).toEqual(expect.arrayContaining(["hard: Required: Founded in the city", "hard: Required: Independent rather than global"]));
  });
});

describe("brief patches", () => {
  it("never exceed the brief's rule limit, and the same clarification twice is one rule", () => {
    const base = LaunchBriefSchema.parse({ ...LONDON_BRIEF, constraints: Array.from({ length: 7 }, (_, i) => ({ id: `c${i}`, description: `Rule ${i}`, kind: "soft" })) });
    const r = applyPatches(base, [
      { kind: "geography", place: "Shoreditch", strictness: "required" },
      { kind: "geography", place: "Shoreditch", strictness: "required" },
      { kind: "event_format", format: "exhibition" },
    ]);
    expect(r.brief.constraints).toHaveLength(8);
    expect(r.applied.map((a) => a.effect)).toEqual(["added a hard rule: The venue must be in Shoreditch", "already recorded", "recorded only: the brief's rule limit is reached"]);
    expect(r.assumptions[0]).toMatch(/recorded, not enforced/);
    expect(() => LaunchBriefSchema.parse(r.brief)).not.toThrow();
  });

  it("resolve a named-and-excluded conflict either way, and unlock a choice made preferred", () => {
    const b = LaunchBriefSchema.parse({
      ...LONDON_BRIEF,
      existingChoices: [{ slot: "brand_collaboration", name: "Mossgrove" }],
      constraints: [
        { id: "x", description: "Never use Mossgrove", kind: "hard", excludeNames: ["Mossgrove"] },
        { id: "l", description: "Keep Mossgrove", kind: "hard", lockSlot: "brand_collaboration" },
      ],
    });
    expect(applyPatches(b, [{ kind: "priority", keep: "exclude Mossgrove", over: "use Mossgrove" }]).brief.existingChoices).toEqual([]);
    expect(applyPatches(b, [{ kind: "priority", keep: "use Mossgrove", over: "exclude Mossgrove" }]).brief.constraints!.some((c) => c.excludeNames)).toBe(false);
    const preferred = applyPatches(b, [{ kind: "choice_strength", slot: "brand_collaboration", name: "Mossgrove", strength: "preferred" }]);
    expect(preferred.brief.constraints!.some((c) => c.lockSlot)).toBe(false);
    expect(preferred.applied[0].effect).toMatch(/^removed the lock/);
  });
});
