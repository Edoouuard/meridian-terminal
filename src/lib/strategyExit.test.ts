import { describe, expect, it } from "vitest";
import { currentValueUsd, exitPlan, exitTradePlan, positionFor } from "@/lib/strategyExit";
import type { TrackedLeg, TrackedStrategy } from "@/lib/strategyTracker";
import { resolveOrderForLeg } from "@/lib/assetMap";

const leg = (l: Partial<TrackedLeg> & Pick<TrackedLeg, "side" | "asset" | "protocol">, status: TrackedLeg["status"] = "confirmed"): TrackedLeg => ({ status, ...l });
const strat = (legs: TrackedLeg[]): TrackedStrategy => ({ id: "s1", title: "ETH carry", summary: "", apyKind: "variable", createdAt: 0, legs });
const prices = [
  { symbol: "USDC", price: 1 },
  { symbol: "ETH", price: 3000 },
  { symbol: "WETH", price: 3000 },
  { symbol: "WSTETH", price: 3500 },
];

describe("exitPlan", () => {
  it("undoes a leveraged Aave carry last step first: withdraw the LST, swap back, repay, withdraw the collateral", () => {
    const s = strat([
      leg({ side: "Supply", asset: "USDC", protocol: "Aave", chain: "Base", sizeUsd: 1000 }),
      leg({ side: "Borrow", asset: "WETH", protocol: "Aave", chain: "Base", sizeUsd: 500 }),
      leg({ side: "Swap", asset: "WETH → wstETH", protocol: "Uniswap", chain: "Base", sizeUsd: 500 }),
      leg({ side: "Supply", asset: "wstETH", protocol: "Aave", chain: "Base", sizeUsd: 500 }),
    ]);
    const { legs, notes } = exitPlan(s);
    expect(legs.map((l) => `${l.side} ${l.asset} ${l.protocol}`)).toEqual(["Withdraw wstETH Aave", "Swap wstETH → WETH Uniswap", "Repay WETH Aave", "Withdraw USDC Aave"]);
    expect(notes).toEqual([]);
    // Every step resolves to an order Meridian signs.
    for (const l of legs.filter((x) => x.side !== "Swap")) {
      expect(resolveOrderForLeg(l, undefined, prices, 8453)).not.toHaveProperty("unsupported");
    }
  });

  it("vaults withdraw; bridges stay; only confirmed steps are undone", () => {
    const s = strat([
      leg({ side: "Bridge", asset: "USDC", protocol: "deBridge", chain: "Arbitrum", sizeUsd: 200 }),
      leg({ side: "Supply", asset: "USDC", protocol: "Fluid", chain: "Base", sizeUsd: 200 }),
      leg({ side: "Supply", asset: "USDC", protocol: "Spark Savings", chain: "Base", sizeUsd: 50 }, "pending"),
    ]);
    const { legs } = exitPlan(s);
    expect(legs).toHaveLength(1);
    expect(resolveOrderForLeg(legs[0], undefined, prices, 8453)).toMatchObject({ type: "withdraw", protocol: "vault" });
  });

  it("says where to act when Meridian can't undo a step: perps, Pendle PT, sUSDe cooldown, EigenLayer (then Lido)", () => {
    const s = strat([
      leg({ side: "Stake", asset: "ETH", protocol: "Lido", chain: "Ethereum", sizeUsd: 3000 }),
      leg({ side: "Restake", asset: "stETH", protocol: "EigenLayer", chain: "Ethereum", sizeUsd: 3000 }),
      leg({ side: "Supply", asset: "USDe", protocol: "Ethena", chain: "Ethereum", sizeUsd: 100 }),
      leg({ side: "Supply", asset: "PT-sUSDE-27NOV2026", protocol: "Pendle", chain: "Ethereum", sizeUsd: 100 }),
      leg({ side: "Short", asset: "ETH PERP", protocol: "Hyperliquid", sizeUsd: 100 }),
    ]);
    const { legs, notes } = exitPlan(s);
    expect(legs).toEqual([]);
    expect(notes.join(" ")).toMatch(/Risk → Perp positions/);
    expect(notes.join(" ")).toMatch(/held to maturity/);
    expect(notes.join(" ")).toMatch(/7-day cooldown/);
    expect(notes.join(" ")).toMatch(/EigenLayer app/);
    expect(notes.join(" ")).toMatch(/unstake it on Lido/);
    expect(exitTradePlan(s).summary).toMatch(/^Nothing to undo from Meridian/);
  });

  it("Lido stake → unstake request; Hyperliquid deposit and spot buy → sell and withdraw", () => {
    const lido = exitPlan(strat([leg({ side: "Stake", asset: "ETH", protocol: "Lido", chain: "Ethereum", sizeUsd: 3000 })]));
    expect(resolveOrderForLeg(lido.legs[0], undefined, prices, 1)).toMatchObject({ protocol: "lido", type: "unstake" });
    const hl = exitPlan(
      strat([
        leg({ side: "Deposit", asset: "USDC", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 100 }),
        leg({ side: "Buy", asset: "UETH", protocol: "Hyperliquid", sizeUsd: 100 }),
      ]),
    );
    expect(hl.legs.map((l) => `${l.side} ${l.asset} ${l.protocol}`)).toEqual(["Sell UETH Hyperliquid", "Withdraw USDC Hyperliquid"]);
    const plan = exitTradePlan(strat([leg({ side: "Supply", asset: "USDC", protocol: "Fluid", chain: "Base", sizeUsd: 200 })]));
    expect(plan).toMatchObject({ intent: "withdraw", variantLabel: "Exit" });
    expect(plan.summary).toMatch(/^Exit “ETH carry”: 1 step/);
  });
});

describe("currentValueUsd", () => {
  const positions = [
    { symbol: "USDC", venue: "Fluid vault · fUSDC", chain: "Base", usd: 203.1 },
    { symbol: "stETH", venue: "EigenLayer", chain: "Ethereum", usd: 3050 },
  ];
  it("sums the live positions behind every deposit", () => {
    const s = strat([leg({ side: "Bridge", asset: "USDC", protocol: "deBridge", sizeUsd: 200 }), leg({ side: "Supply", asset: "USDC", protocol: "Fluid", chain: "Base", sizeUsd: 200 })]);
    expect(positionFor(s.legs[1], positions)?.usd).toBe(203.1);
    expect(currentValueUsd(s, positions)).toBe(203.1);
    expect(currentValueUsd(strat([leg({ side: "Restake", asset: "stETH", protocol: "EigenLayer", sizeUsd: 3000 })]), positions)).toBe(3050);
  });
  it("is unknown when a deposit's position isn't read (Aave account, perps)", () => {
    expect(currentValueUsd(strat([leg({ side: "Supply", asset: "USDC", protocol: "Aave", chain: "Base", sizeUsd: 100 })]), positions)).toBeUndefined();
    expect(
      currentValueUsd(strat([leg({ side: "Supply", asset: "USDC", protocol: "Fluid", chain: "Base", sizeUsd: 200 }), leg({ side: "Short", asset: "ETH PERP", protocol: "Hyperliquid", sizeUsd: 100 })]), positions),
    ).toBeUndefined();
  });
});

describe("exit tracking", () => {
  it("records exit steps on the strategy it closes (no new entry) and closes it when every step confirmed", async () => {
    const { applyLegConfirmed } = await import("@/lib/strategyTracker");
    const s = strat([leg({ side: "Supply", asset: "USDC", protocol: "Fluid", chain: "Base", sizeUsd: 200 }), leg({ side: "Supply", asset: "USDC", protocol: "Spark Savings", chain: "Base", sizeUsd: 100 })]);
    const plan = exitTradePlan(s);
    expect(plan.exitOf).toBe("s1");
    const r1 = applyLegConfirmed([s], plan, 0, { hash: "0xa", chainId: 8453 }, 10);
    expect(r1.list).toHaveLength(1);
    expect(r1.strategy?.exitLegs?.map((l) => l.status)).toEqual(["confirmed", "pending"]);
    expect(r1.strategy?.closedAt).toBeUndefined();
    const r2 = applyLegConfirmed(r1.list, plan, 1, { hash: "0xb", chainId: 8453 }, 20);
    expect(r2.strategy?.closedAt).toBe(20);
    // Unknown strategy: nothing recorded.
    expect(applyLegConfirmed([], plan, 0, { hash: "0xa" }, 10).changed).toBe(false);
  });
});

describe("Hyperliquid HLP and staked HYPE", () => {
  it("exit notes point to the Hyperliquid app (lock-up / unstaking queue); value now reads the HLP and staking rows", () => {
    const s = strat([
      leg({ side: "Deposit", asset: "HLP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 100 }),
      leg({ side: "Stake", asset: "HYPE", protocol: "Hyperliquid", sizeUsd: 50 }),
    ]);
    const { legs, notes } = exitPlan(s);
    expect(legs).toEqual([]);
    expect(notes.join(" ")).toMatch(/4-day lock-up/);
    expect(notes.join(" ")).toMatch(/7-day unstaking queue/);
    expect(
      currentValueUsd(s, [
        { symbol: "HLP", venue: "Hyperliquid HLP", chain: "Hyperliquid L1", usd: 101.5 },
        { symbol: "HYPE", venue: "Hyperliquid staking", chain: "Hyperliquid L1", usd: 52 },
      ]),
    ).toBe(153.5);
  });
});
