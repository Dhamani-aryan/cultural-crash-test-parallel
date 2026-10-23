/**
 * Fingerprint evaluation artifacts, so a frozen baseline can be checked later.
 *
 *   npm run eval:fingerprint -- write parallel-v2     # record eval/frozen/parallel-v2.json
 *   npm run eval:fingerprint -- verify parallel-v2    # exit 1 if any file changed or vanished
 *
 * The manifest holds only file names, sizes and SHA-256 hashes (no Qloo data), so it is
 * committed. The artifacts themselves stay git-ignored.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { FROZEN, frozenFiles } from "./frozen";

const [mode, tag] = process.argv.slice(2).filter((a) => a !== "--");
const spec = FROZEN[tag];
if (!spec || (mode !== "write" && mode !== "verify")) throw new Error(`Usage: write|verify <${Object.keys(FROZEN).join("|")}>`);
const manifestFile = `eval/frozen/${tag}.json`;
const hash = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const files = frozenFiles(tag, (d) => readdirSync(d), existsSync);
const now = Object.fromEntries(files.map((f) => [f, { bytes: statSync(f).size, sha256: hash(f) }]));

if (mode === "write") {
  if (existsSync(manifestFile)) throw new Error(`${manifestFile} exists; a frozen manifest is never rewritten.`);
  mkdirSync("eval/frozen", { recursive: true });
  writeFileSync(manifestFile, JSON.stringify({ tag, commit: spec.commit, runVersion: spec.runVersion, recordedAt: new Date().toISOString(), files: now }, null, 2) + "\n");
  console.log(`wrote ${manifestFile}: ${files.length} files`);
} else {
  const want = (JSON.parse(readFileSync(manifestFile, "utf8")) as { files: Record<string, { sha256: string }> }).files;
  const problems = [
    ...Object.keys(want).filter((f) => !now[f]).map((f) => `missing: ${f}`),
    ...Object.keys(now).filter((f) => !want[f]).map((f) => `added: ${f}`),
    ...Object.keys(want).filter((f) => now[f] && now[f].sha256 !== want[f].sha256).map((f) => `changed: ${f}`),
  ];
  for (const p of problems) console.log(p);
  console.log(problems.length ? `${tag}: ${problems.length} problem(s)` : `${tag}: all ${files.length} files match`);
  if (problems.length) process.exit(1);
}
