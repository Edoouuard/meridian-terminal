import { describe, expect, it } from "vitest";
import { belowMinimum, dropBelowMinimum, dropFundingMoves, inferBridgeSource, validateAndFixStrategy, type LLMLeg } from "@/lib/strategyIntegrity";

const strat = (name: string, legs: LLMLeg[]) => ({ name, risk: "moderate", variantNote: "", summary: "Earns the spread, beta-neutral.", legs });

describe("strategyIntegrity — neutral strategies", () => {
  it("accepts a spot-only borrow hedge as neutral and leaves its sizes alone", () => {
    const legs: LLMLeg[] = [
      { side: "Supply", asset: "USDC", protocol: "Aave", sizeUsd: 2000 },
      { side: "Borrow", asset: "WETH", protocol: "Aave", sizeUsd: 900 },
      { side: "Swap", asset: "WETH → wstETH", protocol: "Uniswap", sizeUsd: 900 },
      { side: "Supply", asset: "wstETH", protocol: "Aave", sizeUsd: 890 },
    ];
    const out = validateAndFixStrategy(strat("Beta-neutral wstETH carry", legs));
    expect(out.name).toBe("Beta-neutral wstETH carry");
    expect(out.legs).toEqual(legs);
  });

  it("doesn't add a spot buy to a borrow hedge whose borrowed asset stays in the wallet", () => {
    const legs: LLMLeg[] = [
      { side: "Supply", asset: "USDC", protocol: "Aave", sizeUsd: 2000 },
      { side: "Borrow", asset: "ETH", protocol: "Aave", sizeUsd: 900 },
    ];
    expect(validateAndFixStrategy(strat("Neutral ETH", legs)).legs).toHaveLength(2);
  });

  it("still balances a perp hedge and treats wstETH as ETH exposure", () => {
    const out = validateAndFixStrategy(
      strat("Delta-neutral staking", [
        { side: "Swap", asset: "USDC → wstETH", protocol: "Uniswap", sizeUsd: 5000 },
        { side: "Short", asset: "ETH PERP", protocol: "Hyperliquid", sizeUsd: 4000, leverage: 1 },
      ]),
    );
    expect(out.legs.map((l) => l.sizeUsd)).toEqual([5000, 5000]);
  });

  it("adds the missing spot long to a naked perp short labelled neutral, paid from the stable leg", () => {
    const out = validateAndFixStrategy(
      strat("Neutral funding", [
        { side: "Supply", asset: "USDC", protocol: "Morpho", chain: "Arbitrum", sizeUsd: 4000 },
        { side: "Deposit", asset: "USDC", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 1000 },
        { side: "Short", asset: "ETH PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 3000, leverage: 3 },
      ]),
    );
    // The spot buy sits right before the short, after the steps that bring its USDC.
    expect(out.legs[0]).toMatchObject({ side: "Supply", protocol: "Morpho", sizeUsd: 1000 });
    expect(out.legs[2]).toMatchObject({ side: "Swap", asset: "USDC → wstETH", chain: "Arbitrum", sizeUsd: 3000 });
    expect(out.legs[3]).toMatchObject({ side: "Short" });
    expect(out.legs.reduce((s, l) => s + (l.side === "Short" ? 0 : (l.sizeUsd ?? 0)), 0)).toBe(5000);
  });

  it("resizes an added hedge to the budget: notional = budget × L / (L + 1)", () => {
    const out = validateAndFixStrategy(
      strat("Neutral ETH perp hedge", [
        { side: "Supply", asset: "USDC", protocol: "Aave", chain: "Base", sizeUsd: 2500 },
        { side: "Deposit", asset: "USDC", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 2500 },
        { side: "Short", asset: "ETH PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 5000, leverage: 2 },
      ]),
    );
    const size = (side: string) => out.legs.find((l) => l.side === side)?.sizeUsd;
    expect(size("Swap")).toBe(3333);
    expect(size("Short")).toBe(3333);
    expect(size("Deposit")).toBe(1667);
    expect(out.legs.find((l) => l.side === "Supply")).toBeUndefined();
  });

  it("keeps a stablecoin-only strategy labelled neutral as it is", () => {
    const out = validateAndFixStrategy(strat("Market-neutral stables", [{ side: "Supply", asset: "USDC", protocol: "Fluid", sizeUsd: 2500 }]));
    expect(out.name).toBe("Market-neutral stables");
  });

  it("relabels a 'neutral' strategy with no short side as directional", () => {
    const out = validateAndFixStrategy(strat("Neutral yield", [{ side: "Stake", asset: "stETH", protocol: "Lido", sizeUsd: 1000 }]));
    expect(out.name).toMatch(/Directional/);
  });

  it("doesn't count a stablecoin borrow as a hedge", () => {
    const out = validateAndFixStrategy(
      strat("Neutral loop", [
        { side: "Supply", asset: "wstETH", protocol: "Aave", sizeUsd: 1000 },
        { side: "Borrow", asset: "USDC", protocol: "Aave", sizeUsd: 400 },
      ]),
    );
    expect(out.name).toMatch(/Directional/);
  });
});

describe("strategyIntegrity — funding moves", () => {
  it("drops the planner's own stablecoin bridges and the swap before a Pendle buy", () => {
    const legs: LLMLeg[] = [
      { side: "Bridge", asset: "USDC", protocol: "deBridge", chain: "Base", toChain: "Ethereum", sizeUsd: 4000 },
      { side: "Swap", asset: "USDC → USDS", protocol: "Uniswap", chain: "Ethereum", sizeUsd: 5000 },
      { side: "Supply", asset: "PT-sUSDS", protocol: "Pendle", chain: "Ethereum", sizeUsd: 5000 },
    ];
    expect(dropFundingMoves(legs)).toEqual([legs[2]]);
  });

  it("keeps a swap that is the position itself and a move-only strategy", () => {
    const carry: LLMLeg[] = [
      { side: "Borrow", asset: "WETH", protocol: "Aave", chain: "Base", sizeUsd: 900 },
      { side: "Swap", asset: "WETH → wstETH", protocol: "Uniswap", chain: "Base", sizeUsd: 900 },
      { side: "Supply", asset: "wstETH", protocol: "Aave", chain: "Base", sizeUsd: 880 },
    ];
    expect(dropFundingMoves(carry)).toEqual(carry);
    const bridgeOnly: LLMLeg[] = [{ side: "Bridge", asset: "USDC", protocol: "deBridge", chain: "Base", toChain: "Arbitrum", sizeUsd: 100 }];
    expect(dropFundingMoves(bridgeOnly)).toEqual(bridgeOnly);
  });
});

describe("strategyIntegrity — swaps where Meridian has no DEX", () => {
  it("turns a swap on HyperEVM into a swapping bridge to where the strategy goes next", () => {
    const legs: LLMLeg[] = [
      { side: "Swap", asset: "UETH → USDC", protocol: "Uniswap", chain: "HyperEVM", sizeUsd: 48 },
      { side: "Swap", asset: "USDC → wstETH", protocol: "Uniswap", chain: "Arbitrum", sizeUsd: 25 },
    ];
    const [first, second] = validateAndFixStrategy({ name: "Yield", risk: "moderate", variantNote: "", summary: "", legs }).legs;
    expect(first).toMatchObject({ side: "Bridge", fromAsset: "UETH", asset: "USDC", chain: "HyperEVM", toChain: "Arbitrum", sizeUsd: 48 });
    expect(second).toEqual(legs[1]);
  });

  it("sells UETH on Hyperliquid spot when nothing needs the USDC on another chain", () => {
    const legs: LLMLeg[] = [{ side: "Swap", asset: "UETH → USDC", protocol: "Uniswap", chain: "HyperEVM", sizeUsd: 48 }];
    const [only] = validateAndFixStrategy({ name: "Sell", risk: "low", variantNote: "", summary: "", legs }).legs;
    expect(only).toMatchObject({ side: "Sell", asset: "UETH", protocol: "Hyperliquid", chain: "HyperEVM", sizeUsd: 48 });
  });

  it("names what a HyperEVM bridge spends: the token in its note, else the wallet's holding there", () => {
    const bridge: LLMLeg = { side: "Bridge", asset: "USDC", protocol: "deBridge", chain: "HyperEVM", toChain: "Arbitrum", sizeUsd: 48 };
    const ctx = { assets: [{ symbol: "UETH", venue: "Wallet", chain: "HyperEVM", usd: 48 }, { symbol: "USDC", venue: "Wallet", chain: "Arbitrum", usd: 900 }] };
    expect(inferBridgeSource([bridge], ctx)[0]).toMatchObject({ fromAsset: "UETH", asset: "USDC" });
    expect(inferBridgeSource([{ ...bridge, note: "Sells your UBTC on the way" }], ctx)[0]).toMatchObject({ fromAsset: "UBTC" });
    // Nothing to infer from: left as it was.
    expect(inferBridgeSource([bridge])[0]).toEqual(bridge);
    // A bridge of a token the source chain tracks needs nothing.
    const arb: LLMLeg = { ...bridge, chain: "Arbitrum", toChain: "Base" };
    expect(inferBridgeSource([arb], ctx)[0]).toEqual(arb);
  });

  it("counts UETH as ETH exposure, so a UETH holder's short is a real hedge", () => {
    const out = validateAndFixStrategy(
      strat("Neutral ETH", [
        { side: "Supply", asset: "UETH", protocol: "Wallet", chain: "HyperEVM", sizeUsd: 48 },
        { side: "Short", asset: "ETH PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 48, leverage: 1 },
      ]),
    );
    expect(out.legs.some((l) => l.side === "Swap")).toBe(false);
  });
});

describe("strategyIntegrity — the user's wallet", () => {
  const short = (sizeUsd: number): LLMLeg => ({ side: "Short", asset: "ETH PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd, leverage: 1 });
  const deposit = (sizeUsd: number): LLMLeg => ({ side: "Deposit", asset: "USDC", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd });

  it("hedges a UETH holding with the short alone: no spot buy added", () => {
    const out = validateAndFixStrategy(strat("Neutral UETH hedge", [deposit(24), short(24)]), {
      assets: [{ symbol: "UETH", venue: "Wallet", chain: "HyperEVM", usd: 48 }],
    });
    expect(out.legs.some((l) => l.side === "Swap")).toBe(false);
  });

  it("drops the deposit when the Hyperliquid account already holds the margin, tops up otherwise", () => {
    const hl = (usd: number) => ({ assets: [{ symbol: "USDC", venue: "Hyperliquid perps", chain: "Hyperliquid L1", usd }] });
    expect(validateAndFixStrategy({ name: "ETH short", risk: "aggressive", variantNote: "", summary: "", legs: [deposit(24), short(24)] }, hl(30)).legs.map((l) => l.side)).toEqual(["Short"]);
    const topUp = validateAndFixStrategy({ name: "ETH short", risk: "aggressive", variantNote: "", summary: "", legs: [deposit(50), short(50)] }, hl(30)).legs;
    // $50 of margin + 3% for the order's fees buffer, minus the $30 already there.
    expect(topUp[0]).toMatchObject({ side: "Deposit", sizeUsd: 22 });
  });

  it("delivers USDC when a bridge would bring a token the destination doesn't track (BNB to Arbitrum)", () => {
    const out = validateAndFixStrategy({
      name: "ETH short",
      risk: "aggressive",
      variantNote: "",
      summary: "",
      legs: [{ side: "Bridge", asset: "BNB", protocol: "deBridge", chain: "BNB Chain", toChain: "Arbitrum", sizeUsd: 10 }, deposit(10), short(10)],
    });
    expect(out.legs[0]).toMatchObject({ side: "Bridge", fromAsset: "BNB", asset: "USDC", toChain: "Arbitrum" });
  });
});

describe("strategyIntegrity — neutral with the money on Hyperliquid (owner's test, 2026-10-16)", () => {
  // $1 of POL in the wallet, $66 of USDC in the Hyperliquid account.
  const wallet = {
    assets: [
      { symbol: "POL", venue: "Wallet", chain: "Polygon", usd: 1 },
      { symbol: "USDC", venue: "Hyperliquid perps", chain: "Hyperliquid L1", usd: 66 },
    ],
  };
  const s = (legs: LLMLeg[]) => ({ name: "Hyperliquid ETH Neutral", risk: "low", variantNote: "", summary: "Beta-neutral ETH.", legs });

  it("buys the long side on Hyperliquid spot with the account's USDC, not on Uniswap with wallet funds", () => {
    const out = validateAndFixStrategy(s([{ side: "Short", asset: "ETH PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 66, leverage: 1 }]), wallet);
    expect(out.legs.map((l) => `${l.side} ${l.asset} ${l.protocol}`)).toEqual(["Buy UETH Hyperliquid", "Short ETH PERP Hyperliquid"]);
    const [buy, short] = out.legs;
    expect(buy.sizeUsd).toBe(short.sizeUsd);
    // N spot + N margin (with fees) fits in the $66.
    expect(buy.sizeUsd! * (1 + 1.03)).toBeLessThanOrEqual(66);
    expect(buy.sizeUsd).toBeGreaterThanOrEqual(30);
    expect(belowMinimum(out)).toBeNull();
  });

  it("fits a planned UETH buy + short that overspends the account", () => {
    const out = validateAndFixStrategy(
      s([
        { side: "Buy", asset: "UETH", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 66 },
        { side: "Short", asset: "ETH PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 66, leverage: 1 },
      ]),
      wallet,
    );
    const [buy, short] = out.legs;
    expect(buy.sizeUsd).toBe(short.sizeUsd);
    expect(buy.sizeUsd! + short.sizeUsd!).toBeLessThanOrEqual(67);
    expect(buy.sizeUsd).toBeGreaterThan(30);
  });

  it("drops the $1 strategies Hyperliquid can't execute", () => {
    const tiny = s([
      { side: "Bridge", asset: "POL", protocol: "deBridge", chain: "Polygon", toChain: "Arbitrum", sizeUsd: 1 },
      { side: "Short", asset: "ETH PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 1, leverage: 1 },
    ]);
    const good = s([
      { side: "Buy", asset: "UETH", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 31 },
      { side: "Short", asset: "ETH PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 31, leverage: 1 },
    ]);
    expect(belowMinimum(tiny)).toMatch(/Hyperliquid's minimum order is \$10|under the \$5/);
    expect(dropBelowMinimum([tiny, good])).toEqual([good]);
    // Nothing executable: keep them, saying why.
    const kept = dropBelowMinimum([tiny]);
    expect(kept).toHaveLength(1);
    expect(kept[0].fundingNotes?.[0]).toMatch(/^Too small to execute/);
    // An explicit order stays first, annotated.
    expect(dropBelowMinimum([tiny, good], true).map((x) => x.legs.length)).toEqual([2, 2]);
  });
});
