import { describe, expect, it } from "vitest";
import { getRedisEnv } from "@/lib/env";

describe("Redis environment", () => {
  it("accepts the names injected by the Vercel Upstash integration", () => {
    expect(
      getRedisEnv({
        KV_REST_API_URL: "https://example.upstash.io",
        KV_REST_API_TOKEN: "secret-token",
      }),
    ).toEqual({ url: "https://example.upstash.io", token: "secret-token" });
  });

  it("prefers direct Upstash names when both forms exist", () => {
    expect(
      getRedisEnv({
        UPSTASH_REDIS_REST_URL: "https://direct.upstash.io",
        UPSTASH_REDIS_REST_TOKEN: "direct-token",
        KV_REST_API_URL: "https://marketplace.upstash.io",
        KV_REST_API_TOKEN: "marketplace-token",
      }),
    ).toEqual({ url: "https://direct.upstash.io", token: "direct-token" });
  });
});
