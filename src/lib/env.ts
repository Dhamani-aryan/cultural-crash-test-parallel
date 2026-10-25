import { z } from "zod";

/**
 * Environment loaders, validated lazily per area so the app boots and the parts that don't
 * need a missing key keep working. No `server-only` here so scripts and tests can use it;
 * app code reaches these values only through server modules (e.g. `@/lib/qloo/server`).
 */

type Env = Record<string, string | undefined>;

export class MissingEnvError extends Error {
  constructor(area: string, issues: string[]) {
    super(
      `${area} is not configured: ${issues.join("; ")}. ` +
        "Copy .env.example to .env.local and fill in the missing values.",
    );
    this.name = "MissingEnvError";
  }
}

const nonEmpty = (name: string) =>
  z
    .string({ error: `${name} is missing` })
    .trim()
    .min(1, `${name} is empty`);

const qlooSchema = z.object({
  QLOO_API_KEY: nonEmpty("QLOO_API_KEY"),
  QLOO_BASE_URL: z.url().default("https://hackathon.api.qloo.com"),
});

const llmSchema = z
  .object({
  LLM_PROVIDER: z.enum(["chatgpt", "openai"], { error: "LLM_PROVIDER must be: chatgpt or openai" }).default("chatgpt"),
  // Default selected from internal quality and latency evaluation.
  LLM_MODEL: z.string().trim().min(1).default("gpt-6-luna"),
  LLM_REASONING_EFFORT: z.enum(["minimal", "low", "medium", "high"]).default("low"),
  CHATGPT_AUTH_FILE: z.string().trim().min(1).default(".secrets/chatgpt-auth.json"),
  /** "file" for local development, "redis" (Upstash) for deployments. */
  CHATGPT_AUTH_STORE: z.enum(["file", "redis"]).default("file"),
  OPENAI_API_KEY: z.string().trim().optional(),
  OPENAI_BASE_URL: z.url().default("https://api.openai.com/v1"),
  })
  .superRefine((value, ctx) => {
    if (value.LLM_PROVIDER === "openai" && !value.OPENAI_API_KEY)
      ctx.addIssue({ code: "custom", path: ["OPENAI_API_KEY"], message: "OPENAI_API_KEY is required when LLM_PROVIDER=openai" });
  });

const redisSchema = z.object({
  UPSTASH_REDIS_REST_URL: z.url({ error: "UPSTASH_REDIS_REST_URL must be a URL" }),
  UPSTASH_REDIS_REST_TOKEN: nonEmpty("UPSTASH_REDIS_REST_TOKEN"),
});

const operationalSchema = z.object({
  BRAVE_SEARCH_API_KEY: nonEmpty("BRAVE_SEARCH_API_KEY"),
  BRAVE_SEARCH_BASE_URL: z.url().default("https://api.search.brave.com/res/v1/web/search"),
});

function load<S extends z.ZodType>(area: string, schema: S, env: Env): z.infer<S> {
  // Treat empty strings from .env files as "not set" so defaults apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ""));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    throw new MissingEnvError(
      area,
      parsed.error.issues.map((i) => i.message),
    );
  }
  return parsed.data;
}

export interface QlooEnv {
  apiKey: string;
  baseUrl: string;
}

export function getQlooEnv(env: Env = process.env): QlooEnv {
  const e = load("Qloo API", qlooSchema, env);
  return { apiKey: e.QLOO_API_KEY, baseUrl: e.QLOO_BASE_URL.replace(/\/+$/, "") };
}

export function getLlmEnv(env: Env = process.env) {
  const e = load("LLM", llmSchema, env);
  return {
    provider: e.LLM_PROVIDER,
    model: e.LLM_MODEL,
    reasoningEffort: e.LLM_REASONING_EFFORT,
    chatgptAuthFile: e.CHATGPT_AUTH_FILE,
    chatgptAuthStore: e.CHATGPT_AUTH_STORE,
    openAiApiKey: e.OPENAI_API_KEY,
    openAiBaseUrl: e.OPENAI_BASE_URL.replace(/\/+$/, ""),
  };
}

export function getRedisEnv(env: Env = process.env) {
  // Vercel's Upstash Marketplace integration currently injects KV_REST_API_* names, while
  // direct Upstash connections use UPSTASH_REDIS_REST_*. Accept both without copying secrets.
  const e = load("Redis cache", redisSchema, {
    ...env,
    UPSTASH_REDIS_REST_URL:
      env.UPSTASH_REDIS_REST_URL?.trim() || env.KV_REST_API_URL?.trim(),
    UPSTASH_REDIS_REST_TOKEN:
      env.UPSTASH_REDIS_REST_TOKEN?.trim() || env.KV_REST_API_TOKEN?.trim(),
  });
  return { url: e.UPSTASH_REDIS_REST_URL, token: e.UPSTASH_REDIS_REST_TOKEN };
}

/** Optional: the core cultural test still runs when operational web verification is not configured. */
export function getOperationalEnv(env: Env = process.env) {
  if (!env.BRAVE_SEARCH_API_KEY?.trim()) return null;
  const e = load("Operational search", operationalSchema, env);
  return { apiKey: e.BRAVE_SEARCH_API_KEY, baseUrl: e.BRAVE_SEARCH_BASE_URL };
}
