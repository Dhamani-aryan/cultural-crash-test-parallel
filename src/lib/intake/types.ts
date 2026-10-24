import { z } from "zod";
import { SLOTS } from "@/lib/crashtest/types";

/**
 * Conversational intake: a short, bounded conversation whose only job is a confirmed launch
 * brief. The model reads facts out of what the user writes and can suggest audiences; code
 * decides what is missing, what to ask, how many turns are allowed and when a run may start.
 * State lives in the browser and is re-validated by the server on every turn.
 */

export const MAX_MESSAGE = 2000;
export const MAX_MESSAGES = 24;
/** The assistant asks follow-up questions in at most this many turns. */
export const MAX_CLARIFICATION_TURNS = 4;
/** Questions per assistant turn. */
export const MAX_QUESTIONS = 3;

export const FIELD_ORIGINS = ["user_supplied", "model_suggested", "user_confirmed"] as const;
export type FieldOrigin = (typeof FIELD_ORIGINS)[number];

export const ChoiceSchema = z.object({
  slot: z.enum(SLOTS),
  name: z.string().trim().min(1).max(120),
  /** Booked or fixed: the agent may never change it. */
  locked: z.boolean().default(false),
});
export type IntakeChoice = z.infer<typeof ChoiceSchema>;

/** The brief as it is being built. Empty means "not known yet", never a generic default. */
export const IntakeBriefSchema = z.object({
  brandName: z.string().trim().max(80).default(""),
  productCategory: z.string().trim().max(120).default(""),
  launchGoal: z.string().trim().max(200).default(""),
  /** The selected supported city. */
  marketId: z.string().trim().max(40).default(""),
  /** A city named in the text, as written, when it differs from or precedes the selection. */
  cityText: z.string().trim().max(80).default(""),
  audienceDescription: z.string().trim().max(400).default(""),
  audienceAnchors: z.array(z.string().trim().min(1).max(80)).max(4).default([]),
  /** Attributes, values, positioning or differentiators: enough to draft a plan. */
  // Matches LaunchBriefSchema so a brief that passes intake can never fail when the run starts.
  brandAttributes: z.array(z.string().trim().min(1).max(120)).max(8).default([]),
  budgetBand: z.string().trim().max(60).default(""),
  website: z.string().trim().max(200).default(""),
  choices: z.array(ChoiceSchema).max(4).default([]),
  exclude: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
  otherRules: z.array(z.string().trim().min(1).max(200)).max(4).default([]),
  /** Ordinary picks may be tested against stronger alternatives; explicit locks still win. */
  exploreUserChoices: z.boolean().default(true),
});
export type IntakeBrief = z.infer<typeof IntakeBriefSchema>;
export type BriefField = keyof IntakeBrief;

export const IntakeMessageSchema = z.object({
  id: z.string().max(40),
  role: z.enum(["user", "assistant"]),
  text: z.string().max(MAX_MESSAGE * 2),
  createdAt: z.string().max(40),
});
export type IntakeMessage = z.infer<typeof IntakeMessageSchema>;

export const HypothesisSchema = z.object({
  id: z.string().max(20),
  label: z.string().max(120),
  description: z.string().max(400),
  suggestedAnchors: z.array(z.string().max(80)).max(4),
  assumptions: z.array(z.string().max(200)).max(4),
});
export type AudienceHypothesis = z.infer<typeof HypothesisSchema>;

/**
 * A suggested answer the UI shows as a chip. A chip either sends a message, or performs an
 * action (with a brief patch or a hypothesis id) without the model reading it.
 */
export const ChipSchema = z.object({
  label: z.string().max(120),
  send: z.string().max(300).optional(),
  action: z.enum(["select_audience", "explore_audience", "update_brief", "confirm"]).optional(),
  hypothesisId: z.string().max(20).optional(),
  patch: z.record(z.string(), z.unknown()).optional(),
});
export type Chip = z.infer<typeof ChipSchema>;

export const CRITICAL_FIELDS = ["productCategory", "launchGoal", "marketId", "audience", "brandContext", "cityConflict"] as const;
export type CriticalField = (typeof CRITICAL_FIELDS)[number];

export const IntakeStateSchema = z.object({
  intakeId: z.string().max(40),
  mode: z.enum(["validate_plan", "explore_audience"]).default("validate_plan"),
  messages: z.array(IntakeMessageSchema).max(MAX_MESSAGES * 2).default([]),
  brief: IntakeBriefSchema,
  origins: z.record(z.string(), z.enum(FIELD_ORIGINS)).default({}),
  missingCriticalFields: z.array(z.enum(CRITICAL_FIELDS)).default([]),
  assumptions: z.array(z.string().max(300)).max(12).default([]),
  audienceHypotheses: z.array(HypothesisSchema).max(3).default([]),
  chips: z.array(ChipSchema).max(6).default([]),
  clarificationTurns: z.number().int().min(0).max(20).default(0),
  /** The user asked the assistant to fill in what's left; those gaps become stated assumptions. */
  delegated: z.boolean().default(false),
  confirmed: z.boolean().default(false),
  readyToRun: z.boolean().default(false),
});
export type IntakeState = z.infer<typeof IntakeStateSchema>;

export const IntakeRequestSchema = z.object({
  state: IntakeStateSchema.optional(),
  action: z
    .enum(["message", "select_audience", "explore_audience", "update_brief", "confirm", "reset"])
    .default("message"),
  message: z.string().trim().max(MAX_MESSAGE).optional(),
  /** The city selector's value, sent with every turn. */
  marketId: z.string().max(40).optional(),
  hypothesisId: z.string().max(20).optional(),
  /**
   * A direct edit from the brief card, kept raw: parsing it here would fill every field it
   * doesn't name with a default and blank the rest of the brief. It is validated when applied.
   */
  patch: z.record(z.string(), z.unknown()).optional(),
});
export type IntakeRequest = z.input<typeof IntakeRequestSchema>;

export interface IntakeReply {
  state: IntakeState;
  /** The user asked to start and the brief is confirmed and complete. */
  startRequested: boolean;
}
