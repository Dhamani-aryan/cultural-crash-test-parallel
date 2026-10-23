import { describe, expect, it } from "vitest";
import { createMemoryCache } from "@/lib/cache/cache";
import type { RunEvent, RunState } from "@/lib/crashtest/types";
import { runVersionFor } from "@/lib/crashtest/version";
import { eventStream, handleCrashTest, runKey, RUN_VERSION } from "@/lib/server/handlers";
import { LONDON_BRIEF, worldClient, worldLlm } from "../crashtest/world";

const post = (body: unknown) =>
  new Request("http://test/api/crashtest", { method: "POST", body: JSON.stringify(body) });

async function readEvents(res: Response): Promise<RunEvent[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((b) => b.includes("data: "))
    .map((b) => JSON.parse(b.slice(b.indexOf("data: ") + 6)));
}

const noDeps = () => {
  throw new Error("deps should not be needed");
};
const world = () => ({ qloo: worldClient().client, llm: worldLlm().llm });
/** A replay is paced in real time (a short pause per recorded event), so a test that replays a whole run needs longer than the default. */
const REPLAY_TIMEOUT = 15_000;

describe("handleCrashTest", () => {
  it("rejects invalid briefs and unsupported cities", async () => {
    expect((await handleCrashTest(post({ brief: { marketId: "london" } }), noDeps)).status).toBe(
      400,
    );
    const seoul = await handleCrashTest(
      post({ brief: { ...LONDON_BRIEF, marketId: "seoul" } }),
      noDeps,
    );
    expect(seoul.status).toBe(400);
  });

  it("streams a live run to its done event, then replays it labelled as recorded", async () => {
    const cache = createMemoryCache(10, new Map());
    const live = await readEvents(
      await handleCrashTest(post({ brief: LONDON_BRIEF }), world, () => cache),
    );
    expect(live.at(-1)?.type).toBe("done");
    expect(live.some((e) => e.type === "evidence")).toBe(true);

    const replayed = await readEvents(
      await handleCrashTest(post({ brief: LONDON_BRIEF }), noDeps, () => cache),
    );
    expect(replayed[0]).toMatchObject({ type: "stage", stage: "replay" });
    expect((replayed[0] as Extract<RunEvent, { type: "stage" }>).message).toMatch(/recorded/);
    expect(replayed.length).toBe(live.length + 1);
    // The finished state itself carries the label, so a saved copy stays recorded after a reload.
    const done = (e: RunEvent[]) => (e.at(-1) as Extract<RunEvent, { type: "done" }>).state;
    expect(done(live).provenance).toMatchObject({ mode: "live", runVersion: RUN_VERSION });
    expect(done(replayed).provenance).toMatchObject({ mode: "recorded", runVersion: RUN_VERSION });
    expect(done(replayed).provenance?.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const restored = JSON.parse(JSON.stringify(done(replayed))) as RunState;
    expect(restored.provenance?.mode).toBe("recorded");
  }, REPLAY_TIMEOUT);

  it("runs live when asked for a fresh run, even with a recording", async () => {
    const cache = createMemoryCache(10, new Map());
    const parsed = (await import("@/lib/crashtest/types")).LaunchBriefSchema.parse(LONDON_BRIEF);
    await cache.set(runKey(parsed), { recordedAt: "2026-10-01T00:00:00Z", events: [] }, 60);
    const events = await readEvents(
      await handleCrashTest(post({ brief: LONDON_BRIEF, fresh: true }), world, () => cache),
    );
    expect(events[0]).not.toMatchObject({ stage: "replay" });
    expect(events.at(-1)?.type).toBe("done");
  });

  it("runs a confirmed intake, and refuses an unconfirmed one", async () => {
    const { intakeFromBrief, refresh } = await import("@/lib/intake/validate");
    const draft = intakeFromBrief(LONDON_BRIEF, "London streetwear launch", "t1");
    const unconfirmed = await handleCrashTest(post({ intake: draft }), noDeps);
    expect(unconfirmed.status).toBe(400);
    const confirmed = refresh({
      ...draft,
      brief: { ...draft.brief, brandAttributes: ["understated"] },
      confirmed: true,
    });
    const events = await readEvents(await handleCrashTest(post({ intake: confirmed }), world));
    expect(events.at(-1)?.type).toBe("done");
  });

  it("23. keeps validation, the limiter and recording under the parallel architecture", async () => {
    process.env.RECOMMENDATION_ARCHITECTURE = "parallel";
    try {
      expect((await handleCrashTest(post({ brief: { marketId: "london" } }), noDeps)).status).toBe(400);
      const { intakeFromBrief } = await import("@/lib/intake/validate");
      expect((await handleCrashTest(post({ intake: intakeFromBrief(LONDON_BRIEF, "x", "t1") }), noDeps)).status).toBe(400);
      const refuse = async () => new Response("slow down", { status: 429 });
      expect((await handleCrashTest(post({ brief: LONDON_BRIEF }), noDeps, () => createMemoryCache(10, new Map()), refuse)).status).toBe(429);

      const cache = createMemoryCache(10, new Map());
      const live = await readEvents(await handleCrashTest(post({ brief: LONDON_BRIEF }), world, () => cache));
      const done = (e: RunEvent[]) => (e.at(-1) as Extract<RunEvent, { type: "done" }>).state;
      expect(done(live).architecture).toBe("parallel");
      expect(done(live).provenance).toMatchObject({ mode: "live", runVersion: runVersionFor("parallel") });
      const replayed = await readEvents(await handleCrashTest(post({ brief: LONDON_BRIEF }), noDeps, () => cache));
      expect(done(replayed).provenance).toMatchObject({ mode: "recorded", runVersion: runVersionFor("parallel") });
      expect(done(replayed).parallel?.verdict).toEqual(done(live).parallel?.verdict);
    } finally {
      delete process.env.RECOMMENDATION_ARCHITECTURE;
    }
  }, REPLAY_TIMEOUT);

  it("refuses a live run when the limiter says so, but never a replay", async () => {
    const refuse = async () => new Response("slow down", { status: 429 });
    const res = await handleCrashTest(
      post({ brief: LONDON_BRIEF }),
      noDeps,
      () => createMemoryCache(10, new Map()),
      refuse,
    );
    expect(res.status).toBe(429);
  });

  it("reports a model failure as a stopped run, not a crash", async () => {
    const deps = () => ({
      qloo: worldClient().client,
      llm: {
        provider: "fake",
        model: "fake",
        async generateText(): Promise<never> {
          throw new Error("model down");
        },
      },
    });
    const events = await readEvents(await handleCrashTest(post({ brief: LONDON_BRIEF }), deps));
    const done = events.at(-1) as Extract<RunEvent, { type: "done" }>;
    expect(done.type).toBe("done");
    expect(done.state.stopReason).toBe("error");
    expect(done.state.stopDetail).toMatch(/model down/);
  });
});

describe("eventStream", () => {
  it("yields events in order and ends when the run finishes", async () => {
    const out: string[] = [];
    const stream = eventStream<RunEvent>(
      async (emit) => {
        emit({ type: "stage", stage: "a", message: "" });
        await new Promise((r) => setTimeout(r, 5));
        emit({ type: "stage", stage: "b", message: "" });
      },
      (message) => ({ type: "error", message }),
    );
    for await (const e of stream) out.push((e as Extract<RunEvent, { type: "stage" }>).stage);
    expect(out).toEqual(["a", "b"]);
  });
});
