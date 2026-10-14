import { describe, expect, it } from "vitest";
import { dropFundingMoves, validateAndFixStrategy, type LLMLeg } from "@/lib/strategyIntegrity";

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
    expect(out.legs[0]).toMatchObject({ side: "Swap", asset: "USDC → wstETH", chain: "Arbitrum", sizeUsd: 3000 });
    expect(out.legs[1]).toMatchObject({ side: "Supply", protocol: "Morpho", sizeUsd: 1000 });
    expect(out.legs.reduce((s, l) => s + (l.side === "Short" ? 0 : (l.sizeUsd ?? 0)), 0)).toBe(5000);
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
