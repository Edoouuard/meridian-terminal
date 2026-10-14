import { describe, expect, it } from "vitest";
import type { TradePlan } from "@/lib/tradePlan";
import { applyLegConfirmed, earningLeg, estimatedEarnedUsd, matchOpportunity, strategyId } from "@/lib/strategyTracker";

const plan: TradePlan = {
  intent: "supply",
  asset: "USDC",
  sizeUsd: 5000,
  summary: "Bridge USDC to Base and supply it on Morpho.",
  variantLabel: "Morpho on Base",
  apyPct: 6,
  legs: [
    { side: "Bridge", asset: "USDC", protocol: "LI.FI", chain: "Arbitrum", toChain: "Base", sizeUsd: 5000 } as TradePlan["legs"][number],
    { side: "Supply", asset: "USDC", protocol: "Morpho", chain: "Base", sizeUsd: 5000 } as TradePlan["legs"][number],
  ],
};

describe("strategyTracker", () => {
  it("gives the same plan the same id and a different plan another", () => {
    expect(strategyId(plan)).toBe(strategyId({ ...plan, legs: plan.legs.map((l) => ({ ...l })) }));
    expect(strategyId({ ...plan, legs: [plan.legs[1]] })).not.toBe(strategyId(plan));
  });

  it("tracks a strategy from its first step and completes it on the last", () => {
    const first = applyLegConfirmed([], plan, 0, { hash: "0xaa", chainId: 42161, owner: "0xABC" }, 1000);
    expect(first.changed).toBe(true);
    expect(first.justCompleted).toBe(false);
    expect(first.list).toHaveLength(1);
    expect(first.strategy).toMatchObject({ title: "Morpho on Base", owner: "0xabc", apyPct: 6, sizeUsd: 5000, completedAt: undefined });
    expect(first.strategy?.legs.map((l) => l.status)).toEqual(["confirmed", "pending"]);

    const second = applyLegConfirmed(first.list, plan, 1, { hash: "0xbb", chainId: 8453 }, 2000);
    expect(second.justCompleted).toBe(true);
    expect(second.strategy?.completedAt).toBe(2000);
    expect(second.list).toHaveLength(1);

    // The same confirmation again changes nothing and doesn't celebrate twice.
    const again = applyLegConfirmed(second.list, plan, 1, { hash: "0xbb", chainId: 8453 }, 3000);
    expect(again.changed).toBe(false);
    expect(again.justCompleted).toBe(false);
  });

  it("a single-step strategy is live on its only confirmation", () => {
    const single = { ...plan, legs: [plan.legs[1]] };
    expect(applyLegConfirmed([], single, 0, { hash: "0x1" }, 5).justCompleted).toBe(true);
  });

  it("estimates earnings since going live at the entry APY", () => {
    const { strategy } = applyLegConfirmed([], { ...plan, legs: [plan.legs[1]] }, 0, { hash: "0x1" }, 0);
    const year = 365 * 24 * 3600 * 1000;
    expect(estimatedEarnedUsd(strategy!, year / 2)).toBeCloseTo(150, 5);
    expect(estimatedEarnedUsd({ ...strategy!, completedAt: undefined }, year)).toBeUndefined();
  });

  it("finds today's rate for the earning leg, skipping the bridge", () => {
    const { strategy } = applyLegConfirmed([], plan, 0, { hash: "0xaa" }, 0);
    expect(earningLeg(strategy!)?.protocol).toBe("Morpho");
    const opps = [
      { protocol: "Morpho", chain: "Arbitrum", symbol: "USDC", apy: 9 },
      { protocol: "Morpho", chain: "Base", symbol: "USDC", apy: 5.2 },
    ];
    expect(matchOpportunity(strategy!, opps)?.apy).toBe(5.2);
    expect(matchOpportunity(strategy!, [{ protocol: "Aave", chain: "Base", symbol: "USDC", apy: 4 }])).toBeUndefined();
  });
});
