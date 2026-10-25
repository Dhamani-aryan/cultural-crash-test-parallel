import { getRedisEnv, getLlmEnv } from "@/lib/env";
import { createChatGptLlm } from "./chatgpt";
import { createOpenAiLlm } from "./openai";
import { createFileStore, createRedisCredentialStore } from "./credential-store";
import type { LlmClient } from "./types";

export { createChatGptLlm } from "./chatgpt";
export { createOpenAiLlm } from "./openai";
export { LlmError } from "./types";
export type * from "./types";

let client: LlmClient | null = null;

/**
 * The configured LLM client. Provider and model come from env (see .env.example).
 * With CHATGPT_AUTH_STORE=redis the ChatGPT credential is read from (and refreshed in) Upstash,
 * which is what a serverless deployment needs.
 */
export function getLlm(env: Record<string, string | undefined> = process.env): LlmClient {
  if (client) return client;
  const e = getLlmEnv(env);
  if (e.provider === "openai") {
    client = createOpenAiLlm({
      apiKey: e.openAiApiKey!,
      baseUrl: e.openAiBaseUrl,
      model: e.model,
      reasoningEffort: e.reasoningEffort,
    });
    return client;
  }
  const store =
    e.chatgptAuthStore === "redis"
      ? createRedisCredentialStore(getRedisEnv(env))
      : createFileStore(e.chatgptAuthFile);
  client = createChatGptLlm({ store, model: e.model, reasoningEffort: e.reasoningEffort });
  return client;
}
