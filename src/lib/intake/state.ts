import { randomUUID } from "node:crypto";
import type { LlmClient } from "@/lib/llm/types";
import { marketById, TARGET_MARKETS } from "@/lib/markets";
import { extractFacts, mergeFacts, suggestAudiences } from "./extract";
import {
  IntakeBriefSchema,
  IntakeRequestSchema,
  IntakeStateSchema,
  MAX_CLARIFICATION_TURNS,
  MAX_MESSAGES,
  MAX_QUESTIONS,
  type Chip,
  type CriticalField,
  type IntakeReply,
  type IntakeRequest,
  type IntakeState,
} from "./types";
import { MISSING_LABEL, marketFromText, marketsFromText, refresh } from "./validate";

/**
 * The intake state machine. Code owns every transition: what counts as missing, which questions
 * are asked (at most three per turn, in at most four turns), when the brief is confirmed and
 * when a run may start. The model only reads facts and suggests audiences.
 *
 *   START → EXTRACT → VALIDATE → (ask | review) → MERGE ANSWER → VALIDATE → REVIEW → CONFIRM → READY
 */

export function newIntake(marketId = ""): IntakeState {
  return refresh(
    IntakeStateSchema.parse({
      intakeId: randomUUID(),
      brief: IntakeBriefSchema.parse({ marketId }),
    }),
  );
}

const START =
  /^\s*(please\s+)?(start|run|go|begin|launch|generate|yes|yep|ok|okay|sure|do it|let'?s go)\b/i;
/** "That's all I have, figure out the rest." */
const DELEGATE =
  /(figure (it|the rest|out the rest|out)|you (decide|choose|pick|fill)|fill (in )?the rest|that'?s (all|everything)|that is all|good enough|work (it|the rest) out|use your judg|make (it|the rest) up|i don'?t know the rest|whatever you think)/i;
const EXPLORE = /(explore|suggest|try|find) (better|other|alternative)/i;

function say(state: IntakeState, role: "user" | "assistant", text: string): IntakeState {
  const msg = {
    id: `${role[0]}${state.messages.length + 1}`,
    role,
    text,
    createdAt: new Date().toISOString(),
  };
  return { ...state, messages: [...state.messages, msg] };
}

/** Every supported city, the one the brief itself names first (when it names exactly one). */
const cityChips = (sourceText = ""): Chip[] => {
  const named = marketsFromText(sourceText);
  const first = named.length === 1 ? named[0] : null;
  return [...TARGET_MARKETS]
    .sort((a, b) => Number(b.id === first) - Number(a.id === first))
    .map((m) => ({ label: m.label, action: "update_brief" as const, patch: { marketId: m.id, cityText: "" } }));
};

/** "Is the launch in London?" when the brief names exactly one supported city beside an unsupported one. */
const suggestedCity = (sourceText = "") => {
  const named = marketsFromText(sourceText);
  return named.length === 1 ? ` Is the launch in ${marketById(named[0])!.label}?` : "";
};

/** The questions for what's missing, in a fixed order, at most three. */
export function questionsFor(state: IntakeState): {
  lines: string[];
  chips: Chip[];
  asks: CriticalField[];
} {
  const b = state.brief;
  // What the user wrote, so a question can suggest the one supported city they named.
  const said = state.messages.filter((m) => m.role === "user").map((m) => m.text).join(" ");
  const lines: string[] = [];
  const chips: Chip[] = [];
  const asks: CriticalField[] = [];
  for (const f of state.missingCriticalFields) {
    if (asks.length >= MAX_QUESTIONS) break;
    asks.push(f);
    if (f === "cityConflict") {
      const fromText = marketFromText(b.cityText);
      const selected = marketById(b.marketId)?.label ?? b.marketId;
      if (fromText) {
        lines.push(
          `You mention ${b.cityText}, but ${selected} is selected. Which city is the launch in?`,
        );
        chips.push(
          {
            label: `${marketById(fromText)!.label}`,
            action: "update_brief",
            patch: { marketId: fromText, cityText: "" },
          },
          { label: `${selected}`, action: "update_brief", patch: { cityText: "" } },
        );
      } else {
        lines.push(
          `You mention ${b.cityText}, which isn't one of the cities with deep enough Qloo data yet.${suggestedCity(said)} Pick one of ${TARGET_MARKETS.map((m) => m.label).join(", ")}.`,
        );
        chips.push(...cityChips(said));
      }
    } else if (f === "marketId") {
      lines.push(
        b.cityText && !marketFromText(b.cityText)
          ? `You mention ${b.cityText}, which isn't one of the cities with deep enough Qloo data yet.${suggestedCity(said)} Pick one of ${TARGET_MARKETS.map((m) => m.label).join(", ")}.`
          : `Which city is the launch in? Supported: ${TARGET_MARKETS.map((m) => m.label).join(", ")}.`,
      );
      chips.push(...cityChips(said));
    } else if (f === "productCategory") {
      lines.push("What are you launching: the product or category?");
    } else if (f === "launchGoal") {
      lines.push("What kind of launch is it?");
      chips.push(
        { label: "A pop-up", send: "It's a pop-up launch." },
        { label: "A collaboration drop", send: "It's a collaboration drop." },
        { label: "A launch event", send: "It's a launch event." },
      );
    } else if (f === "audience") {
      lines.push(
        b.audienceDescription && state.origins.audienceDescription === "model_suggested"
          ? `Is this the audience: "${b.audienceDescription}"? Confirm it on the brief, or describe your own.`
          : "Who is it for? Describe the audience in your words, or I can suggest a few audience ideas for you to choose from.",
      );
      chips.push({ label: "Suggest audiences", action: "explore_audience" });
    } else if (f === "brandContext") {
      lines.push(
        "What does the brand stand for? A few words on its values, style or what makes it different.",
      );
    }
  }
  return { lines, chips, asks };
}

/** What the assistant says once the brief is complete; the run starts with it. */
export const READY_LINE = "I have enough to test the plan.";

/** The brief in a few lines, shown for transparency as the run starts (not a second confirmation). */
export function summaryText(state: IntakeState): string {
  const b = state.brief;
  const city = marketById(b.marketId)?.label ?? b.marketId;
  const lines = [
    `Here’s the brief I’ll test:`,
    `• ${b.brandName ? `${b.brandName}: ` : ""}${b.productCategory}${b.launchGoal ? `, ${b.launchGoal}` : ""}, in ${city}`,
    `• For: ${b.audienceDescription}${b.audienceAnchors.length ? ` (fans of ${b.audienceAnchors.join(", ")})` : ""}`,
  ];
  if (b.brandAttributes.length) lines.push(`• Brand: ${b.brandAttributes.join(", ")}`);
  if (b.choices.length)
    lines.push(
      `• Your picks: ${b.choices.map((c) => `${c.name}${c.locked ? " (fixed)" : ""}`).join(", ")}`,
    );
  if (b.exclude.length || b.otherRules.length)
    lines.push(`• Rules: ${[...b.exclude.map((x) => `no ${x}`), ...b.otherRules].join("; ")}`);
  if (state.assumptions.length)
    lines.push(`• I assumed: ${state.assumptions.map((x) => x.replace(/\.$/, "")).join("; ")}.`);
  return lines.join("\n");
}

/** Decide the assistant's next message from the (refreshed) state. Pure apart from the text. */
export function respond(
  state: IntakeState,
  opts: { websiteJustGiven?: boolean } = {},
): IntakeState {
  let s = refresh(state);
  const prefix = opts.websiteJustGiven
    ? "I can't open websites here, so I haven't read that one. Paste any About, product or campaign copy that helps. "
    : "";
  if (!s.missingCriticalFields.length) {
    if (
      !s.brief.brandAttributes.length &&
      !s.brief.otherRules.length &&
      !s.assumptions.includes("the brand's character comes from the campaign details provided.")
    )
      s = {
        ...s,
        assumptions: [
          ...s.assumptions,
          "the brand's character comes from the campaign details provided.",
        ].slice(0, 12),
      };
    // Every complete brief stops at the same review point. The user explicitly starts the costly
    // run after reading the extracted fields, and can correct the brief in ordinary language first.
    s = say(
      s,
      "assistant",
      `${prefix}${summaryText(s)}\n\nReview the brief, correct anything that needs changing, then generate the recommendations.`,
    );
    return refresh({
      ...s,
      confirmed: false,
      chips: [{ label: "Generate recommendations", action: "confirm" }],
    });
  }
  if (s.clarificationTurns >= MAX_CLARIFICATION_TURNS) {
    s = say(
      s,
      "assistant",
      `${prefix}I've asked all I'll ask. Still missing: ${s.missingCriticalFields.map((f) => MISSING_LABEL[f].toLowerCase()).join("; ")}. Fill those in on the brief and the test unlocks.`,
    );
    return { ...s, chips: [] };
  }
  const q = questionsFor(s);
  const handOver = s.delegated
    ? ""
    : "\n\nOr say “figure out the rest” and I'll make the assumptions for you.";
  s = say(s, "assistant", prefix + q.lines.join("\n") + handOver);
  return { ...s, chips: q.chips.slice(0, 6), clarificationTurns: s.clarificationTurns + 1 };
}

/**
 * The user handed over what's left. The audience comes from the assistant's first audience
 * idea, the launch and brand character are left to the draft; every one is recorded as an
 * assumption the user sees in the summary. What can't be assumed (product, city) is still asked.
 */
async function fillTheRest(llm: LlmClient, state: IntakeState): Promise<IntakeState> {
  const brief = { ...state.brief };
  const origins = { ...state.origins };
  const assumptions = [...state.assumptions];
  if (brief.audienceDescription.trim().length < 3 && brief.productCategory) {
    const [h] = await suggestAudiences(llm, brief).catch(() => []);
    if (h) {
      brief.audienceDescription = `${h.label}: ${h.description}`.slice(0, 400);
      origins.audienceDescription = "model_suggested";
      if (!brief.audienceAnchors.length && h.suggestedAnchors.length) {
        brief.audienceAnchors = h.suggestedAnchors.slice(0, 4);
        origins.audienceAnchors = "model_suggested";
      }
      assumptions.push(`the audience is "${h.label}" (my suggestion).`);
    }
  }
  if (brief.launchGoal.trim().length < 2) {
    brief.launchGoal = "a launch";
    assumptions.push("a general launch, with the format left open.");
  }
  if (!brief.brandAttributes.length)
    assumptions.push("the brand's character comes from what you've told me.");
  return {
    ...state,
    brief,
    origins,
    assumptions: assumptions.slice(0, 12),
    delegated: true,
    confirmed: false,
  };
}

/** Intake replies never start implicitly; only the explicit confirm action starts the run. */
const replied = (state: IntakeState): IntakeReply => {
  return { state, startRequested: false };
};

export async function applyIntake(llm: LlmClient, input: IntakeRequest): Promise<IntakeReply> {
  const req = IntakeRequestSchema.parse(input);
  // The client's state is data, not truth: re-parse it and recompute everything derived.
  let state = req.state
    ? refresh(IntakeStateSchema.parse(req.state))
    : newIntake(req.marketId ?? "");
  if (req.marketId && marketById(req.marketId) && req.action !== "reset") {
    if (state.brief.marketId !== req.marketId) {
      state = { ...state, brief: { ...state.brief, marketId: req.marketId }, confirmed: false };
    }
  }

  switch (req.action) {
    case "reset":
      return { state: newIntake(req.marketId ?? state.brief.marketId), startRequested: false };

    case "confirm": {
      state = refresh(state);
      if (state.missingCriticalFields.length) return replied(respond(state));
      // The summary the user just saw is the review; confirming starts the run.
      state = refresh({ ...state, confirmed: true });
      return {
        state: {
          ...say(state, "assistant", READY_LINE),
          chips: [],
        },
        startRequested: true,
      };
    }

    case "update_brief": {
      // Only the fields the edit names: schema defaults must not blank the rest of the brief.
      const named = new Set(Object.keys(req.patch ?? {}));
      const parsed = IntakeBriefSchema.partial().parse(req.patch ?? {});
      const patch = Object.fromEntries(
        Object.entries(parsed).filter(([k]) => named.has(k)),
      ) as Partial<IntakeState["brief"]>;
      const origins = { ...state.origins };
      for (const k of Object.keys(patch)) origins[k] = "user_confirmed";
      state = { ...state, brief: { ...state.brief, ...patch }, origins, confirmed: false };
      // A chat answer (a city chip, say) gets a reply like any other turn.
      return replied(respond(state));
    }

    case "explore_audience": {
      const hypotheses = await suggestAudiences(llm, state.brief);
      state = { ...state, mode: "explore_audience", audienceHypotheses: hypotheses };
      state = say(
        state,
        "assistant",
        hypotheses.length
          ? `Here are ${hypotheses.length} audience ideas. They're my suggestions, not findings: pick one (you can edit it after), or describe your own.`
          : "I couldn't suggest audiences from what I have. Describe who it's for in your words.",
      );
      return {
        state: {
          ...state,
          chips: hypotheses.map((h) => ({
            label: h.label,
            action: "select_audience" as const,
            hypothesisId: h.id,
          })),
        },
        startRequested: false,
      };
    }

    case "select_audience": {
      const h = state.audienceHypotheses.find((x) => x.id === req.hypothesisId);
      if (!h) return replied(respond(state));
      const origins: IntakeState["origins"] = {
        ...state.origins,
        audienceDescription: "user_confirmed",
      };
      const brief = {
        ...state.brief,
        audienceDescription: `${h.label}: ${h.description}`.slice(0, 400),
      };
      if (!brief.audienceAnchors.length && h.suggestedAnchors.length) {
        brief.audienceAnchors = h.suggestedAnchors.slice(0, 4);
        origins.audienceAnchors = "model_suggested";
      }
      state = {
        ...state,
        mode: "validate_plan",
        brief,
        origins,
        confirmed: false,
        assumptions: [
          ...state.assumptions,
          ...h.assumptions.map((a) => `Audience idea "${h.label}": ${a}`),
        ].slice(0, 12),
      };
      return replied(respond(state));
    }

    case "message": {
      const text = (req.message ?? "").trim();
      if (!text) return replied(respond(state));
      if (state.messages.length >= MAX_MESSAGES * 2) {
        state = say(
          state,
          "assistant",
          "This conversation is long enough. Edit the brief directly, or start over.",
        );
        return { state, startRequested: false };
      }
      state = say(state, "user", text);
      // "Start the test" runs only when the brief is complete and confirmed.
      // "Go" after the summary confirms and starts; before that, it explains what's missing.
      const summaryShown = state.chips.some((c) => c.action === "confirm");
      if (START.test(text) && text.length < 60 && !DELEGATE.test(text)) {
        const r = refresh(state);
        if (!r.missingCriticalFields.length && summaryShown) {
          const go = refresh({ ...r, confirmed: true });
          return {
            state: {
              ...say(go, "assistant", READY_LINE),
              chips: [],
            },
            startRequested: true,
          };
        }
        if (!r.missingCriticalFields.length) return replied(respond(r));
        const why = `Not yet: I still need ${r.missingCriticalFields.map((f) => MISSING_LABEL[f].toLowerCase()).join("; ")}. Or say "figure out the rest".`;
        return {
          state: { ...say(r, "assistant", why), chips: questionsFor(r).chips },
          startRequested: false,
        };
      }
      const facts = await extractFacts(llm, state, text);
      const merged = mergeFacts(state.brief, state.origins, facts);
      const brief = { ...merged.brief };
      const origins = { ...merged.origins };
      // Deterministic safety nets for facts that are explicit in ordinary conversational phrasing
      // but can occasionally be omitted by structured extraction. These never invent content.
      if (!brief.launchGoal.trim()) {
        const explicitGoal = /\b(?:we(?:'re| are)\s+)?opening\b/i.test(text)
          ? "opening"
          : /\b(?:we(?:'re| are)\s+)?launching\b/i.test(text)
            ? "launch"
            : null;
        if (explicitGoal) {
          brief.launchGoal = explicitGoal;
          origins.launchGoal = "user_supplied";
        }
      }
      if (!brief.brandAttributes.length && !brief.otherRules.length) {
        const statedIntent = text
          .match(/\b(?:we want|we'd like|we would like)\b[^.!?]*(?:[.!?]|$)/i)?.[0]
          ?.trim();
        if (statedIntent) {
          brief.brandAttributes = [statedIntent.slice(0, 120)];
          origins.brandAttributes = "user_supplied";
        }
      }
      // If extraction preserved a district as a rule rather than cityText, recover an otherwise
      // unambiguous supported market from the user's own message. Never guess between two cities.
      const mentionedMarkets = marketsFromText(text);
      if (!brief.marketId && !brief.cityText && mentionedMarkets.length === 1)
        brief.marketId = mentionedMarkets[0];
      // A city the text names becomes the selection when nothing more specific was chosen yet.
      if (merged.changed.includes("cityText")) {
        const m = marketFromText(brief.cityText);
        if (m && (!brief.marketId || m === brief.marketId)) brief.cityText = "";
        if (m && !brief.marketId) brief.marketId = m;
      }
      if (EXPLORE.test(text)) brief.exploreUserChoices = true;
      state = {
        ...state,
        brief,
        origins,
        confirmed: merged.changed.length ? false : state.confirmed,
      };
      if (DELEGATE.test(text)) state = await fillTheRest(llm, state);
      return replied(respond(state, { websiteJustGiven: merged.changed.includes("website") }));
    }
  }
}
