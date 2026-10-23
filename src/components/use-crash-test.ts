"use client";

import { useCallback, useRef, useState } from "react";
import type { IntakeState } from "@/lib/intake/types";
import type {
  CulturalPlan,
  EvidenceRecord,
  LaunchBriefInput,
  PlanEvaluation,
  RunEvent,
  RunState,
} from "@/lib/crashtest/types";

/** One line of the agent console, in the order things happened. */
export type LogEntry =
  | { kind: "stage"; stage: string; message: string }
  | { kind: "action"; iteration: number; slot: string; why: string }
  | { kind: "change"; change: Extract<RunEvent, { type: "change" }>["change"] }
  | { kind: "evaluation"; evaluation: PlanEvaluation };

export interface View {
  phase: "idle" | "running" | "done" | "error";
  /** Set when the server replays a recorded run instead of running live. */
  replay: string | null;
  log: LogEntry[];
  evidence: EvidenceRecord[];
  initialPlan: CulturalPlan | null;
  plan: CulturalPlan | null;
  budget: { used: number; max: number } | null;
  result: RunState | null;
  error: string | null;
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
};

export function reduce(v: View, e: RunEvent): View {
  switch (e.type) {
    case "stage":
      if (e.stage === "replay") return { ...v, replay: e.message };
      return { ...v, log: [...v.log, { kind: "stage", stage: e.stage, message: e.message }] };
    case "evidence":
      return { ...v, evidence: [...v.evidence, e.record] };
    case "plan":
      return e.label === "initial" ? { ...v, initialPlan: e.plan, plan: e.plan } : { ...v, plan: e.plan };
    case "evaluation":
      return { ...v, log: [...v.log, { kind: "evaluation", evaluation: e.evaluation }] };
    case "action":
      return { ...v, log: [...v.log, { kind: "action", iteration: e.action.iteration, slot: e.action.slot, why: e.action.why }] };
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
      return { ...v, phase: "error", error: e.message };
    default:
      // Clarification events (P1) are rendered by the chat interface (P2); the run view ignores them.
      return v;
  }
}

/** Parse server-sent events from a fetch body (the endpoint is POST, so no EventSource). */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<RunEvent> {
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
      if (data) yield JSON.parse(data) as RunEvent;
    }
  }
}

export function useCrashTest() {
  const [view, setView] = useState<View>(initial);
  const abort = useRef<AbortController | null>(null);

  const run = useCallback(async (input: LaunchBriefInput | { intake: IntakeState; depth: "quick" | "thorough" }, fresh = false) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setView({ ...initial, phase: "running" });
    try {
      const res = await fetch("/api/crashtest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify("intake" in input ? { ...input, fresh } : { brief: input, fresh }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        const detail = Array.isArray(body?.detail) ? body.detail.join("; ") : body?.detail;
        throw new Error(
          res.status === 429
            ? "Live runs are rate-limited on this demo. Try an example brief (recorded runs are free) or wait a few minutes."
            : (detail ?? body?.error ?? `Request failed (${res.status})`),
        );
      }
      let current: View = { ...initial, phase: "running" };
      for await (const event of readSse(res.body)) {
        current = reduce(current, event);
        setView(current);
      }
      if (current.phase === "running") {
        setView({ ...current, phase: "error", error: "The connection closed before the run finished." });
      }
    } catch (err) {
      if (controller.signal.aborted) {
        setView((v) => ({ ...v, phase: v.result ? "done" : "error", error: v.result ? null : "Cancelled." }));
        return;
      }
      setView((v) => ({ ...v, phase: "error", error: err instanceof Error ? err.message : String(err) }));
    }
  }, []);

  /** Closing the stream aborts the request; the server stops the run at its next step. */
  const cancel = useCallback(() => abort.current?.abort(), []);
  const reset = useCallback(() => {
    abort.current?.abort();
    setView(initial);
  }, []);

  /** Show a finished run again (a saved chat), without running anything. */
  const restore = useCallback((result: RunState | null) => {
    abort.current?.abort();
    setView(
      result
        ? { ...initial, phase: "done", result, plan: result.plan, initialPlan: result.initialPlan, evidence: result.evidenceLedger }
        : initial,
    );
  }, []);

  return { view, run, cancel, reset, restore };
}
