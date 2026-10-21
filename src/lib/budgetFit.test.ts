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
    // $168 in the wallet + the $36 of USDC on Hyperliquid, withdrawn first (minus its $1 fee).
    expect(out.legs[0]).toMatchObject({ side: "Withdraw", protocol: "Hyperliquid", sizeUsd: 36 });
    expect(out.legs[1].sizeUsd).toBeCloseTo(203, 1);
    expect(out.fundingNotes?.[0]).toMatch(/\$203 free balance/);
  });

  it("leaves plans alone without a wallet", () => {
    const legs: LLMLeg[] = [{ side: "Supply", asset: "USDC", protocol: "Aave", chain: "Arbitrum", sizeUsd: 10_000 }];
    expect(validateAndFixStrategy({ name: "Yield", risk: "low", variantNote: "", summary: "", legs }).legs[0].sizeUsd).toBe(10_000);
  });
});

describe("validateAndFixStrategy — stables in the Hyperliquid account", () => {
  const wallet = [
    { symbol: "USDC", venue: "Wallet", chain: "Base", usd: 0.2 },
    { symbol: "USDC", venue: "Hyperliquid perps", chain: "Hyperliquid L1", usd: 69 },
  ];
  const supply: LLMLeg = { side: "Supply", asset: "USDC", protocol: "Fluid", chain: "Base", sizeUsd: 69 };

  it("withdraws them to Arbitrum first, and sizes the strategy to what arrives", () => {
    const out = validateAndFixStrategy({ name: "Fluid USDC", risk: "low", variantNote: "", summary: "", legs: [supply] }, { assets: wallet });
    expect(out.legs[0]).toMatchObject({ side: "Withdraw", asset: "USDC", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 69 });
    // $0.20 in the wallet + $69 out of Hyperliquid minus its $1 fee.
    expect(out.legs[1].sizeUsd).toBeCloseTo(68.2, 1);
  });

  it("leaves a perp strategy alone: the account's USDC is its margin", () => {
    const short: LLMLeg = { side: "Short", asset: "ETH PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 60, leverage: 1 };
    const out = validateAndFixStrategy({ name: "Short", risk: "high", variantNote: "", summary: "", legs: [short] }, { assets: wallet });
    expect(out.legs.some((l) => l.side === "Withdraw")).toBe(false);
  });

  it("clamps a planned withdrawal to what the account holds", () => {
    const planned: LLMLeg = { side: "Withdraw", asset: "USDC", protocol: "Hyperliquid", chain: "Hyperliquid", sizeUsd: 500 };
    const out = validateAndFixStrategy({ name: "Fluid USDC", risk: "low", variantNote: "", summary: "", legs: [planned, supply] }, { assets: wallet });
    expect(out.legs[0]).toMatchObject({ chain: "Arbitrum", sizeUsd: 69 });
    expect(out.legs.filter((l) => l.side === "Withdraw")).toHaveLength(1);
  });
});

describe("Hyperliquid spot buys", () => {
  it("are paid from the Hyperliquid account, with the short's margin", async () => {
    const { isHlSpotBuyLeg } = await import("@/lib/budgetFit");
    const buy = { side: "Buy", asset: "UETH", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 31 };
    const short = { side: "Short", asset: "ETH PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 31, leverage: 1 };
    expect(isHlSpotBuyLeg(buy)).toBe(true);
    expect(isHlSpotBuyLeg(short)).toBe(false);
    expect(isHlSpotBuyLeg({ ...buy, asset: "ETH PERP" })).toBe(false);
    expect(freshCapitalUsd([buy, short], 66)).toBe(0);
    expect(freshCapitalUsd([buy, short], 40)).toBeCloseTo(22, 6);
  });
});

describe("TxFlow legs", () => {
  it("never draw their margin from Hyperliquid or the wallet (the TxFlow account or its deposit leg funds them)", () => {
    const perp = { side: "Short", asset: "ETH-USDC PERP", protocol: "TxFlow", chain: "Arbitrum", sizeUsd: 300, leverage: 3 } as TradeLeg;
    expect(freshCapitalUsd([perp], 500)).toBe(0);
  });

  it("deposit from Arbitrum whatever chain the model wrote", () => {
    const fixed = validateAndFixStrategy(
      { name: "x", risk: "moderate", summary: "", variantNote: "", legs: [{ side: "Deposit", asset: "USDC", protocol: "TxFlow", chain: "Base", sizeUsd: 20 } as LLMLeg] },
      { assets: [{ symbol: "USDC", venue: "Wallet", chain: "Arbitrum", usd: 100 }] },
    );
    expect(fixed.legs[0].chain).toBe("Arbitrum");
  });
});
