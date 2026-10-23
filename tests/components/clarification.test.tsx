import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClarificationCard } from "@/components/clarification";
import { answerFromSelection, answerFromText, DELEGATE_LABEL, emptyClarify, recoveryFor, reduceClarify } from "@/components/clarify-view";
import { reduceStream, type View } from "@/components/use-crash-test";
import type { ClarifyEvent, PublicQuestion, PublicSession } from "@/lib/clarify/session";

const session: PublicSession = { sessionId: "6f1c1f33-1111-4111-8111-111111111111", state: "awaiting_clarification", turnsUsed: 1, questionsAsked: 1, maxTurns: 2, maxQuestions: 3, assumptions: [] };
const q = (id: string, kind: PublicQuestion["inputKind"], labels: string[]): PublicQuestion => ({
  id,
  reason: "geography",
  prompt: `Question ${id}?`,
  inputKind: kind,
  options: labels.map((label, i) => ({ id: `${id}#${i + 1}`, label })),
  allowCustom: true,
  allowDelegate: true,
  affectedSlots: ["event_place"],
  sourcePhrases: ["a pop-up in Shoreditch"],
  materialEffect: "changes which candidates are eligible",
  delegatedAssumption: "Shoreditch is treated as preferred.",
  delegationIsProvisional: false,
});
const radio = q("geography:shoreditch", "single_choice", ["It must be in Shoreditch", "Nearby is acceptable", "Anywhere in London is acceptable"]);
const boxes = q("model:geography:0", "multi_choice", ["Founded in the city", "Independent rather than global", "Culturally relevant here"]);
const required = (qs: PublicQuestion[]): ClarifyEvent => ({ type: "clarification_required", session, questions: qs });

describe("the clarification conversation", () => {
  it("adds a question once, keeps it on an off-topic reply, and moves to the next turn without resetting", () => {
    let c = reduceClarify(emptyClarify, { type: "assistant_message", text: "One thing could materially change the plan." });
    c = reduceClarify(c, required([radio]));
    expect(c.items.map((i) => i.kind)).toEqual(["assistant", "questions"]);
    expect(c.active).toEqual([radio]);
    // The server repeats the open question after an off-topic message: no duplicate card.
    c = reduceClarify(c, { type: "assistant_message", text: "That doesn't answer the open question, so it is still open." });
    c = reduceClarify(c, required([radio]));
    expect(c.items.filter((i) => i.kind === "questions")).toHaveLength(1);
    // The answer's acknowledgement, then a second turn: appended, nothing lost or repeated.
    c = reduceClarify(c, { type: "clarification_applied", sessionId: session.sessionId, acknowledgement: "Got it: It must be in Shoreditch.", briefDraft: { productCategory: "x", launchGoal: "x", marketId: "london", audienceDescription: "xyz" } as never });
    expect(c.active).toBeNull();
    c = reduceClarify(c, required([boxes]));
    expect(c.items.map((i) => i.kind)).toEqual(["assistant", "questions", "assistant", "assistant", "questions"]);
    expect(c.active).toEqual([boxes]);
    c = reduceClarify(c, { type: "ready", sessionId: session.sessionId, clarifiedBrief: {} as never, fingerprint: "f", assumptions: [], provisional: [] });
    expect(c.active).toBeNull();
  });

  it("pauses the run view while a question is open, and resumes it on run_started", () => {
    const base = { phase: "running", replay: null, log: [], evidence: [], initialPlan: null, plan: null, budget: null, result: null, error: null, clarify: emptyClarify } as View;
    const asked = reduceStream(base, required([radio]));
    expect(asked.phase).toBe("awaiting");
    const resumed = reduceStream(asked, { type: "run_started", runId: "r", sessionId: session.sessionId });
    expect(resumed.phase).toBe("running");
    expect(reduceStream(resumed, { type: "stage", stage: "tracks", message: "Building plans" }).log).toHaveLength(1);
  });
});

describe("answers from the card and the composer", () => {
  it("send option ids or a delegation, and show the user's own choice as their message", () => {
    expect(answerFromSelection([radio], {})).toBeNull();
    expect(answerFromSelection([radio], { [radio.id]: { optionIds: [radio.options[0].id], delegated: false } })).toEqual({
      answers: [{ questionId: radio.id, selectedOptionIds: [radio.options[0].id] }],
      receipt: "It must be in Shoreditch",
    });
    expect(answerFromSelection([boxes], { [boxes.id]: { optionIds: [boxes.options[0].id, boxes.options[1].id], delegated: false } })!.receipt).toBe("Founded in the city, Independent rather than global");
    expect(answerFromSelection([radio], { [radio.id]: { optionIds: [], delegated: true } })).toEqual({ answers: [{ questionId: radio.id, delegated: true }], receipt: DELEGATE_LABEL });
    expect(answerFromText("Nearby is fine")).toEqual([{ message: "Nearby is fine" }]);
  });

  it("recover with one concise action, never echoing server detail", () => {
    expect(recoveryFor(404)).toEqual({ kind: "expired", message: "This question has expired.", action: "restart" });
    expect(recoveryFor(409)).toMatchObject({ action: "restart" });
    expect(recoveryFor(400)).toMatchObject({ action: "retry", message: "That answer couldn’t be used." });
    for (const s of [400, 404, 409, 429, 500]) expect(recoveryFor(s).message).not.toMatch(/session|id|geography|patch|fingerprint|uuid/i);
  });
});

describe("the question card", () => {
  const html = (qs: PublicQuestion[], disabled = false) => renderToStaticMarkup(<ClarificationCard questions={qs} disabled={disabled} onAnswer={() => {}} />);

  it("renders one answer as radios and several as checkboxes, each with an equal 'Decide for me'", () => {
    const one = html([radio]);
    expect(one.match(/type="radio"/g)).toHaveLength(4);
    expect(one).not.toContain('type="checkbox"');
    const many = html([boxes]);
    expect(many.match(/type="checkbox"/g)).toHaveLength(4);
    for (const h of [one, many]) {
      expect(h).toContain(`<span>${DELEGATE_LABEL}</span>`);
      // Every option, "Decide for me" included, is the same kind of row.
      const rows = h.match(/<label class="[^"]*"/g)!;
      expect(new Set(rows.map((r) => r.replace(/border-ink\/45 text-ink|border-line text-ink-2 hover:border-ink\/25/, "")))).toHaveProperty("size", 1);
    }
    // A question is a labelled group, and Continue waits for a choice.
    expect(one).toMatch(/<fieldset[^>]*><legend[^>]*>Question geography:shoreditch\?<\/legend>/);
    expect(one).toMatch(/<button type="submit" disabled=""[^>]*>Continue<\/button>/);
  });

  it("shows no internals: no ids, reason codes, effects, phrases or session details", () => {
    const h = html([radio, boxes]).replace(/Question [^?]+\?/g, "");
    for (const internal of ["#1", "model:", "geography:", "materialEffect", "changes which candidates", "a pop-up in Shoreditch", session.sessionId, "delegat", "patch", "fingerprint"]) expect(h).not.toContain(internal);
  });

  it("is disabled while an answer is being sent", () => {
    expect(html([radio], true)).toMatch(/<fieldset disabled=""/);
  });
});
