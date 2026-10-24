import { describe, expect, it } from "vitest";
import { buildJudgeGraph, type JudgeGraph } from "@/lib/crashtest/judge-graph";
import { chooseLabelSpot, overlaps, type Rect } from "@/lib/crashtest/judge-labels";
import { FIT_PADDING, MIN_GUTTER, fitCamera, labelBox, layoutGraph } from "@/lib/crashtest/judge-layout";
import { runCrashTest } from "@/lib/crashtest/run";
import { SLOTS, type Slot } from "@/lib/crashtest/types";
import { LONDON_BRIEF, worldClient, worldLlm } from "./world";

/**
 * Label placement on the fitted camera, simulated the way the scene places labels: each node's
 * label tries below and above, nudged sideways, beside the node, then a label-height further out,
 * in priority order, never over another label or a node. Desktop uses the wide layout; a phone the
 * narrow one. With the longest real names, no label may overlap another or sit outside the canvas.
 */

const FOV = 38;
const VIEWS = { desktop: { width: 815, height: 479, narrow: false }, mobile: { width: 334, height: 539, narrow: true } };

async function longGraph(): Promise<JudgeGraph> {
  const state = await runCrashTest({ qloo: worldClient().client, llm: worldLlm().llm }, { ...LONDON_BRIEF, existingChoices: [{ slot: "event_place", name: "Yard Market" }] });
  const g = buildJudgeGraph(state);
  const longName: Record<Slot, string> = {
    event_place: "Village Underground",
    artist_music: "Central Cee",
    brand_collaboration: "Burberry",
    creative_direction: "polished black-and-chrome gallery-style",
  };
  return { ...g, nodes: g.nodes.map((n) => (n.slot && (n.kind === "final_choice" || n.kind === "llm_choice" || n.kind === "brief") ? { ...n, label: longName[n.slot] } : n)) };
}

function place(g: JudgeGraph, focus: Slot | null, view: { width: number; height: number; narrow: boolean }) {
  const layout = layoutGraph(g, focus, { narrow: view.narrow });
  const cam = fitCamera(layout.fit, view, FOV);
  const t = Math.tan(((FOV / 2) * Math.PI) / 180);
  const proj = (p: [number, number, number]) => {
    const k = view.height / 2 / ((cam.distance - (p[2] - cam.target[2])) * t);
    return { x: view.width / 2 + (p[0] - cam.target[0]) * k, y: view.height / 2 - (p[1] - cam.target[1]) * k, k };
  };
  const pad = Math.max(12, Math.min(view.width * FIT_PADDING, MIN_GUTTER));
  const discs = layout.fit.map((f) => {
    const c = proj(f.p);
    const r = f.r * c.k;
    return { id: f.id, x: c.x, y: c.y, r, rect: { x: c.x - r, y: c.y - r, w: 2 * r, h: 2 * r } };
  });
  const placed: Rect[] = discs.map((d) => d.rect);
  const labels: { id: string; rect: Rect }[] = [];
  // Priority as in the scene: the plan, final choices, the brief, then the rest.
  const kind = new Map(g.nodes.map((n) => [n.id, n.kind]));
  const prio = (id: string) => (kind.get(id) === "plan" ? 1 : kind.get(id) === "final_choice" ? 2 : id === "brief" ? 4 : 5);
  for (const f of [...layout.fit].sort((a, b) => prio(a.id) - prio(b.id))) {
    const d = discs.find((x) => x.id === f.id)!;
    const { w, h } = labelBox(f.label, f.kicker);
    const gap = d.r + 6;
    const above = { x: d.x - w / 2, y: d.y - gap - h, w, h };
    const below = { x: d.x - w / 2, y: d.y + gap, w, h };
    const spots: Rect[] = [];
    if (f.side === "left") spots.push({ x: d.x - gap - w - 2, y: d.y - h / 2, w, h }, above, below);
    else if (f.side === "right") spots.push({ x: d.x + gap + 2, y: d.y - h / 2, w, h }, above, below);
    else spots.push(...(d.y > view.height * 0.62 ? [above, below] : [below, above]));
    for (const s0 of [...spots]) spots.push({ ...s0, x: s0.x + w / 2 + 8 }, { ...s0, x: s0.x - w / 2 - 8 });
    spots.push({ x: d.x + gap + 2, y: d.y - h / 2, w, h }, { x: d.x - gap - w - 2, y: d.y - h / 2, w, h });
    for (const s0 of [below, above]) for (const dx of [0, w / 2 + 8, -(w / 2 + 8)]) spots.push({ ...s0, x: s0.x + dx, y: s0.y + (s0 === below ? h + 4 : -(h + 4)) });
    const spot = chooseLabelSpot({ spots, placed, node: true, width: view.width, height: view.height, pad })!;
    placed.push(spot);
    labels.push({ id: f.id, rect: spot });
  }
  const clashes: string[] = [];
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) if (overlaps(labels[i].rect, labels[j].rect)) clashes.push(`${labels[i].id} × ${labels[j].id}`);
    for (const d of discs) if (overlaps(labels[i].rect, d.rect)) clashes.push(`${labels[i].id} × node ${d.id}`);
  }
  const outside = labels.filter(({ rect: r }) => r.x < pad - 0.5 || r.y < pad - 0.5 || r.x + r.w > view.width - pad + 0.5 || r.y + r.h > view.height - pad + 0.5).map((l) => l.id);
  return { clashes, outside, labels: labels.length };
}

describe("graph labels on the fitted camera", () => {
  for (const [name, view] of Object.entries(VIEWS))
    for (const focus of [null, ...SLOTS] as (Slot | null)[])
      it(`never overlap and never leave the canvas: ${focus ?? "overview"}, ${name}`, async () => {
        const r = place(await longGraph(), focus, view);
        expect(r.labels).toBeGreaterThan(0);
        expect(r.outside, "labels outside").toEqual([]);
        expect(r.clashes, "overlapping labels").toEqual([]);
      });

  it("lays a narrow focused path top to bottom, with the other decisions in a column under the plan", async () => {
    const g = await longGraph();
    const l = layoutGraph(g, "event_place", { narrow: true });
    expect(l.narrow).toBe(true);
    expect(l.positions.brief[1]).toBeGreaterThan(l.positions["event_place:final"][1]);
    expect(l.positions["event_place:final"][1]).toBeGreaterThan(l.positions.plan[1]);
    const others = ["artist_music:final", "brand_collaboration:final", "creative_direction:final"].map((id) => l.positions[id]);
    for (const p of others) expect(p[1]).toBeLessThan(l.positions.plan[1]);
    expect(new Set(others.map((p) => p[0])).size).toBe(1);
  });
});
