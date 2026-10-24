import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  answerSession,
  SessionError,
  startSession,
  type ClarifyEvent,
  type Session,
} from "@/lib/clarify/session";
import { cacheKey, type Cache } from "@/lib/cache/cache";
import { runCrashTest, type RunOptions } from "@/lib/crashtest/run";
import {
  ADJUDICATION_VERSION,
  EVIDENCE_RUBRIC_VERSION,
  RUN_VERSION,
  rankingFrom,
  runVersionFor,
  type Architecture,
} from "@/lib/crashtest/version";
import { applyIntake } from "@/lib/intake/state";
import { IntakeRequestSchema, IntakeStateSchema } from "@/lib/intake/types";
import { MISSING_LABEL, refresh, toLaunchBrief } from "@/lib/intake/validate";
import { LaunchBriefSchema, type LaunchBriefInput, type RunEvent } from "@/lib/crashtest/types";
import type { LlmClient } from "@/lib/llm/types";
import { marketById } from "@/lib/markets";
import type { QlooClient } from "@/lib/qloo";
import { errorResponse, jsonError } from "./errors";
import { sseResponse } from "./sse";

export interface Deps {
  qloo: QlooClient;
  llm: LlmClient;
  /** Cache hits and outbound Qloo requests for this run, when the client measures them. */
  qlooStats?: { hits: number; requests: number };
}

const AnswerInputSchema = z.object({
  questionId: z.string().max(200).optional(),
  selectedOptionIds: z.array(z.string().max(200)).max(8).optional(),
  customText: z.string().trim().max(500).optional(),
  delegated: z.boolean().optional(),
  /** A normal chat message, read against the open question. */
  message: z.string().trim().max(2000).optional(),
});

export const CrashTestRequestSchema = z.union([
  z.object({
    brief: LaunchBriefSchema,
    /** Ignore a recorded run of the same brief and run live. */
    fresh: z.boolean().default(false),
    /** Run the clarification gate first (P1; the interface opts in). */
    clarify: z.boolean().default(false),
  }),
  z.object({
    /** A confirmed intake. Re-validated here: the client's readyToRun is never trusted. */
    intake: IntakeStateSchema,
    depth: z.enum(["quick", "thorough"]).default("thorough"),
    fresh: z.boolean().default(false),
    clarify: z.boolean().default(false),
  }),
  z.object({
    /** Answers to an open clarification session; on "ready" the same stream runs the comparison. */
    clarification: z.object({
      sessionId: z.string().uuid(),
      answers: z.array(AnswerInputSchema).min(1).max(3),
    }),
    fresh: z.boolean().default(false),
  }),
]);

/** Clarification sessions: non-secret structured state, kept server-side by id. */
const SESSION_TTL = 2 * 60 * 60;
const sessionKey = (id: string) => `clarify:session:${id}`;

export { RUN_VERSION };
const RECORDING_TTL = 14 * 24 * 60 * 60;

/** This standalone 2.0 app showcases the parallel engine; an env override can still run the control. */
function appArchitecture(): Architecture {
  return process.env.RECOMMENDATION_ARCHITECTURE === "sequential" ? "sequential" : "parallel";
}

export function runKey(brief: unknown): string {
  // A recording belongs to one agent version, one candidate ranking and one architecture; a
  // parallel recording also to its evidence-rubric and adjudication versions.
  const arch = appArchitecture();
  const version =
    arch === "parallel"
      ? `${runVersionFor(arch)}:${EVIDENCE_RUBRIC_VERSION}:${ADJUDICATION_VERSION}`
      : RUN_VERSION;
  return cacheKey(`${version}:${rankingFrom()}`, brief);
}

/** Turn a callback-style run into an async stream of events. */
export function eventStream<E extends { type: string }>(
  run: (emit: (e: E) => void) => Promise<unknown>,
  onError: (message: string) => E,
): AsyncIterable<E> {
  const queue: E[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  const push = (e: E) => {
    queue.push(e);
    wake?.();
  };
  run(push)
    .catch((err) => push(onError(err instanceof Error ? err.message : String(err))))
    .finally(() => {
      finished = true;
      wake?.();
    });
  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        if (finished) return;
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
    },
  };
}

interface Recording {
  recordedAt: string;
  events: RunEvent[];
}

/** Store a live run's events once it finishes without being cancelled. */
async function* record(events: AsyncIterable<RunEvent>, cache: Cache, key: string) {
  const seen: RunEvent[] = [];
  for await (const e of events) {
    seen.push(e);
    if (
      e.type === "done" &&
      e.state.stopReason !== "user_cancelled" &&
      e.state.stopReason !== "error"
    ) {
      await cache.set(
        key,
        { recordedAt: new Date().toISOString(), events: seen } satisfies Recording,
        RECORDING_TTL,
      );
    }
    yield e;
  }
}

/**
 * Replay a recording with short pauses so the console still reads as a sequence. It is
 * announced as recorded: Qloo results in it are as of the recording, not fresh.
 */
async function* replay(rec: Recording, pauseMs = 60) {
  yield {
    type: "stage",
    stage: "replay",
    message: `Replaying a recorded run from ${rec.recordedAt.slice(0, 10)}. Qloo results are as recorded then, not fetched now.`,
  } satisfies RunEvent;
  for (const e of rec.events) {
    if (e.type === "stage" || e.type === "change" || e.type === "evaluation")
      await new Promise((r) => setTimeout(r, pauseMs * 4));
    else if (e.type !== "done") await new Promise((r) => setTimeout(r, pauseMs / 4));
    // The finished state says it was replayed, so a saved copy stays labelled as recorded.
    yield e.type === "done"
      ? ({
          ...e,
          state: {
            ...e.state,
            provenance: {
              mode: "recorded",
              recordedAt: rec.recordedAt,
              runVersion: e.state.provenance?.runVersion ?? RUN_VERSION,
            },
          },
        } satisfies RunEvent)
      : e;
  }
}

export async function handleCrashTest(
  req: Request,
  deps: () => Deps,
  cache?: () => Cache,
  /** Called only before a live run (replays are free); return a Response to refuse it. */
  beforeLive?: () => Promise<Response | null>,
): Promise<Response> {
  let body: z.infer<typeof CrashTestRequestSchema>;
  try {
    body = CrashTestRequestSchema.parse(await req.json());
  } catch (err) {
    return errorResponse(err);
  }
  if ("clarification" in body) return handleClarificationAnswer(req, body, deps, cache, beforeLive);
  let input: LaunchBriefInput;
  if ("brief" in body) {
    input = body.brief;
  } else {
    const intake = refresh(body.intake);
    if (!intake.readyToRun) {
      return jsonError(
        400,
        "brief_not_confirmed",
        intake.missingCriticalFields.length
          ? intake.missingCriticalFields.map((f) => `Missing: ${MISSING_LABEL[f]}`)
          : ["Confirm the brief before starting."],
      );
    }
    input = LaunchBriefSchema.parse(toLaunchBrief(intake, body.depth));
  }
  if (!marketById(input.marketId)) return jsonError(400, "unsupported_city");
  if (body.clarify)
    return handleClarificationStart(req, input, body.fresh, deps, cache, beforeLive);
  const run = await runEvents(req, input, body.fresh, deps, cache, beforeLive);
  return run instanceof Response ? run : sseResponse(run, req.signal);
}

/** The existing run path (a recording replay, or a live run behind the limiter), as a stream. */
async function runEvents(
  req: Request,
  input: LaunchBriefInput,
  fresh: boolean,
  deps: () => Deps,
  cache?: () => Cache,
  beforeLive?: () => Promise<Response | null>,
  extra: { clarification?: RunOptions["clarification"]; runId?: string } = {},
): Promise<Response | AsyncIterable<RunEvent>> {
  const store = cache?.();
  const key = runKey(input);
  if (store && !fresh) {
    const recording = await store.get<Recording>(key);
    if (recording) return replay(recording);
  }
  const refused = await beforeLive?.();
  if (refused) return refused;
  let resolved: Deps;
  try {
    resolved = deps();
  } catch (err) {
    return errorResponse(err);
  }
  const architecture = appArchitecture();
  const live = eventStream<RunEvent>(
    (emit) =>
      runCrashTest(resolved, input, {
        architecture,
        emit,
        signal: req.signal,
        runVersion: runVersionFor(architecture),
        ...extra,
      }),
    (message) => ({ type: "error", message }),
  );
  return store ? record(live, store, key) : live;
}

type StreamEvent = RunEvent | ClarifyEvent;

/**
 * Clarification events, then, when the session is ready, the existing run in the same stream:
 * the client never has to start it. A refusal by the limiter becomes an error event here, since
 * the stream has already begun.
 */
async function* clarifyThenRun(
  req: Request,
  session: Session,
  events: ClarifyEvent[],
  store: Cache,
  fresh: boolean,
  deps: () => Deps,
  cache?: () => Cache,
  beforeLive?: () => Promise<Response | null>,
): AsyncGenerator<StreamEvent> {
  yield* events;
  if (session.state !== "ready" || !session.clarifiedBrief || !session.fingerprint) return;
  const runId = randomUUID();
  session.state = "running";
  await store.set(sessionKey(session.sessionId), session, SESSION_TTL);
  yield { type: "run_started", runId, sessionId: session.sessionId };
  const run = await runEvents(
    req,
    LaunchBriefSchema.parse(session.clarifiedBrief),
    fresh,
    deps,
    cache,
    beforeLive,
    {
      runId,
      clarification: {
        sessionId: session.sessionId,
        fingerprint: session.fingerprint,
        assumptions: session.assumptions,
        provisional: session.provisional,
      },
    },
  );
  if (run instanceof Response) {
    const body = await run.json().catch(() => null);
    session.state = "ready";
    await store.set(sessionKey(session.sessionId), session, SESSION_TTL);
    yield {
      type: "error",
      message:
        run.status === 429
          ? "Live runs are rate-limited on this demo. Try again in a few minutes."
          : (body?.error ?? `The run couldn't start (${run.status}).`),
    };
    return;
  }
  for await (const e of run) {
    if (e.type === "done") {
      session.state = "complete";
      await store.set(sessionKey(session.sessionId), session, SESSION_TTL);
    }
    yield e;
  }
}

async function handleClarificationStart(
  req: Request,
  input: LaunchBriefInput,
  fresh: boolean,
  deps: () => Deps,
  cache?: () => Cache,
  beforeLive?: () => Promise<Response | null>,
): Promise<Response> {
  const store = cache?.();
  if (!store)
    return jsonError(500, "clarification_unavailable", ["Clarification needs the session cache."]);
  let resolved: Deps;
  try {
    resolved = deps();
  } catch (err) {
    return errorResponse(err);
  }
  let started: Awaited<ReturnType<typeof startSession>>;
  try {
    started = await startSession(input, { llm: resolved.llm, qloo: resolved.qloo });
  } catch (err) {
    return err instanceof SessionError
      ? jsonError(400, err.code, [err.message])
      : errorResponse(err);
  }
  await store.set(sessionKey(started.session.sessionId), started.session, SESSION_TTL);
  // The same resolved clients serve the run, so one request's counts stay together.
  return sseResponse(
    clarifyThenRun(
      req,
      started.session,
      started.events,
      store,
      fresh,
      () => resolved,
      cache,
      beforeLive,
    ),
    req.signal,
  );
}

async function handleClarificationAnswer(
  req: Request,
  body: Extract<z.infer<typeof CrashTestRequestSchema>, { clarification: unknown }>,
  deps: () => Deps,
  cache?: () => Cache,
  beforeLive?: () => Promise<Response | null>,
): Promise<Response> {
  const store = cache?.();
  if (!store)
    return jsonError(500, "clarification_unavailable", ["Clarification needs the session cache."]);
  const session = await store.get<Session>(sessionKey(body.clarification.sessionId));
  if (!session)
    return jsonError(404, "unknown_session", [
      "This clarification session doesn't exist or has expired. Start the run again.",
    ]);
  let resolved: Deps;
  try {
    resolved = deps();
  } catch (err) {
    return errorResponse(err);
  }
  let out: Awaited<ReturnType<typeof answerSession>>;
  try {
    out = await answerSession(session, body.clarification.answers, {
      llm: resolved.llm,
      qloo: resolved.qloo,
    });
  } catch (err) {
    if (err instanceof SessionError)
      return jsonError(err.code === "invalid_state" ? 409 : 400, err.code, [err.message]);
    return errorResponse(err);
  }
  if (out.replayed && (session.state === "running" || session.state === "complete")) {
    // A repeated submission never starts a second run: the stored events, then the recording if there is one.
    const recording = session.clarifiedBrief
      ? await store.get<Recording>(runKey(LaunchBriefSchema.parse(session.clarifiedBrief)))
      : null;
    async function* again(): AsyncGenerator<StreamEvent> {
      yield* out.events;
      if (recording) yield* replay(recording);
      else
        yield {
          type: "assistant_message",
          text: "This run has already started; its result appears where it was started.",
        };
    }
    return sseResponse(again(), req.signal);
  }
  await store.set(sessionKey(session.sessionId), out.session, SESSION_TTL);
  return sseResponse(
    clarifyThenRun(
      req,
      out.session,
      out.events,
      store,
      body.fresh,
      () => resolved,
      cache,
      beforeLive,
    ),
    req.signal,
  );
}

/**
 * One intake turn. Never calls Qloo: only the model reads the message (or suggests audiences).
 * The state comes back from the client every turn and is re-validated before use.
 */
export async function handleIntake(
  req: Request,
  llm: () => LlmClient,
  beforeTurn?: () => Promise<Response | null>,
): Promise<Response> {
  let body: z.infer<typeof IntakeRequestSchema>;
  try {
    body = IntakeRequestSchema.parse(await req.json());
  } catch (err) {
    return errorResponse(err);
  }
  const refused = await beforeTurn?.();
  if (refused) return refused;
  try {
    return Response.json(await applyIntake(llm(), body));
  } catch (err) {
    return errorResponse(err);
  }
}
