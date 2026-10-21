import { describe, expect, it } from "vitest";
import { enforceExplicitOrder, parseExplicitPerpOrder } from "@/lib/explicitOrder";
import { validateAndFixStrategy, type LLMStrategy } from "@/lib/strategyIntegrity";

describe("parseExplicitPerpOrder", () => {
  it("reads the order the user typed (French and English)", () => {
    expect(parseExplicitPerpOrder("short ETH levier 2, SL 20% on Hyperliquid")).toEqual({
      side: "Short",
      asset: "ETH",
      leverage: 2,
      stopLossPct: 20,
      stopLossAsTyped: { pct: 20, basis: "price" },
      takeProfitPct: undefined,
      sizeUsd: undefined,
      venue: "Hyperliquid",
    });
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


describe("explicit order on Extended (owner's test: \"open short amd sur extended\")", () => {
  it("keeps the venue and the market the user named", () => {
    const order = parseExplicitPerpOrder("open short amd sur extended");
    expect(order).toMatchObject({ side: "Short", asset: "AMD", venue: "Extended" });
    const hlOnly: LLMStrategy = {
      name: "Short AMD on Hyperliquid",
      risk: "aggressive",
      variantNote: "",
      summary: "",
      legs: [{ side: "Short", asset: "xyz:AMD PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 66, leverage: 5 }],
    };
    // An unfunded Extended account: the order still comes first, saying what is missing.
    const [first, second] = enforceExplicitOrder([hlOnly], order, [], 0);
    expect(first.legs).toEqual([expect.objectContaining({ side: "Short", asset: "AMD PERP", protocol: "Extended" })]);
    // $0 observed and no size given: the size stays unknown rather than invented.
    expect(first.legs[0].sizeUsd).toBeUndefined();
    expect(first.fundingNotes?.[0]).toMatch(/has \$0 free and the wallet has no USDC on Arbitrum to deposit/);
    expect(second).toBe(hlOnly);
    // Funded: sized from the Extended margin, no note.
    const [funded] = enforceExplicitOrder([], order, [], 50);
    expect(funded.fundingNotes).toBeUndefined();
    expect(funded.legs[0].sizeUsd).toBe(39); // ($50 − $1 reserve) × 80% (sizing policy), 1x
    // Balance unknown: no size, and the note says why.
    const [unknown] = enforceExplicitOrder([], order, [], undefined);
    expect(unknown.legs[0].sizeUsd).toBeUndefined();
    expect(unknown.fundingNotes?.[0]).toMatch(/balance is unknown/);
  });

  it("adds a deposit from Arbitrum USDC when the Extended account lacks margin", () => {
    const order = parseExplicitPerpOrder("open short amd sur extended");
    const wallet = [{ symbol: "USDC", venue: "Wallet", chain: "Arbitrum", usd: 60 }];
    // $0 on Extended, $60 USDC on Arbitrum: sized from what can be deposited, the deposit comes first.
    const [s] = enforceExplicitOrder([], order, wallet, 0);
    expect(s.legs.map((l) => [l.side, l.protocol])).toEqual([["Deposit", "Extended"], ["Short", "Extended"]]);
    expect(s.legs[1].sizeUsd).toBe(47); // ($60 − $1 reserve) × 80%, 1x
    expect(s.legs[0].sizeUsd).toBe(50); // margin 47 × 1.03 → 49, plus the $1 reserve for the bridge fee
    expect(s.fundingNotes).toBeUndefined();
    // Unknown Extended balance: no deposit planned (the account must be connected first).
    const [unknown] = enforceExplicitOrder([], order, wallet, undefined);
    expect(unknown.legs.map((l) => l.side)).toEqual(["Short"]);
    // Not enough on Arbitrum for the margin: no deposit, the note says what's missing.
    const [short] = enforceExplicitOrder([], { ...order!, sizeUsd: 500 }, wallet, 0);
    expect(short.legs.map((l) => l.side)).toEqual(["Short"]);
    expect(short.fundingNotes?.[0]).toMatch(/holds \$60 USDC on Arbitrum/);
  });
});


describe("stop-loss convention", () => {
  it("reads a margin-based stop as a price move divided by leverage, and says so", () => {
    const o = parseExplicitPerpOrder("short ETH 2x SL 20% de la marge");
    expect(o).toMatchObject({ stopLossPct: 10, stopLossAsTyped: { pct: 20, basis: "margin" } });
    const [s] = enforceExplicitOrder([], o, [{ symbol: "USDC", venue: "Hyperliquid perps", chain: "Hyperliquid L1", usd: 66 }]);
    expect(s.summary).toContain("stop-loss at a 10% price move (your 20% of margin ÷ 2x)");
  });
});

describe("explicit order on TxFlow", () => {
  it("keeps the order on TxFlow with its stop-loss, and deposits from Arbitrum when short of margin", () => {
    const order = parseExplicitPerpOrder("short ETH 3x sur txflow avec un SL 10%")!;
    expect(order).toMatchObject({ side: "Short", asset: "ETH", venue: "TxFlow", leverage: 3, stopLossPct: 10 });
    const arb = [{ symbol: "USDC", venue: "Wallet", chain: "Arbitrum", usd: 100 }];
    // A Hyperliquid short of the same asset doesn't count: the order comes first on TxFlow.
    const hl = { name: "HL short", risk: "aggressive", summary: "", variantNote: "", legs: [{ side: "Short", asset: "ETH PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 50 }] };
    const [s, alt] = enforceExplicitOrder([hl], order, arb, undefined, 0);
    expect(alt.name).toBe("HL short");
    expect(s.legs.map((l) => [l.side, l.protocol])).toEqual([["Deposit", "TxFlow"], ["Short", "TxFlow"]]);
    expect(s.legs[0].sizeUsd).toBeGreaterThanOrEqual(5);
    expect(s.legs[1]).toMatchObject({ stopLossPct: 10 });
    expect(s.summary).toMatch(/stop-loss at a 10% price move/);
  });

  it("leaves the size unset when the TxFlow balance is unknown", () => {
    const order = parseExplicitPerpOrder("long BTC 2x on TxFlow")!;
    const [s] = enforceExplicitOrder([], order, [], undefined, undefined);
    expect(s.legs).toEqual([expect.objectContaining({ side: "Long", protocol: "TxFlow", sizeUsd: undefined })]);
    expect(s.fundingNotes?.[0]).toMatch(/TxFlow balance couldn't be read/);
  });
});
