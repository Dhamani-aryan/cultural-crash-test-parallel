export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Placeholder until P2.1 implements label placement. */
export function chooseLabelSpot(_: { spots: Rect[]; placed: Rect[]; node: boolean; width: number; height: number; pad: number }): Rect | null {
  void _;
  throw new Error("not implemented");
}
