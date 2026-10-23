import type { AnswerInput, ClarifyEvent, PublicQuestion } from "@/lib/clarify/session";

/**
 * The clarification part of the conversation, as plain data: what the assistant said, the
 * questions it asked, what the user answered. Session ids, fingerprints, reason codes and patches
 * are kept out of anything rendered; the session id is held only to send the next answer.
 */

export type ClarifyItem =
  | { kind: "assistant"; id: string; text: string }
  | { kind: "user"; id: string; text: string }
  | { kind: "questions"; id: string; questions: PublicQuestion[] };

export type Recovery = { kind: "expired" | "rejected" | "answered" | "failed"; message: string; action: "restart" | "retry" };

export interface ClarifyView {
  items: ClarifyItem[];
  /** The open questions, while the conversation waits for an answer. */
  active: PublicQuestion[] | null;
  /** Held to send the next answer; never shown. */
  sessionId: string | null;
  /** An answer is being sent (the card and composer are disabled). */
  sending: boolean;
  recovery: Recovery | null;
}

export const emptyClarify: ClarifyView = { items: [], active: null, sessionId: null, sending: false, recovery: null };

let n = 0;
const id = () => `c${++n}`;

/** Fold one clarification event into the conversation. */
export function reduceClarify(c: ClarifyView, e: ClarifyEvent): ClarifyView {
  switch (e.type) {
    case "assistant_message":
      return { ...c, items: [...c.items, { kind: "assistant", id: id(), text: e.text }] };
    case "clarification_required": {
      const same = c.active && c.active.map((q) => q.id).join() === e.questions.map((q) => q.id).join();
      // The same open question again (an off-topic reply): keep the card that is already there.
      if (same) return { ...c, sessionId: e.session.sessionId, sending: false };
      return { ...c, sessionId: e.session.sessionId, active: e.questions, sending: false, recovery: null, items: [...c.items, { kind: "questions", id: id(), questions: e.questions }] };
    }
    case "clarification_applied":
      return { ...c, active: null, sending: false, items: [...c.items, { kind: "assistant", id: id(), text: e.acknowledgement }] };
    case "ready":
    case "run_started":
      return { ...c, active: null, sending: false };
  }
}

export const isClarifyEvent = (e: { type: string }): e is ClarifyEvent =>
  e.type === "assistant_message" || e.type === "clarification_required" || e.type === "clarification_applied" || e.type === "ready" || e.type === "run_started";

/** A selection on the card: option ids per question, or "decide for me". */
export type Selection = Record<string, { optionIds: string[]; delegated: boolean }>;

export const DELEGATE_LABEL = "Decide for me";

/** The card's selection as answers, and the words shown as the user's message. */
export function answerFromSelection(questions: PublicQuestion[], sel: Selection): { answers: AnswerInput[]; receipt: string } | null {
  const answers: AnswerInput[] = [];
  const said: string[] = [];
  for (const q of questions) {
    const s = sel[q.id];
    if (!s || (!s.delegated && !s.optionIds.length)) return null;
    if (s.delegated) {
      answers.push({ questionId: q.id, delegated: true });
      said.push(DELEGATE_LABEL);
    } else {
      answers.push({ questionId: q.id, selectedOptionIds: s.optionIds });
      said.push(q.options.filter((o) => s.optionIds.includes(o.id)).map((o) => o.label).join(", "));
    }
  }
  return { answers, receipt: said.join("\n") };
}

/** A typed message answers the open question; the server reads it against the options. */
export const answerFromText = (text: string): AnswerInput[] => [{ message: text }];

/** Concise recovery for a refused answer. Never echoes server detail, which can name internals. */
export function recoveryFor(status: number): Recovery {
  if (status === 404) return { kind: "expired", message: "This question has expired.", action: "restart" };
  if (status === 409) return { kind: "answered", message: "This question was already answered.", action: "restart" };
  if (status === 400) return { kind: "rejected", message: "That answer couldn’t be used.", action: "retry" };
  if (status === 429) return { kind: "failed", message: "Live runs are rate-limited on this demo. Try again in a few minutes.", action: "retry" };
  return { kind: "failed", message: "Something went wrong sending that answer.", action: "retry" };
}
