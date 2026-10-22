import { z } from "zod";
import { SLOTS } from "@/lib/crashtest/types";
import { nameKey } from "@/lib/engine/stats";
import { generateStructured } from "@/lib/llm/structured";
import type { LlmClient } from "@/lib/llm/types";
import { marketById } from "@/lib/markets";
import { infersSensitiveTrait } from "./validate";
import type {
  AudienceHypothesis,
  BriefField,
  FieldOrigin,
  IntakeBrief,
  IntakeState,
} from "./types";

/**
 * The model's two jobs in the intake: read the facts a message states, and suggest audience
 * hypotheses when asked. It sees a compact state and the latest message, never the full
 * transcript, so facts can't drift between turns.
 */

const extractSchema = z.object({
  brandName: z.string(),
  productCategory: z.string(),
  launchGoal: z.string(),
  cityText: z
    .string()
    .describe("a city the message names for the launch, as written; empty if none"),
  audienceDescription: z
    .string()
    .describe("who the launch is for, in the user's words; empty if not stated"),
  audienceAnchors: z
    .array(z.string())
    .describe("brands or artists the user says the audience likes"),
  brandAttributes: z
    .array(z.string())
    .describe("short phrases for the brand's attributes, values, positioning or differentiators"),
  budgetBand: z.string(),
  website: z.string().describe("a website URL if the message gives one"),
  choices: z
    .array(z.object({ slot: z.enum(SLOTS), name: z.string(), locked: z.boolean() }))
    .describe(
      "choices already made (music act, collaboration brand, venue, creative direction); locked if booked/fixed/can't change",
    ),
  exclude: z.array(z.string()).describe("names the user rules out"),
  otherRules: z.array(z.string()).describe("other hard rules, in the user's words"),
});
type Extracted = z.infer<typeof extractSchema>;

const EXTRACT_SYSTEM = `You read one message from someone planning a product launch and pull out only the facts it states. The current brief and the assistant's last question are given for context: if the message answers that question, put the answer in the right field. Use the user's words. Leave a field empty, or a list empty, when the message doesn't state it. Never invent names, audiences, attributes or choices. A launch goal is what kind of launch it is (pop-up, drop, event, campaign). Brand attributes include values, positioning, what makes the product different, and "we want X rather than Y" statements.

A choice is a concrete proposed selection. Capture a named artist introduced tentatively (for example "possibly featuring X" or "considering X") as an unlocked artist choice. Do not turn a music genre, generic concept or activity into a named artist choice. A district, neighbourhood or street is location context, not an event-place choice; only capture event_place when the message names an actual venue or says the place itself is selected. Do not turn ordinary location context into a global hard rule. Put it in otherRules only when the user explicitly says it is mandatory, fixed, required, or the launch must stay there. Mark a choice locked only when the user says it is booked, fixed, signed or can't change.`;

export function compactState(state: IntakeState): string {
  const b = state.brief;
  const lastQuestion =
    [...state.messages].reverse().find((m) => m.role === "assistant")?.text ?? "";
  return JSON.stringify({
    brief: {
      brandName: b.brandName,
      productCategory: b.productCategory,
      launchGoal: b.launchGoal,
      city: b.cityText || b.marketId,
      audience: b.audienceDescription,
      anchors: b.audienceAnchors,
      attributes: b.brandAttributes,
      choices: b.choices,
      exclude: b.exclude,
    },
    lastQuestion: lastQuestion.slice(0, 600),
  });
}

export async function extractFacts(
  llm: LlmClient,
  state: IntakeState,
  message: string,
): Promise<Extracted> {
  const { data } = await generateStructured(llm, {
    schema: extractSchema,
    system: EXTRACT_SYSTEM,
    prompt: `Context:\n${compactState(state)}\n\nMessage:\n"""${message}"""`,
    label: "intake:extract",
  });
  return data;
}

const unionBy = (a: string[], b: string[], cap: number) => {
  const seen = new Set(a.map(nameKey));
  return [
    ...a,
    ...b.map((x) => x.trim()).filter((x) => x && !seen.has(nameKey(x)) && seen.add(nameKey(x))),
  ].slice(0, cap);
};

/**
 * Merge new facts without erasing earlier ones: text fields change only when the message gives
 * a new value, lists grow, a choice for a slot is replaced and keeps a lock once set.
 */
export function mergeFacts(
  brief: IntakeBrief,
  origins: Record<string, FieldOrigin>,
  x: Partial<Extracted>,
): { brief: IntakeBrief; origins: Record<string, FieldOrigin>; changed: BriefField[] } {
  const next = { ...brief };
  const o = { ...origins };
  const changed: BriefField[] = [];
  const setText = (
    k:
      | "brandName"
      | "productCategory"
      | "launchGoal"
      | "cityText"
      | "audienceDescription"
      | "budgetBand"
      | "website",
    v?: string,
  ) => {
    const t = v?.trim();
    if (!t || t === next[k]) return;
    next[k] = t.slice(0, k === "audienceDescription" ? 400 : 200);
    o[k] = "user_supplied";
    changed.push(k);
  };
  setText("brandName", x.brandName);
  setText("productCategory", x.productCategory);
  setText("launchGoal", x.launchGoal);
  setText("cityText", x.cityText);
  setText("audienceDescription", x.audienceDescription);
  setText("budgetBand", x.budgetBand);
  setText("website", x.website);
  const setList = (
    k: "audienceAnchors" | "brandAttributes" | "exclude" | "otherRules",
    v: string[] | undefined,
    cap: number,
  ) => {
    if (!v?.length) return;
    const values =
      k === "brandAttributes" ? v.map((value) => value.trim().slice(0, 120)).filter(Boolean) : v;
    const merged = unionBy(next[k], values, cap);
    if (merged.length === next[k].length) return;
    next[k] = merged;
    o[k] = "user_supplied";
    changed.push(k);
  };
  setList("audienceAnchors", x.audienceAnchors, 4);
  setList("brandAttributes", x.brandAttributes, 8);
  setList("exclude", x.exclude, 10);
  setList("otherRules", x.otherRules, 4);
  for (const c of x.choices ?? []) {
    if (!c.name.trim()) continue;
    const name = c.name.trim().slice(0, 120);
    const prev = next.choices.find((p) => p.slot === c.slot);
    const locked = c.locked || Boolean(prev?.locked && prev.name === name);
    next.choices = [
      ...next.choices.filter((p) => p.slot !== c.slot),
      { slot: c.slot, name, locked },
    ];
    o.choices = "user_supplied";
    if (!changed.includes("choices")) changed.push("choices");
  }
  return { brief: next, origins: o, changed };
}

// ---------- audience hypotheses ----------

const hypothesesSchema = z.object({
  hypotheses: z
    .array(
      z.object({
        label: z.string().describe("short name for the segment, defined by tastes and interests"),
        description: z
          .string()
          .describe("one or two sentences: who they are culturally, what they like"),
        suggestedAnchors: z
          .array(z.string())
          .describe("2-4 real brands or artists this segment likes"),
        assumptions: z.array(z.string()).describe("what you assumed to suggest it"),
      }),
    )
    .describe("2 or 3 segments"),
});

const HYPOTHESES_SYSTEM = `Suggest 2 or 3 broad audience segments a launch could target, defined only by cultural tastes, interests and lifestyle (for example "London skate and independent streetwear fans" or "design-conscious specialty-coffee customers"). Never define or describe a segment by race, ethnicity, religion, sexuality, gender identity, health, disability, political views, immigration status or income. Base them only on the brand and product described. Name 2-4 real brands or artists each segment likes, exactly as written. State your assumptions.`;

export async function suggestAudiences(
  llm: LlmClient,
  brief: IntakeBrief,
): Promise<AudienceHypothesis[]> {
  const city = marketById(brief.marketId)?.label ?? (brief.cityText || "the target city");
  const { data } = await generateStructured(llm, {
    schema: hypothesesSchema,
    system: HYPOTHESES_SYSTEM,
    prompt: JSON.stringify({
      city,
      brand: brief.brandName,
      product: brief.productCategory,
      launch: brief.launchGoal,
      attributes: brief.brandAttributes,
      choices: brief.choices.map((c) => c.name),
    }),
    label: "intake:audiences",
  });
  // Code, not the prompt, is the guarantee: anything describing a sensitive trait is dropped.
  return data.hypotheses
    .filter((h) => !infersSensitiveTrait(`${h.label} ${h.description}`))
    .slice(0, 3)
    .map((h, i) => ({
      id: `H${i + 1}`,
      label: h.label.slice(0, 120),
      description: h.description.slice(0, 400),
      suggestedAnchors: h.suggestedAnchors.slice(0, 4),
      assumptions: h.assumptions.slice(0, 4),
    }));
}
