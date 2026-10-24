import { visibleGraph, type JudgeGraph, type JudgeGraphEdge, type JudgeGraphNode, type JudgeNodeKind } from "./judge-graph";
import type { Slot } from "./types";

/**
 * Where each graph node sits, and how each edge is routed, computed from the graph alone: same
 * run, same picture. The overview is a left-to-right flow: your brief, the four decisions in one
 * column, the final plan. A focused decision spreads its path into columns by replay step, while
 * the other decisions recede beside the plan. Edges are curves clipped at the visible edge of
 * each shape, and each takes the first deterministic lane that clears every unrelated node.
 *
 * The camera frames every rendered node and its label (fitCamera over `fit`), never only the
 * active path: in a focused view the brief, the plan and the receded decisions are drawn too.
 */

export type Vec3 = [number, number, number];

export interface RoutedEdge {
  edgeId: string;
  /** The route, already clipped to both shapes' boundaries. */
  points: Vec3[];
  sourceRadius: number;
  targetRadius: number;
  lane: number;
  /** Other clean routes, best first, for when a label sits on this one. */
  alternatives: Vec3[][];
}

/** One rendered node as the camera must frame it: its shape, and its label on the side it sits. */
export interface FitNode {
  id: string;
  p: Vec3;
  r: number;
  label: string;
  /** "below" also allows above (the scene picks whichever is clear); left and right are fixed. */
  side: "below" | "left" | "right";
  /** A small kind line above the label (the overview's decision names). */
  kicker: boolean;
}

export interface GraphLayout {
  positions: Record<string, Vec3>;
  /** Nodes on the path being looked at; everything else recedes. Emphasis only, never camera bounds. */
  active: Set<string>;
  /** Every rendered node with a position, for fitting the camera. */
  fit: FitNode[];
  /** Laid out for a narrow canvas: top to bottom, labels above or below every node. */
  narrow: boolean;
  routes: Record<string, RoutedEdge>;
}

/** Padding kept clear on every side of the canvas: a share of each dimension, and never less than a gutter. */
export const FIT_PADDING = 0.08;
export const MIN_GUTTER = 16;
/** A node label's box: a fixed maximum width, wrapping to two lines (see the scene's overlay). */
export const LABEL_MAX_W = 150;
const CHAR_W = 6.4;
const LINE_H = 14;
const KICKER_H = 12;
const LABEL_GAP = 6;

/** A conservative estimate of a rendered label's box, in pixels. */
export function labelBox(label: string, kicker = false): { w: number; h: number; lines: number } {
  const natural = Math.ceil(label.length * CHAR_W) + 6;
  const lines = natural > LABEL_MAX_W ? 2 : 1;
  return { w: Math.min(LABEL_MAX_W, natural), h: lines * LINE_H + (kicker ? KICKER_H : 0), lines };
}

/**
 * The camera for a straight-on view that frames every node circle and its label inside the canvas
 * with FIT_PADDING on all four sides. Solved in pixels (labels have a fixed pixel size), by a
 * binary search on distance, then centred: the target moves so the picture sits in the middle.
 */
export function fitCamera(fit: FitNode[], viewport: { width: number; height: number }, fovDeg: number): { target: Vec3; distance: number } {
  const { width, height } = viewport;
  if (!fit.length) return { target: [0, 0, 0], distance: 16 };
  const padX = Math.max(width * FIT_PADDING, MIN_GUTTER);
  const padY = Math.max(height * FIT_PADDING, MIN_GUTTER);
  const t = Math.tan((fovDeg / 2) * (Math.PI / 180));
  const cx0 = (Math.min(...fit.map((f) => f.p[0])) + Math.max(...fit.map((f) => f.p[0]))) / 2;
  const cy0 = (Math.min(...fit.map((f) => f.p[1])) + Math.max(...fit.map((f) => f.p[1]))) / 2;
  // The pixel extent of everything for a camera at distance d aimed at (cx0, cy0): screen-centre relative.
  const extent = (d: number) => {
    let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const f of fit) {
      const k = height / 2 / ((d - f.p[2]) * t);
      const x = (f.p[0] - cx0) * k;
      const y = -(f.p[1] - cy0) * k;
      const r = f.r * k;
      const box = labelBox(f.label, f.kicker);
      const gap = r + LABEL_GAP;
      let [l, rt, tp, bt] = [x - r, x + r, y - r, y + r];
      if (f.side === "left") [l, tp, bt] = [Math.min(l, x - gap - box.w), Math.min(tp, y - box.h / 2), Math.max(bt, y + box.h / 2)];
      else if (f.side === "right") [rt, tp, bt] = [Math.max(rt, x + gap + box.w), Math.min(tp, y - box.h / 2), Math.max(bt, y + box.h / 2)];
      else {
        [l, rt] = [Math.min(l, x - box.w / 2), Math.max(rt, x + box.w / 2)];
        // The label sits on the outward side: above for nodes above the middle, below otherwise.
        if (f.p[1] > cy0) tp = Math.min(tp, y - gap - box.h);
        else bt = Math.max(bt, y + gap + box.h);
      }
      [x0, x1, y0, y1] = [Math.min(x0, l), Math.max(x1, rt), Math.min(y0, tp), Math.max(y1, bt)];
    }
    return { x0, x1, y0, y1 };
  };
  const fits = (d: number) => {
    const e = extent(d);
    return e.x1 - e.x0 <= width - 2 * padX && e.y1 - e.y0 <= height - 2 * padY;
  };
  let [lo, hi] = [Math.max(...fit.map((f) => f.p[2])) + 0.5, 400];
  if (!fits(hi)) return { target: [cx0, cy0, 0], distance: hi };
  for (let i = 0; i < 48; i++) {
    const m = (lo + hi) / 2;
    if (fits(m)) hi = m;
    else lo = m;
  }
  const d = hi;
  // Centre the picture: shift the target by the pixel offset of the extent's middle.
  const e = extent(d);
  const k0 = height / 2 / (d * t);
  const dx = ((e.x0 + e.x1) / 2) / k0;
  const dy = -((e.y0 + e.y1) / 2) / k0;
  return { target: [cx0 + dx, cy0 + dy, 0], distance: d };
}

/** The visible radius of each shape, in world units (rings included). */
export const NODE_RADIUS: Record<JudgeNodeKind, number> = {
  plan: 0.56,
  final_choice: 0.4,
  brief: 0.28,
  llm_choice: 0.24,
  qloo_evidence: 0.27,
  candidate: 0.24,
  test: 0.3,
};

/** Between nodes in one focused column: room for a label under each (the focused view has height to spare). */
const SPACING = 2.2;
/** Clearance kept between a route and any unrelated node. */
const CLEAR = 0.18;
const LANE = 0.75;
const LANES = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6];
const SAMPLES = 24;

function column(nodes: JudgeGraphNode[], x: number, out: Record<string, Vec3>, shift = 0) {
  nodes.forEach((n, i) => {
    const y = ((nodes.length - 1) / 2 - i) * SPACING + (nodes.length > 1 ? shift : 0);
    // A shallow alternating depth gives parallax without changing the front-facing picture.
    out[n.id] = [x, y, i % 2 ? -0.15 : 0.15];
  });
}

const dist2 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** A quadratic curve from a to b whose control point is pushed sideways by `offset`. */
function curve(a: Vec3, b: Vec3, offset: number): Vec3[] {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len = Math.hypot(dx, dy) || 1;
  const [nx, ny] = [-dy / len, dx / len];
  const c: Vec3 = [(a[0] + b[0]) / 2 + nx * offset * 2, (a[1] + b[1]) / 2 + ny * offset * 2, (a[2] + b[2]) / 2];
  const out: Vec3[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1], u * u * a[2] + 2 * u * t * c[2] + t * t * b[2]]);
  }
  return out;
}

/** Cut a route where it leaves the source shape and where it enters the target shape. */
function clip(pts: Vec3[], a: Vec3, ra: number, b: Vec3, rb: number): Vec3[] {
  const outside = (p: Vec3) => dist2(p, a) >= ra && dist2(p, b) >= rb;
  const lerp = (p: Vec3, q: Vec3, t: number): Vec3 => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
  // Binary-search the exact crossing between an inside and an outside sample.
  const edge = (inside: Vec3, out: Vec3, centre: Vec3, r: number) => {
    let [lo, hi] = [0, 1];
    for (let k = 0; k < 12; k++) {
      const m = (lo + hi) / 2;
      if (dist2(lerp(inside, out, m), centre) < r) lo = m;
      else hi = m;
    }
    return lerp(inside, out, hi);
  };
  const first = pts.findIndex(outside);
  let last = -1;
  for (let i = pts.length - 1; i >= 0; i--) if (outside(pts[i])) {
    last = i;
    break;
  }
  if (first < 0 || last <= first) return [];
  const out = pts.slice(first, last + 1);
  if (first > 0) out.unshift(edge(pts[first - 1], pts[first], a, ra));
  if (last < pts.length - 1) out.push(edge(pts[last + 1], pts[last], b, rb));
  return out;
}

/** How many samples of a route come within an obstacle's padded radius. */
function hits(pts: Vec3[], obstacles: { c: Vec3; r: number }[]): number {
  let n = 0;
  for (const p of pts) for (const o of obstacles) if (dist2(p, o.c) < o.r) n++;
  return n;
}

function routeEdges(edges: JudgeGraphEdge[], nodes: JudgeGraphNode[], positions: Record<string, Vec3>): Record<string, RoutedEdge> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const routes: Record<string, RoutedEdge> = {};
  // Edges between the same pair of nodes never share a lane, so they never coincide.
  const pairLanes = new Map<string, Set<number>>();
  for (const e of edges) {
    const a = positions[e.source];
    const b = positions[e.target];
    const sa = byId.get(e.source);
    const sb = byId.get(e.target);
    if (!a || !b || !sa || !sb) continue;
    const pair = [e.source, e.target].sort().join("|");
    const used = pairLanes.get(pair) ?? new Set<number>();
    pairLanes.set(pair, used);
    // A reversed edge bends the other way for the same lane number, so compare by direction.
    const sign = e.source < e.target ? 1 : -1;
    const ra = NODE_RADIUS[sa.kind] + 0.04;
    const rb = NODE_RADIUS[sb.kind] + 0.04;
    const obstacles = nodes
      .filter((n) => n.id !== e.source && n.id !== e.target && positions[n.id])
      .map((n) => ({ c: positions[n.id], r: NODE_RADIUS[n.kind] + CLEAR }));
    const lanes = LANES.filter((l) => !used.has(l * sign));
    const tried = lanes.map((lane) => {
      const pts = clip(curve(a, b, lane * LANE), a, ra, b, rb);
      return { lane, pts, cost: hits(pts, obstacles) };
    });
    const clean = tried.filter((t) => t.cost === 0 && t.pts.length > 1);
    const best = clean[0] ?? [...tried].sort((x, y) => x.cost - y.cost)[0];
    used.add(best.lane * sign);
    routes[e.id] = {
      edgeId: e.id,
      points: best.pts,
      sourceRadius: ra,
      targetRadius: rb,
      lane: best.lane,
      alternatives: clean.filter((t) => t !== best).slice(0, 4).map((t) => t.pts),
    };
  }
  return routes;
}

/** Narrow canvases (phones): a focused path runs top to bottom, with each step's nodes side by side. */
const NARROW_ACROSS = (2.6 * 1.85) / SPACING;
const NARROW_DOWN = 1.3;

export function layoutGraph(g: JudgeGraph, focus?: Slot | null, opts: { narrow?: boolean } = {}): GraphLayout {
  const positions: Record<string, Vec3> = {};
  const { nodes, edges } = visibleGraph(g, focus ?? undefined);
  const finals = g.decisions.map((d) => g.nodes.find((n) => n.id === `${d.slot}:final`)!).filter(Boolean);
  let active: Set<string>;

  if (!focus) {
    // Left to right: your brief, the four decisions in one column, the final plan.
    positions.brief = [-5.2, 0, 0];
    positions.plan = [5.2, 0, 0];
    finals.forEach((n, i) => {
      positions[n.id] = [0, ((finals.length - 1) / 2 - i) * 1.9, i % 2 ? -0.1 : 0.1];
    });
    active = new Set(nodes.map((n) => n.id));
  } else {
    const own = nodes.filter((n) => n.slot === focus && n.kind !== "final_choice");
    // Columns by replay step; the user's choice and rules share the first.
    const cols = [1, 2, 3, 4, 5].map((step) => own.filter((n) => n.step === step));
    // Alternate many-node columns sit half a row lower, so neighbouring labels never line up.
    cols.forEach((c, i) => column(c, -6.4 + i * 2.8, positions, i % 2 ? -SPACING / 2 : 0));
    positions[`${focus}:final`] = [7.8, 0, 0];
    positions.brief = [-9.4, 0, -0.3];
    positions.plan = [10.6, 0, -0.3];
    // The other decisions wait, quieter, in their own column just past the plan they belong to,
    // spaced so each keeps a readable label clear of the plan and of each other.
    finals
      .filter((n) => n.slot !== focus)
      .forEach((n, i, all) => {
        positions[n.id] = [13.0, ((all.length - 1) / 2 - i) * 1.8, -0.6];
      });
    active = new Set([...own.map((n) => n.id), `${focus}:final`]);
  }

  if (opts.narrow) {
    if (!focus) {
      // Your brief on top, the four decisions in a two-by-two grid, the final plan below.
      positions.brief = [0, 4.8, 0];
      positions.plan = [0, -5.6, 0];
      finals.forEach((n, i) => {
        positions[n.id] = [i % 2 ? 2.4 : -2.4, i < 2 ? 1.4 : -1.4, i % 2 ? -0.1 : 0.1];
      });
    } else {
      // The same steps, turned to run downward; nodes that share a step spread across.
      for (const id of Object.keys(positions)) {
        const [x, y, z] = positions[id];
        positions[id] = [-y * NARROW_ACROSS, -x * NARROW_DOWN, z];
      }
      // The other decisions stack in a column under the plan, far enough apart for a two-line
      // label each, rather than side by side where long names collide.
      const planY = positions.plan[1];
      finals
        .filter((n) => n.slot !== focus)
        .forEach((n, i) => {
          positions[n.id] = [0, planY - 2.6 - i * 1.9, -0.6];
        });
    }
  }

  // Every rendered node is framed, not only the active path (P2.1).
  const fit: FitNode[] = nodes
    .filter((n) => positions[n.id])
    .map((n) => ({
      id: n.id,
      p: positions[n.id],
      r: NODE_RADIUS[n.kind],
      label: n.label,
      side: !opts.narrow && !focus && n.id === "brief" ? "left" : !opts.narrow && !focus && n.id === "plan" ? "right" : "below",
      kicker: !focus,
    }));
  return { positions, active, fit, narrow: !!opts.narrow, routes: routeEdges(edges, nodes, positions) };
}
