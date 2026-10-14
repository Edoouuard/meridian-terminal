import { describe, expect, it } from "vitest";
import { validateAndFixStrategy, type LLMLeg } from "@/lib/strategyIntegrity";

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

  it("adds the missing spot long to a naked perp short labelled neutral", () => {
    const out = validateAndFixStrategy(
      strat("Neutral funding", [
        { side: "Supply", asset: "USDC", protocol: "Aave", sizeUsd: 3000 },
        { side: "Short", asset: "ETH PERP", protocol: "Hyperliquid", sizeUsd: 3000, leverage: 1 },
      ]),
    );
    expect(out.legs[0]).toMatchObject({ side: "Swap", asset: "USDC → ETH", sizeUsd: 3000 });
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
