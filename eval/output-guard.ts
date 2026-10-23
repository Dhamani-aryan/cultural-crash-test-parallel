import { existsSync, readdirSync, readFileSync } from "node:fs";

/** The run versions recorded by the states already in a scenario-runs directory. */
export function existingVersions(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const versions = new Set<string>();
  for (const f of readdirSync(directory).filter((x) => x.endsWith(".json"))) {
    try {
      const s = JSON.parse(readFileSync(`${directory}/${f}`, "utf8")) as { provenance?: { runVersion?: string } };
      versions.add(s.provenance?.runVersion ?? "unknown");
    } catch {
      versions.add("unreadable");
    }
  }
  return [...versions];
}

/**
 * Why a scenario run may not write where it was pointed, or null. Frozen baselines are never
 * written to, and a directory holding another version's runs is never overwritten or mixed:
 * pick a new SCENARIO_TAG instead.
 */
export function outputRefusal(x: {
  directory: string;
  summaryFile: string;
  runVersion: string;
  frozen: (path: string) => boolean;
  existing: string[];
}): string | null {
  for (const p of [x.directory, x.summaryFile]) if (x.frozen(p)) return `${p} is a frozen baseline; choose another SCENARIO_TAG.`;
  const other = x.existing.filter((v) => v !== x.runVersion);
  if (other.length) return `${x.directory} holds runs from ${other.join(", ")}, not ${x.runVersion}; choose another SCENARIO_TAG.`;
  return null;
}
