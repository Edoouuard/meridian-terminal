import { describe, expect, it } from "vitest";
import { deployableUsd, fitLegsToBudget, freshCapitalUsd } from "@/lib/budgetFit";
import { validateAndFixStrategy, type LLMLeg } from "@/lib/strategyIntegrity";
import type { TradeLeg } from "@/lib/tradePlan";

const assets = [
  { symbol: "USDC", venue: "Wallet", chain: "Arbitrum", usd: 120 },
  { symbol: "UETH", venue: "Wallet", chain: "HyperEVM", usd: 48 },
  { symbol: "USDC", venue: "Hyperliquid spot", chain: "Hyperliquid L1", usd: 12 },
  { symbol: "USDC", venue: "Hyperliquid perps", chain: "Hyperliquid L1", usd: 24 },
  { symbol: "HYPE", venue: "Hyperliquid staking", chain: "Hyperliquid L1", usd: 400 },
  { symbol: "HLP", venue: "Hyperliquid HLP", chain: "Hyperliquid L1", usd: 150 },
];

describe("deployableUsd", () => {
  it("counts wallet tokens (stETH too), never staked HYPE, HLP or Hyperliquid-account stables", () => {
    expect(deployableUsd(assets)).toBe(168);
    expect(deployableUsd([...assets, { symbol: "stETH", venue: "Lido", chain: "Ethereum", usd: 1000 }])).toBe(1168);
  });
});

describe("freshCapitalUsd", () => {
  it("doesn't count the same money twice along a chain of legs", () => {
    const legs: TradeLeg[] = [
      { side: "Bridge", asset: "USDC", protocol: "deBridge", chain: "Arbitrum", toChain: "Base", sizeUsd: 100 },
      { side: "Supply", asset: "USDC", protocol: "Aave", chain: "Base", sizeUsd: 99 },
    ];
    expect(freshCapitalUsd(legs)).toBe(100);
  });

  it("counts a borrow-funded swap and its supply as free, only the collateral as fresh", () => {
    const legs: TradeLeg[] = [
      { side: "Supply", asset: "USDC", protocol: "Aave", chain: "Base", sizeUsd: 1000 },
      { side: "Borrow", asset: "WETH", protocol: "Aave", chain: "Base", sizeUsd: 450 },
      { side: "Swap", asset: "WETH → wstETH", protocol: "Uniswap", chain: "Base", sizeUsd: 450 },
      { side: "Supply", asset: "wstETH", protocol: "Aave", chain: "Base", sizeUsd: 440 },
    ];
    expect(freshCapitalUsd(legs)).toBe(1000);
  });

  it("needs only the margin of a perp, and none of what the Hyperliquid account already holds", () => {
    const short: TradeLeg = { side: "Short", asset: "ETH PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 300, leverage: 3 };
    expect(freshCapitalUsd([short])).toBe(100);
    expect(freshCapitalUsd([short], 24)).toBe(76);
    const deposit: TradeLeg = { side: "Deposit", asset: "USDC", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 100 };
    expect(freshCapitalUsd([deposit, short])).toBe(100);
  });
});

describe("fitLegsToBudget", () => {
  it("scales every leg by the same factor, keeping a hedge balanced", () => {
    const legs: TradeLeg[] = [
      { side: "Deposit", asset: "USDC", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 1000 },
      { side: "Swap", asset: "USDC → wstETH", protocol: "Uniswap", chain: "Arbitrum", sizeUsd: 2000 },
      { side: "Short", asset: "ETH PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 2000, leverage: 2 },
    ];
    const { legs: out, scaled } = fitLegsToBudget(legs, 300);
    expect(scaled).toBeCloseTo(0.1);
    expect(out.map((l) => l.sizeUsd)).toEqual([100, 200, 200]);
    expect(freshCapitalUsd(out)).toBeLessThanOrEqual(300);
  });

  it("leaves a strategy that fits alone", () => {
    const legs: TradeLeg[] = [{ side: "Supply", asset: "USDC", protocol: "Aave", chain: "Arbitrum", sizeUsd: 100 }];
    expect(fitLegsToBudget(legs, 120)).toEqual({ legs, scaled: 1 });
  });
});

describe("validateAndFixStrategy — the free balance", () => {
  it("sizes an oversized plan to the wallet's free balance and says so", () => {
    const legs: LLMLeg[] = [{ side: "Supply", asset: "USDC", protocol: "Aave", chain: "Arbitrum", sizeUsd: 700 }];
    const out = validateAndFixStrategy({ name: "Yield", risk: "low", variantNote: "", summary: "", legs }, { assets });
    expect(out.legs[0].sizeUsd).toBeCloseTo(168, 1);
    expect(out.fundingNotes?.[0]).toMatch(/\$168 free balance/);
  });

  it("leaves plans alone without a wallet", () => {
    const legs: LLMLeg[] = [{ side: "Supply", asset: "USDC", protocol: "Aave", chain: "Arbitrum", sizeUsd: 10_000 }];
    expect(validateAndFixStrategy({ name: "Yield", risk: "low", variantNote: "", summary: "", legs }).legs[0].sizeUsd).toBe(10_000);
  });
});
