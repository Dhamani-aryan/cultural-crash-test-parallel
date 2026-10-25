import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatApp, RunProgress } from "@/components/chat-app";
import { apiErrorMessage, presentError } from "@/components/error-copy";

describe("judge-ready entry and failures", () => {
  it("offers a prepared example without starting a run", () => {
    const html = renderToStaticMarkup(<ChatApp />);
    expect(html).toContain("Prepared judge example");
    expect(html).toContain("Try the London streetwear example");
    expect(html).toContain("booked venue");
    expect(html).not.toContain("Research progress");
  });

  it("turns common API failures into actionable copy", () => {
    expect(apiErrorMessage("unsupported_city", 400, null, "run")).toMatch(
      /Choose New York, London, Tokyo/,
    );
    expect(apiErrorMessage("qloo_error", 502, "internal detail", "run")).toMatch(
      /no recommendation was finalized/i,
    );
    expect(apiErrorMessage("llm_error", 502, null, "intake")).toMatch(/brief assistant/i);
    expect(presentError("The connection closed before the run finished.")).toMatchObject({
      title: "Connection interrupted",
    });
  });

  it("shows real streamed research activity instead of a generic spinner", () => {
    const html = renderToStaticMarkup(
      <RunProgress
        log={[{ kind: "stage", stage: "evaluate", message: "Testing all three plans" }]}
        evidence={[
          {
            evidenceId: "E1",
            iteration: 0,
            purpose: "Pool music act candidates for this audience in London",
            queryKind: "insights",
            sanitizedRequest: {},
            qlooEntityIds: [],
            results: [],
            resultCount: 12,
            coverageStatus: "usable",
            warnings: [],
            collectedAt: "2026-10-25T00:00:00.000Z",
          },
        ]}
      />,
    );
    expect(html).toContain("Live research activity");
    expect(html).toContain("Testing audience affinity");
    expect(html).toContain("Pool music act candidates for this audience in London");
    expect(html).toContain("12 results");
  });
});
