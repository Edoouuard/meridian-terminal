import { describe, expect, it } from "vitest";
import type { TradePlan } from "@/lib/tradePlan";
import { applyLegConfirmed, deployedUsd, earningLeg, estimatedEarnedUsd, legState, liveSince, matchOpportunity, strategyId, type TrackedStrategy } from "@/lib/strategyTracker";

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
    const notLive = { ...strategy!, completedAt: undefined, legs: strategy!.legs.map((l) => ({ ...l, status: "pending" as const })) };
    expect(estimatedEarnedUsd(notLive, year)).toBeUndefined();
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

  it("is live once the earning step confirms, even if a top-up bridge was never needed", () => {
    // Real case: bridge from BNB Chain (not needed, funds already on Arbitrum), then supply on Morpho.
    const morpho: TradePlan = {
      ...plan,
      variantLabel: "Morpho USDC on Arbitrum",
      sizeUsd: 661,
      legs: [
        { side: "Bridge", asset: "USDC", protocol: "deBridge", chain: "BNB Chain", toChain: "Arbitrum", sizeUsd: 200 } as TradePlan["legs"][number],
        { side: "Supply", asset: "USDC", protocol: "Morpho", chain: "Arbitrum", sizeUsd: 661 } as TradePlan["legs"][number],
      ],
    };
    const res = applyLegConfirmed([], morpho, 1, { hash: "0xb381" }, 1000);
    expect(res.justCompleted).toBe(true);
    expect(res.strategy?.completedAt).toBe(1000);
    expect(legState(res.strategy!, 0)).toBe("skipped");
    expect(legState(res.strategy!, 1)).toBe("confirmed");
    expect(deployedUsd(res.strategy!)).toBe(661);
  });

  it("reads entries stored before the rule as live from their earning step", () => {
    const stored: TrackedStrategy = {
      id: "x",
      title: "Fluid on Base",
      summary: "",
      apyPct: 9.7,
      apyKind: "variable",
      sizeUsd: 3,
      createdAt: 100,
      legs: [
        { side: "Bridge", asset: "USDC", protocol: "deBridge", chain: "Arbitrum", status: "confirmed", hash: "0xab", confirmedAt: 200 },
        { side: "Bridge", asset: "USDC", protocol: "deBridge", chain: "BNB Chain", status: "pending" },
        { side: "Supply", asset: "USDC", protocol: "Fluid", chain: "Base", sizeUsd: 3, status: "confirmed", hash: "0x03", confirmedAt: 300 },
      ],
    };
    expect(liveSince(stored)).toBe(300);
    expect(legState(stored, 1)).toBe("skipped");
    // A strategy whose earning step is still pending is not live, and its moves stay "to do".
    const pending = { ...stored, legs: stored.legs.map((l, i) => (i === 2 ? { ...l, status: "pending" as const, hash: undefined, confirmedAt: undefined } : l)) };
    expect(liveSince(pending)).toBeUndefined();
    expect(legState(pending, 1)).toBe("pending");
  });
});
