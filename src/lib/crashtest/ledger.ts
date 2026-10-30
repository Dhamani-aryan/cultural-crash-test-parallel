import type { InsightsInput, InsightsResult, QlooClient } from "@/lib/qloo";
import type { Coverage, EvidenceItem, EvidenceRecord } from "./types";

/** Thrown before a Qloo call that would exceed the run's budget. The controller stops on it. */
export class BudgetExceeded extends Error {
  constructor(readonly used: number) {
    super(`Qloo call budget reached (${used})`);
    this.name = "BudgetExceeded";
  }
}

/**
 * Wrap a Qloo client so every call counts against the run's budget. The count is enforced
 * here, in code, before the request goes out; the model never decides whether it may call.
 * Cached answers still count: the budget bounds the work a run asks for, not cache luck.
 */
export function budgeted(client: QlooClient, max: number, onCall: (used: number) => void) {
  let used = 0;
  const guard =
    <I, O>(fn: (input: I) => Promise<O>) =>
    (input: I): Promise<O> => {
      if (used >= max) return Promise.reject(new BudgetExceeded(used));
      used++;
      onCall(used);
      return fn(input);
    };
  const wrapped: QlooClient = {
    searchEntities: guard((i) => client.searchEntities(i)),
    getEntities: guard((i) => client.getEntities(i)),
    getDemographics: guard((i) => client.getDemographics(i)),
    searchTags: guard((i) => client.searchTags(i)),
    getInsights: guard((i) => client.getInsights(i)),
    compareProfiles: guard((i) => client.compareProfiles(i)),
  };
  return { client: wrapped, used: () => used };
}

/**
 * Answer a repeated request inside one run from the run's own memory. Re-testing a candidate
 * asks again for evidence that doesn't depend on the swap (the other choices' own audience and
 * locality results); those repeats are reused, while anything that does depend on the changed
 * plan is a new request and is still asked. Errors are not remembered.
 */
export function memoized(client: QlooClient) {
  let reused = 0;
  const seen = new Map<string, Promise<unknown>>();
  const memo =
    <I, O>(name: string, fn: (input: I) => Promise<O>) =>
    (input: I): Promise<O> => {
      const key = `${name}:${stableKey(input)}`;
      const hit = seen.get(key);
      if (hit) {
        reused++;
        return hit as Promise<O>;
      }
      const work = fn(input);
      seen.set(key, work);
      work.catch(() => seen.delete(key));
      return work;
    };
  const wrapped: QlooClient = {
    searchEntities: memo("search", (i) => client.searchEntities(i)),
    getEntities: memo("entities", (i) => client.getEntities(i)),
    getDemographics: memo("demographics", (i) => client.getDemographics(i)),
    searchTags: memo("tags", (i) => client.searchTags(i)),
    getInsights: memo("insights", (i) => client.getInsights(i)),
    compareProfiles: memo("compare", (i) => client.compareProfiles(i)),
  };
  return { client: wrapped, reused: () => reused };
}

/** JSON with object keys sorted, so equal requests give equal keys. */
function stableKey(v: unknown): string {
  return JSON.stringify(v, (_, x) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x,
  );
}

/** The request as Qloo sees it, in its own parameter names, with nothing secret in it. */
export function sanitizeInsights(input: InsightsInput): Record<string, unknown> {
  const out: Record<string, unknown> = {
    "filter.type": input.filterType,
    "signal.interests.entities": input.signalEntities,
    "signal.interests.tags": input.signalTags,
    "signal.location.query": input.signalLocationQuery,
    "filter.location.query": input.filterLocationQuery,
    "filter.tags": input.filterTags,
    "filter.tag.types": input.filterTagTypes,
    "filter.results.entities": input.resultEntities,
    "filter.exclude.entities": input.excludeEntities,
    "feature.explainability": input.explainability,
    ...input.extraParams,
    take: input.take,
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

/** How many results the ledger keeps per record (always plus the item the query was about). */
export const LEDGER_TOP = 8;

export function coverageOf(count: number, wanted: number): Coverage {
  if (count === 0) return "empty";
  return count >= Math.min(wanted, 10) ? "usable" : "partial";
}

/** Compact, display-safe result items from an Insights answer. */
export function itemsFrom(result: InsightsResult, keep: string[] = []): EvidenceItem[] {
  const ents = result.entities.map(
    (e): EvidenceItem => ({
      id: e.id,
      name: e.displayName,
      type: e.type ?? undefined,
      rank: e.rank,
      affinity: e.affinity ?? undefined,
      popularity: e.popularity ?? undefined,
      explainability: e.explainability ?? undefined,
    }),
  );
  const tags = result.tags.map(
    (t): EvidenceItem => ({
      id: t.id,
      name: t.name,
      type: t.subtype ?? undefined,
      rank: t.rank,
      affinity: t.affinity ?? undefined,
      popularity: t.popularity ?? undefined,
    }),
  );
  const all = [...ents, ...tags];
  const top = all.slice(0, LEDGER_TOP);
  const extra = all.filter((x, i) => i >= LEDGER_TOP && keep.includes(x.id));
  return [...top, ...extra];
}

export interface Ledger {
  records: EvidenceRecord[];
  add(r: Omit<EvidenceRecord, "evidenceId" | "collectedAt" | "iteration">): EvidenceRecord;
}

/** The same ledger, with every record it adds stamped with the track or stage that collected it. */
export function scopedLedger(ledger: Ledger, scope: string): Ledger {
  return { records: ledger.records, add: (r) => ledger.add({ ...r, scope }) };
}

export function createLedger(
  iteration: () => number,
  onRecord: (r: EvidenceRecord) => void = () => {},
): Ledger {
  const records: EvidenceRecord[] = [];
  return {
    records,
    add(r) {
      const record: EvidenceRecord = {
        ...r,
        evidenceId: `E${records.length + 1}`,
        iteration: iteration(),
        collectedAt: new Date().toISOString(),
      };
      records.push(record);
      onRecord(record);
      return record;
    },
  };
}
