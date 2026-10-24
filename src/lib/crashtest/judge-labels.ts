/**
 * Where a graph label goes, given candidate spots in priority order. A node label is never hidden:
 * when no spot is clear and inside the canvas, it is moved inward (clamped), preferring a clamped
 * spot that overlaps nothing. Only a low-priority edge label may be dropped.
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w + 4 && b.x < a.x + a.w + 4 && a.y < b.y + b.h + 2 && b.y < a.y + a.h + 2;

export function chooseLabelSpot(x: { spots: Rect[]; placed: Rect[]; node: boolean; width: number; height: number; pad: number }): Rect | null {
  const { spots, placed, node, width, height, pad } = x;
  const inside = (r: Rect) => r.x >= pad && r.y >= pad && r.x + r.w <= width - pad && r.y + r.h <= height - pad;
  const clear = (r: Rect) => !placed.some((p) => overlaps(p, r));
  const clean = spots.find((r) => inside(r) && clear(r));
  if (clean) return clean;
  if (!node || !spots.length) return null;
  const clamp = (r: Rect): Rect => ({
    ...r,
    x: Math.min(Math.max(r.x, pad), Math.max(pad, width - pad - r.w)),
    y: Math.min(Math.max(r.y, pad), Math.max(pad, height - pad - r.h)),
  });
  const moved = spots.map(clamp);
  return moved.find(clear) ?? moved[0];
}
