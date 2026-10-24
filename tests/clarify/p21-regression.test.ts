import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryCache } from "@/lib/cache/cache";
import { runGate } from "@/lib/clarify/gate";
import type { ClarifyEvent } from "@/lib/clarify/session";
import { buildJudgeGraph, visibleGraph, type JudgeGraph } from "@/lib/crashtest/judge-graph";
import { chooseLabelSpot } from "@/lib/crashtest/judge-labels";
import { FIT_PADDING, MIN_GUTTER, fitCamera, labelBox, layoutGraph, type FitNode } from "@/lib/crashtest/judge-layout";
import { runCrashTest } from "@/lib/crashtest/run";
import { LaunchBriefSchema, SLOTS, type RunEvent, type RunState, type Slot } from "@/lib/crashtest/types";
import { applyIntake } from "@/lib/intake/state";
import type { LlmClient } from "@/lib/llm/types";
import { marketById } from "@/lib/markets";
import { handleCrashTest } from "@/lib/server/handlers";
import { MORROW, MORROW_BRIEF, P21_FIXTURES, type P21Fixture } from "../../eval/clarification-fixtures-p21";
import { LONDON_BRIEF, worldClient, worldLlm } from "../crashtest/world";

/**
 * P2.1 regression tests, frozen before the implementation changed: clarification is rare,
 * ordinary named choices are preferred, a complete brief runs without a second confirmation,
 * and the decision graph frames every rendered node and label.
 */

const FROZEN = "frozen before the P2.1 implementation";

const model = (proposals: P21Fixture["proposals"]): LlmClient => ({
  provider: "fake",
  model: "fake",
  async generateText({ system }) {
    if (!system.startsWith("You review a product-launch brief")) throw new Error(`unexpected call: ${system.slice(0, 40)}`);
    return { text: JSON.stringify({ proposals }), usage: null, model: "fake", ms: 1 };
  },
});

describe("P2.1: the frozen fixtures", () => {
  it("are recorded", () => {
    const fp = createHash("sha256").update(JSON.stringify(P21_FIXTURES)).digest("hex").slice(0, 16);
    expect(fp).toBe(P21_FINGERPRINT);
    expect(P21_FIXTURES.find((f) => f.id === "morrow-full-brief")!.brief.sourceText).toBe(MORROW);
    void FROZEN;
  });

  for (const f of P21_FIXTURES)
    it(`${f.id}: ${f.note}`, async () => {
      const r = await runGate({ brief: LaunchBriefSchema.parse(f.brief), market: marketById(f.brief.marketId)!, identities: f.identities, llm: model(f.proposals) });
      expect(r.questions.map((q) => q.prompt), "questions asked").toHaveLength(f.expect.questions);
      expect(r.decision).toBe(f.expect.questions ? "clarify" : "ready");
      for (const q of r.questions) expect(f.expect.reasons).toContain(q.reason);
      const patches = r.resolutions.flatMap((x) => x.patches);
      for (const want of f.expect.resolutions ?? []) expect(patches).toContainEqual(want);
      for (const no of f.expect.notStrength ?? []) expect(patches.some((x) => x.kind === "choice_strength" && x.name === no.name && x.strength === no.strength), `${no.name} must not be ${no.strength}`).toBe(false);
    });
});

// ---------- the same brief to U, L and A ----------

type Event = RunEvent | ClarifyEvent;
const post = (body: unknown) => new Request("http://test/api/crashtest", { method: "POST", body: JSON.stringify(body) });
async function events(res: Response): Promise<Event[]> {
  expect(res.ok).toBe(true);
  return (await res.text())
    .split("\n\n")
    .filter((b) => b.includes("data: "))
    .map((b) => JSON.parse(b.slice(b.indexOf("data: ") + 6)));
}

describe("P2.1: Morrow reaches U, L and A with four preferred choices", () => {
  afterEach(() => {
    delete process.env.RECOMMENDATION_ARCHITECTURE;
  });

  it("runs immediately, with no lock, and every track receives the same brief", async () => {
    process.env.RECOMMENDATION_ARCHITECTURE = "parallel";
    // The live model proposes the two questions it once asked; neither may reach the user.
    const fixture = P21_FIXTURES.find((f) => f.id === "morrow-full-brief")!;
    const deps = () => ({ qloo: worldClient().client, llm: worldLlm({ clarify: { proposals: fixture.proposals } }).llm });
    const es = await events(await handleCrashTest(post({ brief: MORROW_BRIEF, clarify: true }), deps, () => createMemoryCache(10, new Map())));
    expect(es.some((e) => e.type === "clarification_required")).toBe(false);
    const ready = es.find((e): e is Extract<Event, { type: "ready" }> => e.type === "ready")!;
    const state = (es.find((e) => e.type === "done") as Extract<Event, { type: "done" }>).state as RunState;
    expect(state.brief.constraints.some((c) => c.lockSlot)).toBe(false);
    const user = state.parallel!.candidates.find((c) => c.candidateId === "user")!;
    expect(user.plan.components.map((c) => [c.label, c.locked])).toEqual(
      expect.arrayContaining([
        ["Village Underground", false],
        ["Central Cee", false],
        ["Burberry", false],
        ["polished black-and-chrome gallery-style", false],
      ]),
    );
    expect(state.parallel!.candidates.every((c) => c.briefFingerprint === ready.fingerprint)).toBe(true);
    // The intent contract every screen reads sees them as preferred, not locked.
    expect(state.clarification?.fingerprintMatches).toBe(true);
  });

  it("reports unknown capacity as a result-time check, not an intake question", async () => {
    process.env.RECOMMENDATION_ARCHITECTURE = "parallel";
    const brief = { ...LONDON_BRIEF, sourceText: "Our plan is a pop-up at Yard Market. We haven't confirmed capacity or availability yet.", existingChoices: [{ slot: "event_place", name: "Yard Market" }] };
    const es = await events(await handleCrashTest(post({ brief, clarify: true }), () => ({ qloo: worldClient().client, llm: worldLlm().llm }), () => createMemoryCache(10, new Map())));
    expect(es.some((e) => e.type === "clarification_required")).toBe(false);
    const state = (es.find((e) => e.type === "done") as Extract<Event, { type: "done" }>).state as RunState;
    expect(state.parallel!.verdict.humanChecks.join(" ")).toMatch(/capacity/i);
  });
});

// ---------- one confirmation, not two ----------

describe("P2.1: a complete brief runs without a second confirmation", () => {
  const none = { brandName: "", productCategory: "", launchGoal: "", cityText: "", audienceDescription: "", audienceAnchors: [], brandAttributes: [], budgetBand: "", website: "", choices: [], exclude: [], otherRules: [] };
  const llm: LlmClient = {
    provider: "fake",
    model: "fake",
    async generateText({ system }) {
      if (!system.startsWith("You read one message")) throw new Error(`unexpected: ${system.slice(0, 30)}`);
      return {
        text: JSON.stringify({
          ...none,
          brandName: "Morrow",
          productCategory: "Sustainable streetwear",
          launchGoal: "One-night pop-up",
          cityText: "London",
          audienceDescription: "Design students, young creatives and independent-fashion shoppers",
          brandAttributes: ["understated", "experimental", "community-led"],
          choices: [
            { slot: "event_place", name: "Village Underground", locked: false },
            { slot: "artist_music", name: "Central Cee", locked: false },
            { slot: "brand_collaboration", name: "Burberry", locked: false },
            { slot: "creative_direction", name: "polished black-and-chrome gallery-style", locked: false },
          ],
        }),
        usage: null,
        model: "fake",
        ms: 1,
      };
    },
  };

  it("summarises the brief, says it has enough, and starts the run", async () => {
    const r = await applyIntake(llm, { action: "message", message: MORROW, marketId: "london" });
    expect(r.startRequested).toBe(true);
    expect(r.state.readyToRun).toBe(true);
    const last = [...r.state.messages].reverse().find((m) => m.role === "assistant")!.text;
    expect(last).toMatch(/Village Underground/);
    expect(last).toMatch(/I have enough to test the plan\./);
    expect(last).not.toMatch(/Confirm the brief|Brief locked|Generate recommendations/);
    expect(r.state.chips.some((c) => c.action === "confirm")).toBe(false);
    // The server accepts this intake as it stands.
    const res = await handleCrashTest(post({ intake: r.state, depth: "quick", clarify: true }), () => ({ qloo: worldClient().client, llm: worldLlm().llm }), () => createMemoryCache(10, new Map()));
    expect(res.status).toBe(200);
    await res.text();
  });
});

// ---------- the decision graph frames everything it renders ----------

/** Project a world point for a straight-on camera at target + (0, 0, distance). */
function project(p: [number, number, number], target: [number, number, number], distance: number, fovDeg: number, width: number, height: number) {
  const t = Math.tan(((fovDeg / 2) * Math.PI) / 180);
  const depth = distance - (p[2] - target[2]);
  const k = height / 2 / (depth * t);
  return { x: width / 2 + (p[0] - target[0]) * k, y: height / 2 - (p[1] - target[1]) * k, k };
}

const VIEWPORTS = { desktop: { width: 878, height: 478 }, mobile: { width: 341, height: 378 } };
const FOV = 38;

async function morrowGraph(long: boolean): Promise<JudgeGraph> {
  const state = await runCrashTest({ qloo: worldClient().client, llm: worldLlm().llm }, { ...LONDON_BRIEF, existingChoices: [{ slot: "event_place", name: "Yard Market" }] });
  const g = buildJudgeGraph(state);
  if (!long) return g;
  // The longest real labels: venue, act, collaboration and direction names.
  const longName: Record<Slot, string> = {
    event_place: "Village Underground Shoreditch Warehouse",
    artist_music: "Central Cee with a surprise guest set",
    brand_collaboration: "Burberry heritage outerwear collaboration",
    creative_direction: "polished black-and-chrome gallery-style creative direction",
  };
  return { ...g, nodes: g.nodes.map((n) => (n.slot && n.kind !== "plan" ? { ...n, label: longName[n.slot] } : n)) };
}

describe("P2.1: graph framing", () => {
  for (const long of [false, true])
    for (const focus of [null, ...SLOTS] as (Slot | null)[])
      for (const [name, vp] of Object.entries(VIEWPORTS))
        it(`fits every rendered node and label: ${focus ?? "overview"}, ${name}${long ? ", long labels" : ""}`, async () => {
          const g = await morrowGraph(long);
          const layout = layoutGraph(g, focus);
          const rendered = visibleGraph(g, focus ?? undefined).nodes.filter((n) => layout.positions[n.id]);
          // Every rendered node is fitted, not only the active path.
          expect(new Set(layout.fit.map((f) => f.id))).toEqual(new Set(rendered.map((n) => n.id)));
          const cam = fitCamera(layout.fit, vp, FOV);
          const padX = Math.max(vp.width * FIT_PADDING, MIN_GUTTER);
          const padY = Math.max(vp.height * FIT_PADDING, MIN_GUTTER);
          const within = (x0: number, y0: number, x1: number, y1: number) => x0 >= padX - 0.5 && y0 >= padY - 0.5 && x1 <= vp.width - padX + 0.5 && y1 <= vp.height - padY + 0.5;
          for (const f of layout.fit as FitNode[]) {
            const c = project(f.p, cam.target, cam.distance, FOV, vp.width, vp.height);
            const r = f.r * c.k;
            expect(within(c.x - r, c.y - r, c.x + r, c.y + r), `${f.id} circle`).toBe(true);
            const box = labelBox(f.label);
            expect(box.w).toBeLessThanOrEqual(150);
            // The label fits on its side: left or right of the node, or below or above it.
            const gap = r + 6;
            const fits =
              f.side === "left"
                ? within(c.x - gap - box.w, c.y - box.h / 2, c.x - gap, c.y + box.h / 2)
                : f.side === "right"
                  ? within(c.x + gap, c.y - box.h / 2, c.x + gap + box.w, c.y + box.h / 2)
                  : within(c.x - box.w / 2, c.y + gap, c.x + box.w / 2, c.y + gap + box.h) || within(c.x - box.w / 2, c.y - gap - box.h, c.x + box.w / 2, c.y - gap);
            expect(fits, `${f.id} label "${f.label}"`).toBe(true);
          }
        });

  it("frames the plan and the receded decisions in a focused view", async () => {
    const g = await morrowGraph(true);
    const layout = layoutGraph(g, "event_place");
    for (const id of ["plan", "brief", "artist_music:final", "brand_collaboration:final", "creative_direction:final"]) expect(layout.fit.map((f) => f.id)).toContain(id);
  });

  it("wraps a long label to two lines within a fixed width, never wider", () => {
    const short = labelBox("Yard Market");
    const long = labelBox("polished black-and-chrome gallery-style creative direction");
    expect(short.lines).toBe(1);
    expect(long.lines).toBe(2);
    expect(long.w).toBeLessThanOrEqual(150);
  });

  it("moves a node label inward instead of hiding it; only edge labels may be hidden", () => {
    const view = { width: 400, height: 300, pad: 8 };
    // Every candidate spot is off the right edge.
    const spots = [{ x: 380, y: 100, w: 90, h: 28 }, { x: 390, y: 140, w: 90, h: 28 }];
    const node = chooseLabelSpot({ spots, placed: [], node: true, ...view });
    expect(node).not.toBeNull();
    expect(node!.x + node!.w).toBeLessThanOrEqual(view.width - view.pad);
    expect(node!.x).toBeGreaterThanOrEqual(view.pad);
    expect(chooseLabelSpot({ spots, placed: [], node: false, ...view })).toBeNull();
    // A clean spot inside is still preferred.
    expect(chooseLabelSpot({ spots: [...spots, { x: 100, y: 100, w: 90, h: 28 }], placed: [], node: true, ...view })).toEqual({ x: 100, y: 100, w: 90, h: 28 });
  });
});

/** The P2.1 fixtures' fingerprint as frozen (draft, before human review). */
const P21_FINGERPRINT = "595a00bc12b72ebf";
