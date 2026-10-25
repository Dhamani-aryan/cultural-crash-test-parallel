import { describe, expect, it, vi } from "vitest";
import { BraveOperationalClient } from "@/lib/operational/brave";
import type { LlmClient } from "@/lib/llm/types";

describe("Brave operational research", () => {
  it("uses bounded searches and requires an official citation for a veto", async () => {
    const doFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return new Response(
        JSON.stringify({
          web: {
            results: [
              {
                title: "Venue official site",
                url: "https://venue.example/events",
                description: "Our 100-capacity nightclub hosts private events.",
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const llm: LlmClient = {
      provider: "fake",
      model: "fake",
      generateText: async (request) => {
        expect(request.system).toContain("adult-entertainment venue");
        expect(request.system).toContain("does not also require a capacity failure");
        return {
          text: JSON.stringify({
            venues: [
              {
                venue: "Venue",
                verdict: "conflicts",
                finding: "Its stated maximum is below the 220-person launch.",
                facts: ["Capacity is 100."],
                sourceIndices: [0],
                officialSourceIndices: [0],
              },
            ],
          }),
          usage: null,
          model: "fake",
          ms: 1,
        };
      },
    };
    const client = new BraveOperationalClient("secret", llm, undefined, doFetch as typeof fetch);
    const result = await client.verifyVenues({
      venues: ["Venue"],
      city: "London",
      brief: {
        productCategory: "audio equipment",
        launchGoal: "220-person listening launch",
        audienceDescription: "music fans",
      },
    });
    expect(result.modelCalls).toBe(1);
    expect(result.checks[0].status).toBe("verified_conflict");
    expect(doFetch).toHaveBeenCalledTimes(1);
    const [input, init] = doFetch.mock.calls[0];
    const query = new URL(String(input)).searchParams.get("q");
    expect(query).toContain('"Venue" "London" official website');
    expect(query).not.toContain("official venue hire");
    expect((init?.headers as Record<string, string>)["X-Subscription-Token"]).toBe("secret");
  });
});
