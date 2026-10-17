import { afterEach, describe, expect, it, vi } from "vitest";
import { routeThesisAsync, threadHistory } from "@/lib/intentEngine";

afterEach(() => vi.unstubAllGlobals());

describe("routeThesisAsync — a question answered in words", () => {
  it("shows the market read with no plan and no fallback notice, and the conversation remembers it", async () => {
    const answer = { headline: "Mixed: BTC holds while ETH lags.", points: ["BTC +1.1% over 24h"], takeaway: "Yields beat chasing price.", followUps: ["Best yield for my USDC, no lock-up"] };
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ decision: "answer", understanding: "Your read of the market.", answer, strategies: [] })));
    const item = await routeThesisAsync("What do you think about the crypto market?");
    expect(item.answer).toEqual(answer);
    expect(item.plan).toBeUndefined();
    expect(item.notice).toBeUndefined();
    expect(threadHistory([item])).toEqual([{ request: "What do you think about the crypto market?", answer: "Answered: Mixed: BTC holds while ETH lags." }]);
  });
});

describe("routeThesisAsync — the market read fails", () => {
  it("says so plainly, never a local-rules trade plan", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "The market answer came back malformed" }), { status: 500 }));
    const item = await routeThesisAsync("What to to think about the crypto market?");
    expect(item.plan).toBeUndefined();
    expect(item.notice).toMatch(/market read is unavailable right now/);
    expect(item.notice).not.toMatch(/basic plan/);
  });
});
