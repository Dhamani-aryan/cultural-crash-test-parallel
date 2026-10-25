import { describe, expect, it, vi } from "vitest";
import { createOpenAiLlm } from "@/lib/llm/openai";

describe("OpenAI Responses client", () => {
  it("sends a server-side Responses request and reads text and usage", async () => {
    const doFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return new Response(
        JSON.stringify({
          output: [{ type: "message", content: [{ type: "output_text", text: "result" }] }],
          usage: { input_tokens: 12, output_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const llm = createOpenAiLlm({
      apiKey: "test-key",
      model: "gpt-6-luna",
      reasoningEffort: "low",
      fetch: doFetch as typeof fetch,
    });
    await expect(llm.generateText({ system: "System", prompt: "Prompt" })).resolves.toMatchObject({
      text: "result",
      model: "gpt-6-luna",
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    const [url, init] = doFetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "gpt-6-luna",
      instructions: "System",
      input: "Prompt",
      reasoning: { effort: "low" },
    });
  });

  it("does not leak the API key in an API error", async () => {
    const llm = createOpenAiLlm({
      apiKey: "secret-key",
      model: "gpt-6-luna",
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: "Invalid key" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(llm.generateText({ system: "S", prompt: "P" })).rejects.toThrow(
      "OpenAI returned 401: Invalid key",
    );
  });
});
