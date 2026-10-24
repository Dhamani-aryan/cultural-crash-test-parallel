"use client";

import { Line, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { KIND_LABEL, RELATION_LABEL, visibleGraph, type JudgeGraph, type JudgeGraphEdge, type JudgeGraphNode } from "@/lib/crashtest/judge-graph";
import { chooseLabelSpot, type Rect } from "@/lib/crashtest/judge-labels";
import { FIT_PADDING, MIN_GUTTER, NODE_RADIUS, fitCamera, type GraphLayout, type RoutedEdge } from "@/lib/crashtest/judge-layout";
import { replayTimes, type ReplayTimeline } from "@/lib/crashtest/judge-replay";
import { SLOT_LABEL, type Slot } from "@/lib/crashtest/types";

/**
 * The 3D decision graph. Positions come from the deterministic layout and the replay from its
 * timeline; this file animates toward them, draws shapes and handles pointers. Shape carries
 * the node kind and colour the state, so colour is never the only signal. Labels are plain DOM
 * in one overlay, placed every frame: clamped inside the canvas, above or below their node,
 * and moved or hidden by priority so no two overlap.
 */

const COLOR = { neutral: "#d5d9df", qloo: "#6fa8ff", amber: "#e2a84f", green: "#5fcf95", select: "#ffffff" };

export function nodeColor(n: JudgeGraphNode): string {
  if (n.state === "accepted") return COLOR.green;
  if (n.state === "rejected" || n.state === "uncertain") return COLOR.amber;
  if (n.kind === "final_choice") return COLOR.green;
  if (n.kind === "qloo_evidence") return COLOR.qloo;
  return COLOR.neutral;
}

type Store = Map<string, THREE.Vector3>;
type NodeVis = (id: string) => { shown: boolean; opacity: number };
type EdgeProgress = (id: string) => number;
/** Per edge, chosen by the label pass: which route to draw and which of its segments sit under a label. */
type EdgeChoice = Map<string, { alt: number; hidden: Set<number> }>;
/** The most points any route has (its samples plus the two clipped ends). */
const MAX_POINTS = 28;

/** A route as drawn now: the routed points, carried along as its two nodes move or drift. */
function livePoints(route: RoutedEdge, alt: number, e: JudgeGraphEdge, layout: GraphLayout, disp: Store): THREE.Vector3[] {
  const pts = (alt > 0 ? route.alternatives[alt - 1] : undefined) ?? route.points;
  const home = (id: string) => layout.positions[id];
  const delta = (id: string) => {
    const d = disp.get(id);
    const h = home(id);
    return d && h ? new THREE.Vector3(d.x - h[0], d.y - h[1], d.z - h[2]) : new THREE.Vector3();
  };
  const [da, db] = [delta(e.source), delta(e.target)];
  return pts.map((p, i) => {
    const t = pts.length > 1 ? i / (pts.length - 1) : 0;
    return new THREE.Vector3(p[0], p[1], p[2]).add(da.clone().lerp(db, t));
  });
}
type FrameHook = (camera: THREE.Camera, size: { width: number; height: number }, disp: Store, vis: NodeVis, progress: EdgeProgress) => void;

export interface SceneProps {
  graph: JudgeGraph;
  layout: GraphLayout;
  focus: Slot | null;
  timeline: ReplayTimeline;
  /** performance.now() when the replay started; null shows the finished graph. */
  replayStart: number | null;
  reduced: boolean;
  selected: string | null;
  fitKey: number;
  onSelect: (n: JudgeGraphNode) => void;
}

/** How each node and edge looks in the current view, before the replay clock is applied. */
function useVisuals({ graph, layout, focus, selected }: SceneProps, hover: string | null) {
  return useMemo(() => {
    const view = visibleGraph(graph, focus ?? undefined);
    const inView = new Set(view.nodes.map((n) => n.id));
    const edgesInView = new Set(view.edges.map((e) => e.id));
    const nodes = new Map(
      graph.nodes.map((n) => {
        const active = layout.active.has(n.id);
        const receded = !active && !!focus && n.id !== "brief" && n.id !== "plan";
        // In the overview, changed decisions lead; retained ones stay visible but quieter.
        const quiet = !focus && n.kind === "final_choice" && n.state !== "accepted";
        const opacity = receded ? 0.22 : quiet ? 0.6 : 1;
        // Who keeps a label when two would collide.
        const priority =
          n.id === selected ? 0 : n.kind === "plan" ? 1 : n.kind === "final_choice" ? (n.state === "accepted" ? 2 : 3) : n.id === "brief" ? 4 : active ? 5 : 6;
        return [
          n.id,
          {
            inView: inView.has(n.id),
            opacity,
            label: inView.has(n.id),
            kicker: focus ? "" : n.kind === "final_choice" ? SLOT_LABEL[n.slot!] : KIND_LABEL[n.kind],
            priority,
          },
        ];
      }),
    );
    const touches = (e: JudgeGraphEdge, id: string | null) => !!id && (e.source === id || e.target === id);
    const edges = new Map(
      graph.edges.map((e) => {
        const on = layout.active.has(e.source) && layout.active.has(e.target);
        return [
          e.id,
          {
            inView: edgesInView.has(e.id),
            strong: on || !focus,
            selected: touches(e, selected),
            label: edgesInView.has(e.id) && !!focus && on && (touches(e, hover) || touches(e, selected)),
          },
        ];
      }),
    );
    return { inView, nodes, edges };
  }, [graph, layout, focus, selected, hover]);
}
type Visuals = ReturnType<typeof useVisuals>;

function Shape({ kind }: { kind: JudgeGraphNode["kind"] }) {
  switch (kind) {
    case "brief":
      return <boxGeometry args={[0.36, 0.36, 0.36]} />;
    case "llm_choice":
      return <sphereGeometry args={[0.22, 28, 18]} />;
    case "qloo_evidence":
      return <capsuleGeometry args={[0.1, 0.3, 6, 14]} />;
    case "candidate":
      return <torusGeometry args={[0.2, 0.035, 10, 36]} />;
    case "test":
      return <octahedronGeometry args={[0.27]} />;
    default:
      return <sphereGeometry args={[kind === "plan" ? 0.3 : 0.21, 28, 18]} />;
  }
}

function NodeMesh({
  n,
  disp,
  vis,
  selected,
  onHover,
  onSelect,
}: {
  n: JudgeGraphNode;
  disp: Store;
  vis: NodeVis;
  selected: boolean;
  onHover: (id: string | null) => void;
  onSelect: (n: JudgeGraphNode) => void;
}) {
  const group = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Mesh>(null);
  const mats = useRef<THREE.MeshStandardMaterial[]>([]);
  const color = nodeColor(n);
  const ringed = n.kind === "final_choice" || n.kind === "plan";
  const shownNow = useRef(false);
  useFrame((_, dt) => {
    const g = group.current;
    const p = disp.get(n.id);
    if (!g || !p) return;
    const { shown, opacity } = vis(n.id);
    shownNow.current = shown;
    g.position.copy(p);
    const k = 1 - Math.exp(-dt * 12);
    g.scale.setScalar(THREE.MathUtils.lerp(g.scale.x, shown ? (selected ? 1.3 : 1) : 0.001, k));
    for (const m of mats.current) if (m) m.opacity = THREE.MathUtils.lerp(m.opacity, shown ? opacity : 0, k);
    if (halo.current) halo.current.visible = selected && shown;
  });
  const mat = (i: number) => (
    <meshStandardMaterial
      ref={(m) => {
        if (m) mats.current[i] = m;
      }}
      color={color}
      emissive={color}
      emissiveIntensity={0.55}
      roughness={0.45}
      transparent
      opacity={0}
    />
  );
  return (
    <group ref={group} scale={0.001}>
      <mesh rotation={n.kind === "qloo_evidence" ? [0, 0, Math.PI / 2] : [0, 0, 0]}>
        <Shape kind={n.kind} />
        {mat(0)}
      </mesh>
      {ringed && (
        <mesh>
          <torusGeometry args={[n.kind === "plan" ? 0.5 : 0.36, 0.022, 8, 48]} />
          {mat(1)}
        </mesh>
      )}
      {/* The selection mark: a thin white ring, not a glow. */}
      <mesh ref={halo} visible={false}>
        <torusGeometry args={[0.52, 0.018, 8, 56]} />
        <meshBasicMaterial color={COLOR.select} transparent opacity={0.9} />
      </mesh>
      {/* A generous invisible hit area, so small nodes are easy to tap. */}
      <mesh
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          if (shownNow.current) onSelect(n);
        }}
        onPointerOver={() => {
          if (!shownNow.current) return;
          document.body.style.cursor = "pointer";
          onHover(n.id);
        }}
        onPointerOut={() => {
          document.body.style.cursor = "";
          onHover(null);
        }}
      >
        <sphereGeometry args={[0.5, 12, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}

/**
 * A routed curve that grows along its route as the replay draws it. It is drawn as segments, so
 * a segment that would pass behind a label can be left out entirely.
 */
function EdgeLine({
  e,
  disp,
  layout,
  progress,
  choice,
  strong,
  selected,
}: {
  e: JudgeGraphEdge;
  disp: Store;
  layout: GraphLayout;
  progress: EdgeProgress;
  choice: EdgeChoice;
  strong: boolean;
  selected: boolean;
}) {
  const line = useRef<THREE.Object3D & { geometry: { setPositions: (p: number[]) => void }; material: THREE.Material & { opacity: number } }>(null);
  const [flat] = useState(() => new Array<number>((MAX_POINTS - 1) * 6).fill(0));
  useFrame(() => {
    const route = layout.routes[e.id];
    if (!line.current) return;
    const p = route ? progress(e.id) : 0;
    flat.fill(0);
    if (route && p > 0) {
      const c = choice.get(e.id);
      const pts = livePoints(route, c?.alt ?? 0, e, layout, disp);
      // Unused segments sit on the route's own start, under the drawn line: left at the origin, a
      // zero-length segment of a wide line shows as a stray dot in the middle of the graph.
      if (pts[0]) for (let k = 0; k < flat.length; k += 3) flat.splice(k, 3, pts[0].x, pts[0].y, pts[0].z);
      const drawn = p * (pts.length - 1);
      for (let k = 0; k < pts.length - 1 && k < MAX_POINTS - 1; k++) {
        if (k >= drawn || c?.hidden.has(k)) continue;
        const a = pts[k];
        const b = k + 1 <= drawn ? pts[k + 1] : a.clone().lerp(pts[k + 1], drawn - k);
        flat.splice(k * 6, 6, a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
    line.current.geometry.setPositions(flat);
    line.current.material.opacity = p <= 0 ? 0 : selected ? 0.95 : strong ? 0.55 : 0.18;
  });
  return (
    <Line
      ref={line as never}
      segments
      points={Array.from({ length: (MAX_POINTS - 1) * 2 }, () => [0, 0, 0] as [number, number, number])}
      color={selected ? COLOR.select : e.relation === "rejected_after_retest" || e.relation === "did_not_support" ? COLOR.amber : "#ffffff"}
      lineWidth={selected ? 2 : strong ? 1.3 : 1}
      transparent
      opacity={0}
      dashed={e.relation === "rejected_after_retest"}
      dashSize={0.12}
      gapSize={0.1}
    />
  );
}

/**
 * Frames every rendered node and its label (fitCamera), or brings a selected node closer while its
 * circle and full label stay inside, in under half a second. Refits on resize, focus change, replay
 * reset, "Fit graph" and once the label font has loaded.
 */
function Rig({ layout, fitKey, reduced, selected, replayStart }: { layout: GraphLayout; fitKey: number; reduced: boolean; selected: string | null; replayStart: number | null }) {
  const { camera, size } = useThree();
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update: () => void } | null;
  const anim = useRef<{ t0: number; fromP: THREE.Vector3; toP: THREE.Vector3; fromT: THREE.Vector3; toT: THREE.Vector3 } | null>(null);
  const [fontsReady, setFontsReady] = useState(0);
  useEffect(() => {
    let live = true;
    document.fonts?.ready.then(() => live && setFontsReady((n) => n + 1));
    return () => {
      live = false;
    };
  }, []);
  const replaying = replayStart !== null;
  useEffect(() => {
    if (!controls || !size.width || !size.height) return;
    const fov = (camera as THREE.PerspectiveCamera).fov;
    const view = { width: size.width, height: size.height };
    const whole = fitCamera(layout.fit, view, fov);
    let target = whole.target;
    let d = whole.distance;
    const own = selected ? layout.fit.find((f) => f.id === selected) : undefined;
    if (own) {
      // Closer on the selected node, but never so close that its circle or label leaves the canvas.
      const half = THREE.MathUtils.degToRad(fov / 2);
      const near = Math.max(5 / 2 / Math.tan(half), 8 / 2 / (Math.tan(half) * (view.width / view.height))) + 1.2;
      const alone = fitCamera([own], view, fov);
      d = Math.min(whole.distance, Math.max(near, alone.distance));
      target = alone.target;
    }
    const toT = new THREE.Vector3(...target);
    // Straight on: the routes and labels were laid out for this view.
    const toP = toT.clone().add(new THREE.Vector3(0, 0, d));
    anim.current = { t0: performance.now(), fromP: camera.position.clone(), toP, fromT: controls.target.clone(), toT };
  }, [layout, fitKey, controls, camera, size.width, size.height, selected, fontsReady, replaying]);
  useFrame(() => {
    const a = anim.current;
    if (!a || !controls) return;
    const t = reduced ? 1 : Math.min(1, (performance.now() - a.t0) / 450);
    const k = 1 - Math.pow(1 - t, 3);
    camera.position.lerpVectors(a.fromP, a.toP, k);
    controls.target.lerpVectors(a.fromT, a.toT, k);
    controls.update();
    if (t >= 1) anim.current = null;
  });
  return null;
}

function Scene(props: SceneProps & { visuals: Visuals; onFrame: FrameHook; onHover: (id: string | null) => void; choice: EdgeChoice }) {
  const { graph, layout, timeline, replayStart, reduced, selected, fitKey, onSelect, visuals, onFrame, onHover, choice } = props;
  // Live positions and the replay clock, mutated every frame; held in state so they are stable objects.
  const [cur] = useState<Store>(() => new Map());
  const [disp] = useState<Store>(() => new Map());
  const [tmp] = useState(() => new THREE.Vector3());
  const [clock] = useState(() => new Map<"t", number>([["t", Infinity]]));
  const times = useMemo(() => replayTimes(timeline), [timeline]);

  const vis: NodeVis = (id) => {
    const v = visuals.nodes.get(id)!;
    const at = times.shownAt.get(id);
    const shown = v.inView && (at === undefined || clock.get("t")! >= at);
    const recede = times.recedeAt.get(id);
    const n = graph.nodes.find((x) => x.id === id)!;
    // Rejected candidates stay prominent until their re-test, then recede.
    const rejected = n.kind === "candidate" && n.state === "rejected" && (recede === undefined || clock.get("t")! >= recede);
    return { shown, opacity: rejected ? Math.min(v.opacity, 0.45) : v.opacity };
  };
  const progress: EdgeProgress = (id) => {
    const v = visuals.edges.get(id)!;
    if (!v.inView) return 0;
    const at = times.edgeAt.get(id);
    const now = clock.get("t")!;
    if (!at) return now === Infinity ? 1 : 0;
    return THREE.MathUtils.clamp((now - at.at) / at.duration, 0, 1);
  };

  useFrame((state, dt) => {
    clock.set("t", replayStart === null ? Infinity : performance.now() - replayStart);
    const k = reduced ? 1 : 1 - Math.exp(-dt * 9);
    const t = state.clock.elapsedTime;
    graph.nodes.forEach((n, i) => {
      // Hidden nodes fold into their decision, so they branch out from it when shown.
      const home = n.slot ? layout.positions[`${n.slot}:final`] : undefined;
      const inView = visuals.inView.has(n.id);
      const target = (inView && layout.positions[n.id]) || home || layout.positions[n.id] || [0, 0, 0];
      let c = cur.get(n.id);
      if (!c) {
        c = new THREE.Vector3(...target);
        cur.set(n.id, c);
      }
      if (inView) c.lerp(tmp.set(...target), k);
      else c.set(...target);
      const d = disp.get(n.id) ?? new THREE.Vector3();
      d.copy(c);
      // A barely-there drift for depth; none when motion is reduced.
      if (!reduced) {
        d.x += Math.sin(t * 0.5 + i) * 0.03;
        d.y += Math.cos(t * 0.4 + i * 1.7) * 0.03;
      }
      disp.set(n.id, d);
    });
    onFrame(state.camera, state.size, disp, vis, progress);
  });

  return (
    <>
      <color attach="background" args={["#141619"]} />
      <fog attach="fog" args={["#141619", 13, 30]} />
      <ambientLight intensity={0.55} />
      <pointLight position={[4, 6, 8]} intensity={40} />
      {graph.edges.map((e) => {
        const v = visuals.edges.get(e.id)!;
        return <EdgeLine key={e.id} e={e} disp={disp} layout={layout} progress={progress} choice={choice} strong={v.strong} selected={v.selected} />;
      })}
      {graph.nodes.map((n) => (
        <NodeMesh key={n.id} n={n} disp={disp} vis={vis} selected={selected === n.id} onSelect={onSelect} onHover={onHover} />
      ))}
      <Rig layout={layout} fitKey={fitKey} reduced={reduced} selected={selected} replayStart={replayStart} />
      <OrbitControls makeDefault enablePan={false} enableDamping minDistance={4} maxDistance={34} />
    </>
  );
}

const PAD = 12;
/** Does the segment p→q pass through rectangle r (with a hair of padding)? */
function segmentHits(p: { x: number; y: number }, q: { x: number; y: number }, r: Rect): boolean {
  const [x0, y0, x1, y1] = [r.x - 2, r.y - 2, r.x + r.w + 2, r.y + r.h + 2];
  let [t0, t1] = [0, 1];
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  for (const [pp, qq] of [
    [-dx, p.x - x0],
    [dx, x1 - p.x],
    [-dy, p.y - y0],
    [dy, y1 - p.y],
  ]) {
    if (pp === 0) {
      if (qq < 0) return false;
      continue;
    }
    const t = qq / pp;
    if (pp < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

export default function JudgeGraphScene(props: SceneProps & { onMiss: () => void }) {
  const { onMiss, ...scene } = props;
  const [hover, setHover] = useState<string | null>(null);
  const visuals = useVisuals(scene, hover);
  const overlay = useRef<Map<string, HTMLElement>>(new Map());
  const tmp = useRef(new THREE.Vector3());

  // Which route each edge draws and which segments it hides; written by the label pass below.
  const [choice] = useState<EdgeChoice>(() => new Map());

  // Every frame: place labels, then make sure no line runs behind any of them.
  const onFrame: FrameHook = (camera, { width, height }, disp, vis, progress) => {
    const v = tmp.current;
    const project = (p: THREE.Vector3 | number[]) => {
      if (p instanceof THREE.Vector3) v.copy(p);
      else v.set(p[0], p[1], p[2]);
      v.project(camera);
      return { x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height, behind: v.z > 1 };
    };
    const kindOf = new Map(scene.graph.nodes.map((n) => [n.id, n.kind]));
    // Each visible node's projected disc; labels keep outside them.
    const discs = new Map<string, { x: number; y: number; r: number }>();
    for (const n of scene.graph.nodes) {
      const p = disp.get(n.id);
      if (!p || !vis(n.id).shown) continue;
      const c = project(p);
      const edge = project(new THREE.Vector3(p.x + NODE_RADIUS[n.kind], p.y, p.z));
      if (!c.behind) discs.set(n.id, { x: c.x, y: c.y, r: Math.hypot(edge.x - c.x, edge.y - c.y) });
    }
    const placed: Rect[] = [...discs.values()].map((d) => ({ x: d.x - d.r, y: d.y - d.r, w: d.r * 2, h: d.r * 2 }));
    const labels: Rect[] = [];
    const jobs: { key: string; el: HTMLElement; priority: number; node: boolean }[] = [];
    for (const [key, el] of overlay.current) {
      const isEdge = key.startsWith("edge:");
      const ok = isEdge ? progress(key.slice(5)) >= 1 : !!visuals.nodes.get(key)?.label && discs.has(key);
      if (!ok) {
        el.style.visibility = "hidden";
        continue;
      }
      jobs.push({ key, el, priority: isEdge ? 9 : visuals.nodes.get(key)!.priority, node: !isEdge });
    }
    jobs.sort((a, b) => a.priority - b.priority);
    // The same safe margin the camera fit keeps, so a label never sits under the canvas edge.
    const pad = Math.max(PAD, Math.min(width * FIT_PADDING, MIN_GUTTER));
    for (const j of jobs) {
      const w = j.el.offsetWidth;
      const h = j.el.offsetHeight;
      const spots: Rect[] = [];
      if (j.node) {
        const d = discs.get(j.key)!;
        const gap = d.r + 6;
        const home = scene.layout.positions[j.key];
        const above = { x: d.x - w / 2, y: d.y - gap - h, w, h };
        const below = { x: d.x - w / 2, y: d.y + gap, w, h };
        // Overview anchors are fixed so the picture is stable; focused labels go above in the lower part.
        const wide = !scene.focus && !scene.layout.narrow;
        if (wide && j.key === "brief") spots.push({ x: d.x - gap - w - 2, y: d.y - h / 2, w, h }, above, below);
        else if (wide && j.key === "plan") spots.push({ x: d.x + gap + 2, y: d.y - h / 2, w, h }, above, below);
        else if (scene.layout.narrow && (j.key === "brief" || j.key === "plan")) spots.push(...(j.key === "brief" ? [above, below] : [below, above]));
        else if (!scene.focus && kindOf.get(j.key) === "final_choice") spots.push(...(home && home[1] > 0 ? [above, below] : [below, above]));
        else spots.push(...(d.y > height * 0.62 ? [above, below] : [below, above]));
        // Then the same spots nudged sideways, then beside the node, then a label-height further
        // out, before moving it inward over something (a node label is never hidden).
        for (const s0 of [...spots]) spots.push({ ...s0, x: s0.x + w / 2 + 8 }, { ...s0, x: s0.x - w / 2 - 8 });
        spots.push({ x: d.x + gap + 2, y: d.y - h / 2, w, h }, { x: d.x - gap - w - 2, y: d.y - h / 2, w, h });
        for (const s0 of [below, above]) {
          const out = s0 === below ? h + 4 : -(h + 4);
          for (const dx of [0, w / 2 + 8, -(w / 2 + 8)]) spots.push({ ...s0, x: s0.x + dx, y: s0.y + out });
        }
      } else {
        const e = scene.graph.edges.find((x) => x.id === j.key.slice(5));
        const route = e && scene.layout.routes[e.id];
        if (!e || !route) continue;
        const pts = livePoints(route, choice.get(e.id)?.alt ?? 0, e, scene.layout, disp);
        const m = project(pts[Math.floor(pts.length / 2)]);
        spots.push({ x: m.x - w / 2, y: m.y - h / 2, w, h });
      }
      const spot = chooseLabelSpot({ spots, placed, node: j.node, width, height, pad });
      if (!spot) {
        j.el.style.visibility = "hidden";
        continue;
      }
      placed.push(spot);
      labels.push(spot);
      j.el.style.visibility = "visible";
      j.el.style.transform = `translate(${spot.x}px, ${spot.y}px)`;
    }

    // No line may run behind a label: take the first route that clears every label, else hide
    // the segments that would pass behind one.
    for (const e of scene.graph.edges) {
      const route = scene.layout.routes[e.id];
      if (!route || !visuals.edges.get(e.id)?.inView) continue;
      let pick = { alt: 0, hidden: new Set<number>() };
      for (let alt = 0; alt <= route.alternatives.length; alt++) {
        const pts = livePoints(route, alt, e, scene.layout, disp).map((p) => project(p));
        const hidden = new Set<number>();
        for (let k = 0; k < pts.length - 1; k++) if (labels.some((r) => segmentHits(pts[k], pts[k + 1], r))) hidden.add(k);
        if (alt === 0) pick = { alt, hidden };
        if (!hidden.size) {
          pick = { alt, hidden };
          break;
        }
      }
      choice.set(e.id, pick);
    }
  };
  const keep = (key: string, el: HTMLElement | null) => {
    if (el) overlay.current.set(key, el);
    else overlay.current.delete(key);
  };
  return (
    <div className="relative h-full w-full">
      <Canvas dpr={[1, 2]} camera={{ fov: 38, position: [0, 1.5, 16] }} onPointerMissed={onMiss} aria-hidden>
        <Scene {...scene} visuals={visuals} onFrame={onFrame} onHover={setHover} choice={choice} />
      </Canvas>
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {scene.graph.nodes.map((n) => {
          const v = visuals.nodes.get(n.id)!;
          return (
            <div
              key={n.id}
              ref={(el) => keep(n.id, el)}
              className="absolute left-0 top-0 w-max max-w-[150px] text-center leading-tight will-change-transform"
              style={{ visibility: "hidden", opacity: v.opacity < 0.5 ? 0.55 : 1 }}
            >
              {v.kicker && <div className="font-mono text-[8.5px] uppercase tracking-[0.1em] text-white/45">{v.kicker}</div>}
              <div className={`text-[11px] font-medium ${scene.selected === n.id ? "text-white" : "line-clamp-2 text-white/90"}`}>{n.label}</div>
            </div>
          );
        })}
        {scene.graph.edges.map((e) =>
          visuals.edges.get(e.id)!.label ? (
            <div key={e.id} ref={(el) => keep(`edge:${e.id}`, el)} className="absolute left-0 top-0" style={{ visibility: "hidden" }}>
              <span className="block whitespace-nowrap rounded bg-[#141619]/85 px-1 font-mono text-[9px] text-white/65">{RELATION_LABEL[e.relation]}</span>
            </div>
          ) : null,
        )}
      </div>
    </div>
  );
}
