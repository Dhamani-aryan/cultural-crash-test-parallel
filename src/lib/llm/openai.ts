import {
  LlmError,
  type LlmClient,
  type LlmJsonRequest,
  type LlmRequest,
  type LlmResponse,
} from "./types";

export interface OpenAiLlmOptions {
  apiKey: string;
  model: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface ResponseBody {
  error?: { message?: string } | null;
  output?: { type?: string; content?: { type?: string; text?: string }[] }[];
  output_text?: string;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
}

function outputText(body: ResponseBody): string {
  if (typeof body.output_text === "string") return body.output_text;
  return (body.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((content) => content.type === "output_text" && typeof content.text === "string")
    .map((content) => content.text)
    .join("");
}

/** Direct OpenAI Responses API client. The API key never leaves the server runtime. */
export function createOpenAiLlm(opts: OpenAiLlmOptions): LlmClient {
  const doFetch = opts.fetch ?? fetch;
  const baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const generate = async (
    { system, prompt, signal }: LlmRequest,
    format?: LlmJsonRequest,
  ): Promise<LlmResponse> => {
    const started = Date.now();
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: opts.model,
          store: false,
          instructions: system,
          input: prompt,
          text: {
            verbosity: "low",
            ...(format
              ? {
                  format: {
                    type: "json_schema",
                    name: format.name,
                    strict: true,
                    schema: format.schema,
                  },
                }
              : {}),
          },
          ...(opts.reasoningEffort ? { reasoning: { effort: opts.reasoningEffort } } : {}),
        }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs ?? 120_000)])
          : AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      });
    } catch (error) {
      throw new LlmError(`OpenAI request failed: ${(error as Error).message}`);
    }

    const body = (await response.json().catch(() => ({}))) as ResponseBody;
    if (!response.ok) {
      throw new LlmError(
        `OpenAI returned ${response.status}: ${body.error?.message ?? "request failed"}`,
        response.status,
      );
    }
    const text = outputText(body);
    if (!text) throw new LlmError("OpenAI returned no output text.");
    return {
      text,
      usage: body.usage
        ? {
            inputTokens: body.usage.input_tokens ?? null,
            outputTokens: body.usage.output_tokens ?? null,
          }
        : null,
      model: opts.model,
      ms: Date.now() - started,
    };
  };
  return {
    provider: "openai",
    model: opts.model,
    generateText: (request) => generate(request),
    generateJson: (request) => generate(request, request),
  };
}
