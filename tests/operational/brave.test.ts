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
                conflictKind: "capacity",
                fit: { kind: "suits", area: "not_named", access: "open", note: "" },
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
    expect(result.checks[0].conflictKind).toBe("capacity");
    expect(doFetch).toHaveBeenCalledTimes(1);
    const [input, init] = doFetch.mock.calls[0];
    const query = new URL(String(input)).searchParams.get("q");
    expect(query).toContain('"Venue" "London" official website');
    expect(query).not.toContain("official venue hire");
    expect((init?.headers as Record<string, string>)["X-Subscription-Token"]).toBe("secret");
  });

  it("never vetoes a venue for being in another district than the brief names", async () => {
    const doFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            web: { results: [{ title: "Official", url: "https://venue.example", description: "Events venue in Mitte." }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const llm: LlmClient = {
      provider: "fake",
      model: "fake",
      generateText: async (request) => {
        expect(request.system).toContain("neither is where the venue is");
        return {
          text: JSON.stringify({
            venues: [
              {
                venue: "Venue",
                verdict: "conflicts",
                conflictKind: "none",
                fit: { kind: "suits", area: "outside", access: "open", note: "It is in Mitte." },
                finding: "The brief says Kreuzberg; the venue is in Mitte.",
                facts: [],
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
      city: "Berlin",
      brief: { productCategory: "fashion", launchGoal: "launch night", audienceDescription: "club scene" },
    });
    expect(result.checks[0].status).toBe("unverified");
    // Not a veto, but a cited fit fact the finalists can be compared on.
    expect(result.checks[0].fit).toMatchObject({ area: "outside" });
  });
});
