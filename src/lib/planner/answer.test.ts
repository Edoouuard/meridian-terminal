import { describe, expect, it } from "vitest";
import { cleanAnswer, marketSection, wantsAnswer } from "@/lib/planner/answer";

describe("wantsAnswer", () => {
  it("answers market questions in words — the owner's exact message included", () => {
    for (const q of [
      "What to to think about the crypto market?",
      "What to to think about the crypto market? — Market overview only, no plan and no trade",
      "What do you think about the market today?",
      "What's your take on ETH?",
      "Give me a crypto market overview",
      "How is the market doing?",
      "Any news on Bitcoin?",
      "Why is ETH down today?",
      "Qu'en penses-tu du marché ?",
      "Analyse du marché crypto",
      "Show me the best yields, no plan",
    ]) expect(wantsAnswer(q), q).toBe(true);
  });

  it("keeps trade and yield requests on the planner", () => {
    for (const q of [
      "Best yield for my USDC, no lock-up",
      "Short ETH 2x on Hyperliquid, stop-loss 20%",
      "Why not open a long on Hyperliquid and a short on Extended?",
      "What do you think about a long ETH at 5x?",
      "beta neutral en SPCX leverage 10",
      "Stake my ETH with the best liquid staking rate",
    ]) expect(wantsAnswer(q), q).toBe(false);
  });
});

describe("cleanAnswer", () => {
  it("keeps the shape and drops a malformed answer", () => {
    const a = cleanAnswer({ headline: "Mixed", points: ["BTC +1.2%", 3, ""], takeaway: "Stay patient", followUps: ["Best yield for my USDC", "a", "b", "c"] });
    expect(a).toEqual({ headline: "Mixed", points: ["BTC +1.2%"], takeaway: "Stay patient", followUps: ["Best yield for my USDC", "a", "b"] });
    expect(cleanAnswer({ headline: "No points", points: [] })).toBeNull();
    expect(cleanAnswer("text")).toBeNull();
  });
});

describe("marketSection", () => {
  const now = new Date("2026-10-17T09:00:00Z");
  it("lists majors first, the biggest movers, breadth and headlines — never stablecoins", () => {
    const s = marketSection(
      [
        { symbol: "USDC", price: 1, change24h: 0.01 },
        { symbol: "ETH", price: 3012.4, change24h: -2.14 },
        { symbol: "BTC", price: 104250, change24h: 1.05 },
        { symbol: "PEPE", price: 0.0000123, change24h: 12.3 },
      ],
      [{ id: "1", title: "ETF inflows rise", link: "", source: "Reuters", coins: ["BTC"] }],
      now,
    );
    expect(s).toContain("BTC $104,250 (+1.1% 24h) · ETH $3,012 (-2.1% 24h)");
    expect(s).toContain("Biggest movers: PEPE $0.00001230 (+12.3% 24h)");
    expect(s).toContain("Breadth: 2 of 3 tracked coins up over 24h.");
    expect(s).toContain("- ETF inflows rise (Reuters) [BTC]");
    expect(s).not.toContain("USDC");
  });

  it("says when a source is unavailable instead of leaving the model to guess", () => {
    const s = marketSection([], [], now);
    expect(s).toMatch(/Prices: unavailable/);
    expect(s).toMatch(/Headlines: unavailable/);
  });
});
