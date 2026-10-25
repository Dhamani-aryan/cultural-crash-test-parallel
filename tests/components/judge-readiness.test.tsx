import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatApp } from "@/components/chat-app";
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
});
