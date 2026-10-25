import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractJson, generateStructured } from "@/lib/llm/structured";
import type { LlmClient, LlmJsonRequest, LlmRequest } from "@/lib/llm/types";

function scriptedLlm(...replies: string[]) {
  const requests: LlmRequest[] = [];
  const llm: LlmClient = {
    provider: "test",
    model: "test",
    generateText: async (req) => {
      requests.push(req);
      const text = replies.shift();
      if (text === undefined) throw new Error("no more replies");
      return { text, usage: null, model: "test", ms: 1 };
    },
  };
  return { llm, requests };
}

const Schema = z.object({ title: z.string().min(1), sessions: z.number().int().min(1) });

describe("extractJson", () => {
  it("reads plain, fenced and chatty replies", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Here you go:\n```json\n{"a": [1, 2]}\n```')).toEqual({ a: [1, 2] });
    expect(extractJson('Sure! {"a":"brace } inside"} trailing')).toEqual({ a: "brace } inside" });
    expect(() => extractJson("no json here")).toThrow(/no JSON/);
  });
});

describe("generateStructured", () => {
  it("puts the JSON Schema in the system prompt and returns validated data", async () => {
    const { llm, requests } = scriptedLlm('{"title":"Four Nights","sessions":4}');
    const r = await generateStructured(llm, {
      schema: Schema,
      system: "You design programs.",
      prompt: "Make one.",
      label: "test",
    });
    expect(r.data).toEqual({ title: "Four Nights", sessions: 4 });
    expect(r.attempts).toBe(1);
    expect(requests[0].system).toContain('"sessions"');
  });

  it("repairs once using the validation errors", async () => {
    const { llm, requests } = scriptedLlm(
      '{"title":"","sessions":0}',
      '{"title":"Ok","sessions":2}',
    );
    const r = await generateStructured(llm, {
      schema: Schema,
      system: "s",
      prompt: "p",
      label: "test",
    });
    expect(r.attempts).toBe(2);
    expect(requests[1].prompt).toMatch(/failed validation/);
    expect(requests[1].prompt).toMatch(/sessions/);
  });

  it("gives up after two invalid replies", async () => {
    const { llm } = scriptedLlm("not json", '{"title":1}');
    await expect(
      generateStructured(llm, { schema: Schema, system: "s", prompt: "p", label: "plan" }),
    ).rejects.toThrow(/plan: model output failed validation twice/);
  });

  it("uses native strict output and restores optional fields before validation", async () => {
    const requests: LlmJsonRequest[] = [];
    const NativeSchema = z.object({
      title: z.string(),
      note: z.string().optional(),
      tags: z.array(z.string()).default([]),
      nested: z.object({ score: z.number().optional() }),
    });
    const llm: LlmClient = {
      provider: "openai",
      model: "test",
      generateText: async () => {
        throw new Error("text fallback should not run");
      },
      generateJson: async (request) => {
        requests.push(request);
        return {
          text: '{"title":"Launch","note":null,"tags":null,"nested":{"score":null}}',
          usage: null,
          model: "test",
          ms: 1,
        };
      },
    };
    const result = await generateStructured(llm, {
      schema: NativeSchema,
      system: "Return a launch.",
      prompt: "Create it.",
      label: "launch plan/v1",
    });
    expect(result).toMatchObject({
      data: { title: "Launch", tags: [], nested: {} },
      attempts: 1,
    });
    expect(requests[0].name).toBe("launch_plan_v1");
    expect(requests[0].system).toBe("Return a launch.");
    expect(requests[0].schema).toMatchObject({
      type: "object",
      required: ["title", "note", "tags", "nested"],
      additionalProperties: false,
      properties: {
        note: { type: ["string", "null"] },
        tags: { type: ["array", "null"] },
        nested: {
          type: "object",
          required: ["score"],
          additionalProperties: false,
          properties: { score: { type: ["number", "null"] } },
        },
      },
    });
  });
});
