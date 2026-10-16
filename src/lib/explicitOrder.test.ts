import { describe, expect, it } from "vitest";
import { enforceExplicitOrder, parseExplicitPerpOrder } from "@/lib/explicitOrder";
import { validateAndFixStrategy, type LLMStrategy } from "@/lib/strategyIntegrity";

describe("parseExplicitPerpOrder", () => {
  it("reads the order the user typed (French and English)", () => {
    expect(parseExplicitPerpOrder("short ETH levier 2, SL 20% on Hyperliquid")).toEqual({ side: "Short", asset: "ETH", leverage: 2, stopLossPct: 20, takeProfitPct: undefined, sizeUsd: undefined });
    expect(parseExplicitPerpOrder("long BTC 3x tp 15% stop loss 5% with $50")).toMatchObject({ side: "Long", asset: "BTC", leverage: 3, stopLossPct: 5, takeProfitPct: 15, sizeUsd: 50 });
    expect(parseExplicitPerpOrder("short Tesla x2")).toMatchObject({ side: "Short", asset: "TSLA", leverage: 2 });
    expect(parseExplicitPerpOrder("long gold")).toMatchObject({ side: "Long", asset: "GOLD" });
  });

  it("ignores prompts that aren't orders", () => {
    expect(parseExplicitPerpOrder("best short term yield on my USDC")).toBeNull();
    expect(parseExplicitPerpOrder("bridge mes stables vers Compound")).toBeNull();
  });
});

describe("enforceExplicitOrder", () => {
  const lending: LLMStrategy = { name: "USDC lending", risk: "conservative", variantNote: "", summary: "", legs: [{ side: "Supply", asset: "USDC", protocol: "Aave", chain: "Base", sizeUsd: 67 }] };
  const wallet = [{ symbol: "USDC", venue: "Wallet", chain: "Base", usd: 67 }];

  it("puts the order first when the model answered something else, sized from the wallet", () => {
    const order = parseExplicitPerpOrder("short ETH levier 2, SL 20% on Hyperliquid");
    const [first, second] = enforceExplicitOrder([lending, lending, lending], order, wallet);
    expect(first.legs.map((l) => l.side)).toEqual(["Deposit", "Short"]);
    expect(first.legs[1]).toMatchObject({ asset: "ETH PERP", protocol: "Hyperliquid", leverage: 2, stopLossPct: 20 });
    expect(second.name).toBe("USDC lending");
    // Survives the validator and stays inside the $67.
    const fixed = validateAndFixStrategy(first, { assets: wallet });
    const short = fixed.legs.find((l) => l.side === "Short")!;
    expect(short).toMatchObject({ leverage: 2, stopLossPct: 20 });
    expect(short.sizeUsd! / 2).toBeLessThanOrEqual(67);
    expect(short.sizeUsd!).toBeGreaterThanOrEqual(10);
  });

  it("keeps the model's own version of the order, with the asked leverage and stop-loss, at the top", () => {
    const own: LLMStrategy = { name: "Bearish ETH", risk: "aggressive", variantNote: "", summary: "", legs: [{ side: "Short", asset: "ETH PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 100, leverage: 5 }] };
    const out = enforceExplicitOrder([lending, own], parseExplicitPerpOrder("short ETH 2x sl 20%"), wallet);
    expect(out[0].name).toBe("Bearish ETH");
    expect(out[0].legs[0]).toMatchObject({ leverage: 2, stopLossPct: 20 });
  });
});
