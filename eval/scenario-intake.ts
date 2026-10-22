/**
 * Run realistic natural-language scenarios through conversational intake without calling Qloo.
 *
 *   npm run scenario:intake
 *
 * Writes eval/out/scenario-intake.json for inspection. Unsupported cities stay unsupported: the
 * runner records the resulting question instead of silently changing the user's market.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { getLlm } from "../src/lib/llm";
import { applyIntake } from "../src/lib/intake/state";
import { marketById } from "../src/lib/markets";
import { SCENARIOS } from "./scenario-cases";

const llm = getLlm();
const rows = [];

for (const scenario of SCENARIOS) {
  process.stdout.write(`${scenario.id} … `);
  try {
    const reply = await applyIntake(llm, { action: "message", message: scenario.prompt });
    let state = reply.state;
    if (scenario.delegateMissing && state.missingCriticalFields.length) {
      state = (
        await applyIntake(llm, {
          action: "message",
          message: "That's all the information I have. Figure out the rest.",
          state,
        })
      ).state;
    }
    const assistant = [...state.messages].reverse().find((m) => m.role === "assistant")?.text ?? "";
    const market = marketById(state.brief.marketId);
    const row = {
      id: scenario.id,
      title: scenario.title,
      brief: state.brief,
      origins: state.origins,
      missing: state.missingCriticalFields,
      readyForReview: state.missingCriticalFields.length === 0,
      supportedMarket: market?.label ?? null,
      assistant,
      state,
      error: null,
    };
    rows.push(row);
    console.log(
      `${row.supportedMarket ?? "unsupported market"}; missing ${row.missing.join(", ") || "none"}`,
    );
  } catch (error) {
    rows.push({
      id: scenario.id,
      title: scenario.title,
      error: error instanceof Error ? error.message : String(error),
    });
    console.log(`ERROR ${error}`);
  }
}

mkdirSync("eval/out", { recursive: true });
const file = "eval/out/scenario-intake.json";
writeFileSync(
  file,
  JSON.stringify({ ranAt: new Date().toISOString(), model: llm.model, rows }, null, 2),
);
console.log(`wrote ${file}`);
