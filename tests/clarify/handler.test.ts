import { afterEach, describe, expect, it } from "vitest";
import { createMemoryCache } from "@/lib/cache/cache";
import type { ClarifyEvent } from "@/lib/clarify/session";
import { parallelView } from "@/lib/crashtest/parallel-view";
import type { RunEvent, RunState } from "@/lib/crashtest/types";
import { handleCrashTest } from "@/lib/server/handlers";
import { LONDON_BRIEF, worldClient, worldLlm } from "../crashtest/world";

type Event = RunEvent | ClarifyEvent;
const post = (body: unknown) => new Request("http://test/api/crashtest", { method: "POST", body: JSON.stringify(body) });
async function events(res: Response): Promise<Event[]> {
  expect(res.ok, `HTTP ${res.status}`).toBe(true);
  return (await res.text())
    .split("\n\n")
    .filter((b) => b.includes("data: "))
    .map((b) => JSON.parse(b.slice(b.indexOf("data: ") + 6)));
}
const first = <T extends Event["type"]>(es: Event[], type: T) => es.find((e): e is Extract<Event, { type: T }> => e.type === type);
const done = (es: Event[]) => first(es, "done")!.state as RunState;

/** World dependencies that count live runs (the LLM-only draft runs once per live run). */
function world(over: Parameters<typeof worldLlm>[0] = {}) {
  const counter = { liveRuns: 0 };
  const deps = () => {
    const fake = worldLlm(over);
    const llm = { ...fake.llm, generateText: (r: Parameters<typeof fake.llm.generateText>[0]) => (r.system.startsWith("You are a brand strategist") && counter.liveRuns++, fake.llm.generateText(r)) };
    return { qloo: worldClient().client, llm };
  };
  return { deps, counter };
}

const AMBIGUOUS = { ...LONDON_BRIEF, sourceText: "A pop-up in Shoreditch with live screen printing." };

describe("clarification through the run endpoint", () => {
  afterEach(() => {
    delete process.env.RECOMMENDATION_ARCHITECTURE;
  });

  it("is off unless asked for: today's runs are unchanged", async () => {
    const w = world();
    const es = await events(await handleCrashTest(post({ brief: AMBIGUOUS }), w.deps, () => createMemoryCache(10, new Map())));
    expect(es.some((e) => e.type === "clarification_required" || e.type === "ready")).toBe(false);
    expect(es.at(-1)?.type).toBe("done");
  });

  it("runs a clear brief straight through: ready, run_started, the run, done", async () => {
    process.env.RECOMMENDATION_ARCHITECTURE = "parallel";
    const w = world();
    const brief = { ...LONDON_BRIEF, sourceText: "We've booked Yard Market for a pop-up around Shoreditch.", existingChoices: [{ slot: "event_place", name: "Yard Market" }] };
    const es = await events(await handleCrashTest(post({ brief, clarify: true }), w.deps, () => createMemoryCache(10, new Map())));
    expect(es.some((e) => e.type === "clarification_required")).toBe(false);
    const types = es.map((e) => e.type);
    expect(types.indexOf("ready")).toBeLessThan(types.indexOf("run_started"));
    expect(types.at(-1)).toBe("done");
    const ready = first(es, "ready")!;
    const state = done(es);
    // U, L and A all receive the same clarified brief, with the fingerprint the session froze.
    expect(state.parallel!.candidates.every((c) => c.briefFingerprint === ready.fingerprint)).toBe(true);
    expect(state.parallel!.briefFingerprint).toBe(ready.fingerprint);
    expect(state.clarification).toMatchObject({ sessionId: ready.sessionId, fingerprint: ready.fingerprint, fingerprintMatches: true });
    // "Booked" reached the run as a machine-checked lock.
    expect(state.brief.constraints.find((c) => c.lockSlot === "event_place")?.description).toBe("Keep the pop-up venue: Yard Market");
    expect(state.parallel!.verdict.userChoicesPreserved).toEqual([{ slot: "event_place", label: "Yard Market", locked: true, preserved: true }]);
    expect(w.counter.liveRuns).toBe(1);
  });

  it("asks, stops the stream, then continues into the run from the answer", async () => {
    const w = world();
    const cache = createMemoryCache(10, new Map());
    const asked = await events(await handleCrashTest(post({ brief: AMBIGUOUS, clarify: true }), w.deps, () => cache));
    expect(asked.map((e) => e.type)).toEqual(["assistant_message", "clarification_required"]);
    expect(w.counter.liveRuns).toBe(0);
    const req = first(asked, "clarification_required")!;
    const q = req.questions[0];

    const answer = { clarification: { sessionId: req.session.sessionId, answers: [{ questionId: q.id, selectedOptionIds: [q.options[0].id] }] } };
    const ran = await events(await handleCrashTest(post(answer), w.deps, () => cache));
    expect(ran.slice(0, 3).map((e) => e.type)).toEqual(["clarification_applied", "ready", "run_started"]);
    expect(ran.at(-1)?.type).toBe("done");
    expect(done(ran).brief.constraints.map((c) => c.description)).toContain("The venue must be in Shoreditch");
    expect(done(ran).assumptions.some((a) => a.startsWith("Clarification:"))).toBe(false);
    expect(w.counter.liveRuns).toBe(1);

    // The same submission again starts no second run: the stored events, then the recording.
    const again = await events(await handleCrashTest(post(answer), w.deps, () => cache));
    expect(again.slice(0, 2).map((e) => e.type)).toEqual(["clarification_applied", "ready"]);
    expect(again.some((e) => e.type === "run_started")).toBe(false);
    expect(w.counter.liveRuns).toBe(1);
    // A different answer to a finished session is refused.
    const other = { clarification: { sessionId: req.session.sessionId, answers: [{ questionId: q.id, selectedOptionIds: [q.options[1].id] }] } };
    expect((await handleCrashTest(post(other), w.deps, () => cache)).status).toBe(409);
  }, 15_000);

  it("accepts a typed chat message as the answer", async () => {
    const w = world();
    const cache = createMemoryCache(10, new Map());
    const req = first(await events(await handleCrashTest(post({ brief: AMBIGUOUS, clarify: true }), w.deps, () => cache)), "clarification_required")!;
    const ran = await events(await handleCrashTest(post({ clarification: { sessionId: req.session.sessionId, answers: [{ message: "I don't know, decide for me" }] } }), w.deps, () => cache));
    expect(first(ran, "clarification_applied")!.acknowledgement).toMatch(/^I'll decide:/);
    expect(done(ran).assumptions).toContain("Clarification: Shoreditch is treated as preferred, not mandatory; a venue elsewhere is flagged if it wins.");
  });

  it("rejects unknown sessions, unknown questions and options, and malformed requests", async () => {
    const w = world();
    const cache = createMemoryCache(10, new Map());
    const req = first(await events(await handleCrashTest(post({ brief: AMBIGUOUS, clarify: true }), w.deps, () => cache)), "clarification_required")!;
    const id = req.session.sessionId;
    const status = async (body: unknown) => (await handleCrashTest(post(body), w.deps, () => cache)).status;
    expect(await status({ clarification: { sessionId: "6f1c1f33-1111-4111-8111-111111111111", answers: [{ delegated: true }] } })).toBe(404);
    expect(await status({ clarification: { sessionId: "not-a-uuid", answers: [{ delegated: true }] } })).toBe(400);
    expect(await status({ clarification: { sessionId: id, answers: [{ questionId: "nope", delegated: true }] } })).toBe(400);
    expect(await status({ clarification: { sessionId: id, answers: [{ questionId: req.questions[0].id, selectedOptionIds: ["nope"] }] } })).toBe(400);
    expect(await status({ clarification: { sessionId: id, answers: [] } })).toBe(400);
    expect(w.counter.liveRuns).toBe(0);
  });

  it("marks the result provisional when a material item stays open, with the check at the top", async () => {
    process.env.RECOMMENDATION_ARCHITECTURE = "parallel";
    const w = world({ choiceCountry: "India" });
    const cache = createMemoryCache(10, new Map());
    const brief = { ...LONDON_BRIEF, sourceText: "A pop-up with a performance we're hoping to arrange with Big Tex.", existingChoices: [{ slot: "artist_music", name: "Big Tex" }] };
    const req = first(await events(await handleCrashTest(post({ brief, clarify: true }), w.deps, () => cache)), "clarification_required")!;
    expect(req.questions[0].reason).toBe("entity_identity");
    const ran = await events(await handleCrashTest(post({ clarification: { sessionId: req.session.sessionId, answers: [{ questionId: req.questions[0].id, delegated: true }] } }), w.deps, () => cache));
    const state = done(ran);
    expect(first(ran, "ready")!.provisional.join(" ")).toMatch(/Big Tex/);
    expect(state.parallel!.verdict).toMatchObject({ provisional: true });
    expect(state.parallel!.verdict.humanChecks[0]).toMatch(/Big Tex stays unresolved/);
    const view = parallelView(state)!;
    expect(view.summary).toMatchObject({ headline: "Provisional plan" });
    expect(view.summary.stability).toMatch(/^Provisional: Big Tex stays unresolved/);
  });

  it("reports a refused live run as an error event once the stream has begun", async () => {
    const w = world();
    const brief = { ...LONDON_BRIEF, sourceText: "We've booked Yard Market for a pop-up around Shoreditch.", existingChoices: [{ slot: "event_place", name: "Yard Market" }] };
    const refuse = async () => new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 });
    const es = await events(await handleCrashTest(post({ brief, clarify: true }), w.deps, () => createMemoryCache(10, new Map()), refuse));
    expect(es.map((e) => e.type)).toEqual(["assistant_message", "ready", "run_started", "error"]);
    expect(first(es, "error")!.message).toMatch(/rate-limited/);
    expect(w.counter.liveRuns).toBe(0);
  });
});
