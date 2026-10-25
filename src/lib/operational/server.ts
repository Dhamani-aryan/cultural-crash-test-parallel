import "server-only";
import type { LlmClient } from "@/lib/llm/types";
import { getOperationalEnv } from "@/lib/env";
import { BraveOperationalClient } from "./brave";

export function getOperationalClient(llm: LlmClient) {
  const env = getOperationalEnv();
  return env ? new BraveOperationalClient(env.apiKey, llm, env.baseUrl) : undefined;
}
