import "server-only";
import { getCache } from "@/lib/cache/server";
import { getLlm } from "@/lib/llm";
import { withCache } from "@/lib/qloo/cached";
import { getQlooClient } from "@/lib/qloo/server";
import { getOperationalClient } from "@/lib/operational/server";
import type { Deps } from "./handlers";

/** Real clients for route handlers (Qloo answers cached server-side). Throws if keys are missing. */
export function getDeps(): Deps {
  // One wrapper per request, so its counts belong to this run alone.
  const qlooStats = { hits: 0, requests: 0 };
  const llm = getLlm();
  return {
    qloo: withCache(getQlooClient(), getCache(), undefined, qlooStats),
    llm,
    qlooStats,
    operational: getOperationalClient(llm),
  };
}
