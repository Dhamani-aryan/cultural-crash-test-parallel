import { z } from "zod";
import { LlmError, type LlmClient, type LlmUsage } from "./types";

/**
 * Structured output on top of any `LlmClient`: the JSON Schema of a Zod schema is placed in
 * the prompt, the reply is parsed and validated, and one repair attempt is made with the
 * validation errors. Provider-agnostic on purpose (the ChatGPT backend has no documented
 * structured-output mode).
 */

export interface StructuredRequest<S extends z.ZodType> {
  schema: S;
  system: string;
  prompt: string;
  /** Short label for logs, e.g. "program". */
  label: string;
}

export interface StructuredResult<T> {
  data: T;
  attempts: number;
  ms: number;
  usage: LlmUsage | null;
}

/** Pull the first JSON object or array out of a reply (handles ```json fences and chatter). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.search(/[[{]/);
  if (start === -1) throw new Error("no JSON found in reply");
  const open = body[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return JSON.parse(body.slice(start, i + 1));
  }
  throw new Error("unterminated JSON in reply");
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 12)
    .map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
}

type JsonSchema = Record<string, unknown>;

const record = (value: unknown): JsonSchema | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonSchema) : null;

function nullable(schema: JsonSchema): JsonSchema {
  if (schema.type === "null") return schema;
  if (typeof schema.type === "string") return { ...schema, type: [schema.type, "null"] };
  if (Array.isArray(schema.type) && schema.type.every((x) => typeof x === "string"))
    return schema.type.includes("null") ? schema : { ...schema, type: [...schema.type, "null"] };
  return { anyOf: [schema, { type: "null" }] };
}

/** Convert Zod's input schema to the strict subset required by Responses Structured Outputs. */
export function strictJsonSchema(input: JsonSchema): JsonSchema {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    const node = record(value);
    if (!node) return value;
    const out: JsonSchema = {};
    for (const [key, child] of Object.entries(node)) {
      if (key === "$schema" || key === "default") continue;
      out[key] = visit(child);
    }
    const properties = record(node.properties);
    if (properties) {
      const originallyRequired = new Set(
        Array.isArray(node.required)
          ? node.required.filter((x): x is string => typeof x === "string")
          : [],
      );
      const strictProperties: JsonSchema = {};
      for (const [key, child] of Object.entries(properties)) {
        const visited = record(visit(child)) ?? {};
        strictProperties[key] = originallyRequired.has(key) ? visited : nullable(visited);
      }
      out.properties = strictProperties;
      out.required = Object.keys(properties);
      out.additionalProperties = false;
    }
    return out;
  };
  return visit(input) as JsonSchema;
}

function dereference(schema: JsonSchema, root: JsonSchema): JsonSchema {
  const ref = typeof schema.$ref === "string" ? schema.$ref : null;
  if (!ref?.startsWith("#/$defs/")) return schema;
  const name = ref.slice("#/$defs/".length).replaceAll("~1", "/").replaceAll("~0", "~");
  return record(record(root.$defs)?.[name]) ?? schema;
}

function matches(value: unknown, schema: JsonSchema): boolean {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (value === null) return types.includes("null");
  if (Array.isArray(value)) return types.includes("array");
  if (typeof value === "object") return types.includes("object") || !!schema.properties;
  return types.includes(typeof value) || schema.type === undefined;
}

/** Native strict output represents optional fields as null; restore omission before Zod parses it. */
export function restoreOptionalFields(value: unknown, schema: JsonSchema): unknown {
  const root = schema;
  const visit = (current: unknown, raw: JsonSchema): unknown => {
    const resolved = dereference(raw, root);
    const alternatives = Array.isArray(resolved.anyOf)
      ? resolved.anyOf.map(record).filter((x): x is JsonSchema => !!x)
      : [];
    const selected = alternatives.find((x) => matches(current, dereference(x, root)));
    if (selected) return visit(current, selected);
    if (Array.isArray(current)) {
      const item = record(resolved.items);
      return item ? current.map((x) => visit(x, item)) : current;
    }
    const object = record(current);
    const properties = record(resolved.properties);
    if (!object || !properties) return current;
    const required = new Set(
      Array.isArray(resolved.required)
        ? resolved.required.filter((x): x is string => typeof x === "string")
        : [],
    );
    const cleaned: JsonSchema = {};
    for (const [key, child] of Object.entries(object)) {
      const property = record(properties[key]);
      if (child === null && property && !required.has(key)) continue;
      cleaned[key] = property ? visit(child, property) : child;
    }
    return cleaned;
  };
  return visit(value, schema);
}

const formatName = (label: string) =>
  label
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "structured_output";

export async function generateStructured<S extends z.ZodType>(
  llm: LlmClient,
  req: StructuredRequest<S>,
): Promise<StructuredResult<z.infer<S>>> {
  const started = Date.now();
  const schema = z.toJSONSchema(req.schema, { io: "input" }) as JsonSchema;
  const jsonSchema = JSON.stringify(schema);
  const native = llm.generateJson;
  const system = native
    ? req.system
    : `${req.system}\n\nReply with ONE JSON value that validates against this JSON Schema, ` +
      `and nothing else (no prose, no code fences):\n${jsonSchema}`;

  let prompt = req.prompt;
  let usage: LlmUsage | null = null;
  let lastProblem = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = native
      ? await native({
          system,
          prompt,
          name: formatName(req.label),
          schema: strictJsonSchema(schema),
        })
      : await llm.generateText({ system, prompt });
    usage = reply.usage;
    let parsed: unknown;
    try {
      parsed = extractJson(reply.text);
    } catch (e) {
      lastProblem = `The reply was not valid JSON (${(e as Error).message}).`;
      prompt = `${req.prompt}\n\nYour previous reply was rejected: ${lastProblem} Reply with JSON only.`;
      continue;
    }
    const result = req.schema.safeParse(native ? restoreOptionalFields(parsed, schema) : parsed);
    if (result.success) {
      return { data: result.data, attempts: attempt, ms: Date.now() - started, usage };
    }
    lastProblem = formatIssues(result.error);
    prompt =
      `${req.prompt}\n\nYour previous reply failed validation:\n${lastProblem}\n` +
      `Previous reply:\n${JSON.stringify(parsed).slice(0, 4000)}\n\nReturn the corrected JSON only.`;
  }
  throw new LlmError(`${req.label}: model output failed validation twice.\n${lastProblem}`);
}
