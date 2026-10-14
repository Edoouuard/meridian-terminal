import { describe, expect, it } from "vitest";
import { blendedApyFromLegs, defaultStrategyIndex, rateFromNote, strategyView } from "@/lib/strategyView";
import { positionSizeUsd } from "@/lib/intentEngine";
import type { TradePlan } from "@/lib/tradePlan";

const plan = (over: Partial<TradePlan>): TradePlan => ({ intent: "supply", legs: [], summary: "", ...over });

describe("strategyView — rates from leg notes", () => {
  it.each([
    ["Currently 4.80% APY on Base", 4.8],
    ["11.40% fixed until 2027-03-26", 11.4],
    ["APY 3.1% on Arbitrum", 3.1],
    ["Funding +12.3% annualized", 12.3],
    ["~$0.40 fee, ~2 min", undefined],
  ])("%s → %s", (note, rate) => {
    expect(rateFromNote(note)).toBe(rate);
  });

  it("blends by size and ignores the bridge leg", () => {
    expect(
      blendedApyFromLegs([
        { side: "Bridge", asset: "USDC", protocol: "LI.FI", sizeUsd: 5000, note: "0.5% fee APY-free" },
        { side: "Supply", asset: "USDC", protocol: "Aave", sizeUsd: 3000, note: "4% APY" },
        { side: "Supply", asset: "USDC", protocol: "Morpho", sizeUsd: 1000, note: "8% APY" },
      ]),
    ).toBe(5);
  });
});

describe("strategyView — card figures", () => {
  it("prefers the planner's APY, computes yearly earnings, lists chains in order", () => {
    const v = strategyView(
      plan({
        apyPct: 7.2,
        sizeUsd: 5000,
        exit: "Instant",
        legs: [
          { side: "Bridge", asset: "USDC", protocol: "LI.FI", chain: "Base", toChain: "Arbitrum", sizeUsd: 5000 },
          { side: "Supply", asset: "USDC", protocol: "Morpho", chain: "Arbitrum", sizeUsd: 5000, note: "Currently 7.20% APY" },
        ],
      }),
    );
    expect(v).toMatchObject({ apyPct: 7.2, apyKind: "variable", yearlyUsd: 360, chains: ["Base", "Arbitrum"], needsBridge: true, steps: 2, exit: "Instant" });
    expect(v.protocols).toEqual(["LI.FI", "Morpho"]);
  });

  it("marks Pendle as a fixed rate", () => {
    expect(strategyView(plan({ legs: [{ side: "Supply", asset: "PT-sUSDe", protocol: "Pendle", note: "11.4% fixed" }] })).apyKind).toBe("fixed");
  });

  it("opens the planner's pick, else the moderate one", () => {
    const plans = [plan({ riskTier: "conservative" }), plan({ riskTier: "moderate" }), plan({ riskTier: "aggressive" })];
    expect(defaultStrategyIndex(plans, 2)).toBe(2);
    expect(defaultStrategyIndex(plans)).toBe(1);
    expect(defaultStrategyIndex(plans, 9)).toBe(1);
  });
});

describe("intentEngine — position size", () => {
  it("doesn't count money twice when a bridge feeds a deposit", () => {
    expect(
      positionSizeUsd([
        { side: "Bridge", asset: "USDC", protocol: "LI.FI", sizeUsd: 5000 },
        { side: "Supply", asset: "USDC", protocol: "Morpho", sizeUsd: 5000 },
      ]),
    ).toBe(5000);
  });

  it("falls back to the largest leg for a pure move", () => {
    expect(positionSizeUsd([{ side: "Swap", asset: "USDC → ETH", protocol: "Uniswap", sizeUsd: 800 }])).toBe(800);
  });
});
