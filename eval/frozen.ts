/**
 * Evaluation artifacts that are frozen baselines. No script may write into them; their
 * fingerprints are recorded in eval/frozen/<tag>.json and checked with eval:fingerprint.
 */
export interface FrozenSpec {
  /** The commit that produced them. */
  commit: string;
  runVersion: string;
  /** Directories (every file in them) and single files, relative to the repository root. */
  dirs: string[];
  files: string[];
}

export const FROZEN: Record<string, FrozenSpec> = {
  sequential: {
    commit: "e217f3f",
    runVersion: "crash:v15",
    dirs: ["eval/out/scenario-runs"],
    files: ["eval/out/scenario-summary.json", "eval/out/scenario-intake.json"],
  },
  "parallel-v2": {
    commit: "40aa69d",
    runVersion: "crash:v15+parallel:v2",
    dirs: ["eval/out/scenario-runs-parallel-v2"],
    files: ["eval/out/scenario-summary-parallel-v2.json"],
  },
};

/** Every frozen path, as "dir/" for directories. */
export const FROZEN_PATHS = Object.values(FROZEN).flatMap((s) => [...s.dirs.map((d) => `${d}/`), ...s.files]);

/** True when writing `path` would touch a frozen baseline. */
export function isFrozen(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  return FROZEN_PATHS.some((f) => (f.endsWith("/") ? p === f.slice(0, -1) || p.startsWith(f) : p === f));
}

/** The files a frozen tag covers (directories expanded), sorted. */
export function frozenFiles(tag: string, list: (dir: string) => string[], exists: (p: string) => boolean): string[] {
  const s = FROZEN[tag];
  return [
    ...s.dirs.flatMap((d) => (exists(d) ? list(d).map((f) => `${d}/${f}`) : [])),
    ...s.files.filter(exists),
  ].sort();
}
