"use client";

import { useCallback, useRef, useState } from "react";
import type { AnswerInput, ClarifyEvent } from "@/lib/clarify/session";
import {
  emptyClarify,
  isClarifyEvent,
  recoveryFor,
  reduceClarify,
  type ClarifyItem,
  type ClarifyView,
} from "./clarify-view";
import type { IntakeState } from "@/lib/intake/types";
import type {
  CulturalPlan,
  EvidenceRecord,
  LaunchBriefInput,
  PlanEvaluation,
  RunEvent,
  RunState,
} from "@/lib/crashtest/types";
import { apiErrorMessage } from "./error-copy";

/** One line of the agent console, in the order things happened. */
export type LogEntry =
  | { kind: "stage"; stage: string; message: string }
  | { kind: "action"; iteration: number; slot: string; why: string }
  | { kind: "change"; change: Extract<RunEvent, { type: "change" }>["change"] }
  | { kind: "evaluation"; evaluation: PlanEvaluation };

export interface View {
  /** "awaiting": the run paused on a clarification question until the user answers. */
  phase: "idle" | "running" | "awaiting" | "done" | "error";
  /** Set when the server replays a recorded run instead of running live. */
  replay: string | null;
  log: LogEntry[];
  evidence: EvidenceRecord[];
  initialPlan: CulturalPlan | null;
  plan: CulturalPlan | null;
  budget: { used: number; max: number } | null;
  result: RunState | null;
  error: string | null;
  clarify: ClarifyView;
}

const initial: View = {
  phase: "idle",
  replay: null,
  log: [],
  evidence: [],
  initialPlan: null,
  plan: null,
  budget: null,
  result: null,
  error: null,
  clarify: emptyClarify,
};

type StreamEvent = RunEvent | ClarifyEvent;

/** Fold one stream event: clarification events into the conversation, run events into the run. */
export function reduceStream(v: View, e: StreamEvent): View {
  if (!isClarifyEvent(e)) return reduce(v, e);
  const clarify = reduceClarify(v.clarify, e);
  return {
    ...v,
    clarify,
    phase:
      e.type === "clarification_required"
        ? "awaiting"
        : e.type === "run_started" || e.type === "ready"
          ? "running"
          : v.phase,
  };
}

type RunInput = LaunchBriefInput | { intake: IntakeState; depth: "quick" | "thorough" };

export function reduce(v: View, e: RunEvent): View {
  switch (e.type) {
    case "stage":
      if (e.stage === "replay") return { ...v, replay: e.message };
      return { ...v, log: [...v.log, { kind: "stage", stage: e.stage, message: e.message }] };
    case "evidence":
      return { ...v, evidence: [...v.evidence, e.record] };
    case "plan":
      return e.label === "initial"
        ? { ...v, initialPlan: e.plan, plan: e.plan }
        : { ...v, plan: e.plan };
    case "evaluation":
      return { ...v, log: [...v.log, { kind: "evaluation", evaluation: e.evaluation }] };
    case "action":
      return {
        ...v,
        log: [
          ...v.log,
          { kind: "action", iteration: e.action.iteration, slot: e.action.slot, why: e.action.why },
        ],
      };
    case "change":
      return { ...v, log: [...v.log, { kind: "change", change: e.change }] };
    case "budget":
      return { ...v, budget: { used: e.qlooCallsUsed, max: e.maxQlooCalls } };
    case "done":
      return {
        ...v,
        phase: "done",
        result: e.state,
        plan: e.state.plan,
        initialPlan: e.state.initialPlan,
        budget: { used: e.state.qlooCallsUsed, max: e.state.maxQlooCalls },
      };
    case "error":
      return {
        ...v,
        phase: "error",
        error: apiErrorMessage(
          /qloo/i.test(e.message)
            ? "qloo_error"
            : /(?:model|llm)/i.test(e.message)
              ? "llm_error"
              : "stream_error",
          500,
          e.message,
          "run",
        ),
      };
    default:
      // Clarification events (P1) are rendered by the chat interface (P2); the run view ignores them.
      return v;
  }
}

/** Parse server-sent events from a fetch body (the endpoint is POST, so no EventSource). */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      if (data) yield JSON.parse(data) as StreamEvent;
    }
  }
}

export function useCrashTest() {
  const [view, setView] = useState<View>(initial);
  const abort = useRef<AbortController | null>(null);
  /** The latest view, for continuing a stream from where the conversation is. */
  const latest = useRef<View>(initial);
  const lastInput = useRef<{ input: RunInput; fresh: boolean } | null>(null);
  const show = useCallback((v: View) => {
    latest.current = v;
    setView(v);
  }, []);

  /** Read one response's events into the view, starting from `from`. */
  const consume = useCallback(
    async (res: Response, from: View) => {
      let current = from;
      for await (const event of readSse(res.body!)) {
        current = reduceStream(current, event);
        show(current);
      }
      // A stream that pauses on a question is waiting for the user, not broken.
      if (current.phase === "running")
        show({
          ...current,
          phase: "error",
          error: "The connection closed before the run finished.",
        });
    },
    [show],
  );

  const fail = useCallback(
    (controller: AbortController, err: unknown) => {
      const v = latest.current;
      if (controller.signal.aborted) {
        show({
          ...v,
          phase: v.result ? "done" : "error",
          error: v.result ? null : "Cancelled.",
          clarify: { ...v.clarify, sending: false, active: null },
        });
        return;
      }
      show({
        ...v,
        phase: "error",
        error: err instanceof Error ? err.message : String(err),
        clarify: { ...v.clarify, sending: false },
      });
    },
    [show],
  );

  const run = useCallback(
    async (input: RunInput, fresh = false) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      lastInput.current = { input, fresh };
      show({ ...initial, phase: "running" });
      try {
        const res = await fetch("/api/crashtest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // Every run goes through the clarification gate; a clear brief continues straight into the run.
          body: JSON.stringify(
            "intake" in input
              ? { ...input, fresh, clarify: true }
              : { brief: input, fresh, clarify: true },
          ),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => null);
          const detail = Array.isArray(body?.detail) ? body.detail.join("; ") : body?.detail;
          throw new Error(apiErrorMessage(body?.error, res.status, detail, "run"));
        }
        await consume(res, latest.current);
      } catch (err) {
        fail(controller, err);
      }
    },
    [consume, fail, show],
  );

  /**
   * Answer the open question(s). The user's words appear at once as their message; the card and
   * composer are disabled until the server replies, so an answer can't be sent twice.
   */
  const answer = useCallback(
    async (answers: AnswerInput[], receipt: string) => {
      const v = latest.current;
      if (v.phase !== "awaiting" || v.clarify.sending || !v.clarify.sessionId) return;
      const controller = new AbortController();
      abort.current = controller;
      const userItem: ClarifyItem = { kind: "user", id: `u${Date.now()}`, text: receipt };
      const sending: View = {
        ...v,
        error: null,
        clarify: {
          ...v.clarify,
          sending: true,
          recovery: null,
          items: [...v.clarify.items, userItem],
        },
      };
      show(sending);
      try {
        const res = await fetch("/api/crashtest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clarification: { sessionId: v.clarify.sessionId, answers },
            fresh: lastInput.current?.fresh ?? false,
          }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          // Keep the conversation; take back the unsent answer and offer the one action that helps.
          const recovery = recoveryFor(res.status);
          show({
            ...v,
            clarify: {
              ...v.clarify,
              sending: false,
              recovery,
              active: recovery.action === "retry" ? v.clarify.active : null,
            },
          });
          return;
        }
        await consume(res, sending);
      } catch (err) {
        fail(controller, err);
      }
    },
    [consume, fail, show],
  );

  /** Start the same brief again (after an expired or already-answered question), keeping nothing stale. */
  const restart = useCallback(() => {
    if (lastInput.current) void run(lastInput.current.input, lastInput.current.fresh);
  }, [run]);

  /** Dismiss a recoverable refusal so the same question can be answered again. */
  const retry = useCallback(() => {
    const v = latest.current;
    show({ ...v, clarify: { ...v.clarify, recovery: null } });
  }, [show]);

  /** Closing the stream aborts the request; the server stops the run at its next step. */
  const cancel = useCallback(() => abort.current?.abort(), []);
  const reset = useCallback(() => {
    abort.current?.abort();
    show(initial);
  }, [show]);

  /** Show a finished run again (a saved chat), without running anything. */
  const restore = useCallback(
    (result: RunState | null, items: ClarifyItem[] = []) => {
      abort.current?.abort();
      const clarify = { ...emptyClarify, items };
      show(
        result
          ? {
              ...initial,
              phase: "done",
              result,
              plan: result.plan,
              initialPlan: result.initialPlan,
              evidence: result.evidenceLedger,
              clarify,
            }
          : { ...initial, clarify },
      );
    },
    [show],
  );

  return { view, run, answer, restart, retry, cancel, reset, restore };
}
