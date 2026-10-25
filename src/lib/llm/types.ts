export interface LlmRequest {
  /** System instructions. */
  system: string;
  /** The user message. */
  prompt: string;
  /** Cancels the request (e.g. when the browser disconnects). */
  signal?: AbortSignal;
}

export interface LlmUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface LlmResponse {
  text: string;
  usage: LlmUsage | null;
  model: string;
  ms: number;
}

export interface LlmJsonRequest extends LlmRequest {
  /** Responses API format name: letters, numbers, underscores and dashes only. */
  name: string;
  /** A strict-compatible JSON Schema prepared by `structured.ts`. */
  schema: Record<string, unknown>;
}

/** Provider-agnostic text generation, with optional provider-native JSON Schema output. */
export interface LlmClient {
  readonly provider: string;
  readonly model: string;
  generateText(request: LlmRequest): Promise<LlmResponse>;
  generateJson?(request: LlmJsonRequest): Promise<LlmResponse>;
}

export class LlmError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "LlmError";
    this.status = status;
  }
}
