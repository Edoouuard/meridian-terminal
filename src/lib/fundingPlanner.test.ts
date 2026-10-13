import { describe, expect, it } from "vitest";
import { fundPlan, spentSymbol, type FundingDeps } from "@/lib/fundingPlanner";
import type { TradeLeg, TradePlan } from "@/lib/tradePlan";

const plan = (...legs: TradeLeg[]): TradePlan => ({ intent: "unknown", legs, summary: "" });
const supply = (chain: string, sizeUsd: number, protocol = "Aave", asset = "USDC"): TradeLeg => ({ side: "Supply", asset, protocol, chain, sizeUsd });

function deps(assets: FundingDeps["assets"], opts: Partial<FundingDeps> = {}): FundingDeps {
  return {
    assets,
    bridgeCostUsd: async () => 0.5,
    apyFor: async () => null,
    ...opts,
  };
}

describe("fundingPlanner — spentSymbol", () => {
  it("names the token a leg spends on its chain", () => {
    expect(spentSymbol({ side: "Supply", asset: "ETH", protocol: "Aave" }, 8453)).toBe("WETH");
    expect(spentSymbol({ side: "Stake", asset: "stETH", protocol: "Lido" }, 1)).toBe("ETH");
    expect(spentSymbol({ side: "Swap", asset: "USDC → ETH", protocol: "Uniswap" }, 8453)).toBe("USDC");
    expect(spentSymbol({ side: "Borrow", asset: "USDC", protocol: "Aave" }, 8453)).toBeNull();
  });
});

describe("fundingPlanner — fundPlan", () => {
  it("leaves a leg the wallet can already fund", async () => {
    const p = plan(supply("Base", 100));
    const out = await fundPlan(p, deps([{ symbol: "USDC", chain: "Base", usd: 150 }]));
    expect(out).toBe(p);
  });

  it("adds a bridge from where the funds are and sizes the leg to what arrives", async () => {
    const out = await fundPlan(plan(supply("Base", 100)), deps([{ symbol: "USDC", chain: "Arbitrum", usd: 500 }]));
    expect(out.legs).toHaveLength(2);
    expect(out.legs[0]).toMatchObject({ side: "Bridge", asset: "USDC", chain: "Arbitrum", toChain: "Base", sizeUsd: 100 });
    expect(out.legs[1]).toMatchObject({ side: "Supply", chain: "Base", sizeUsd: 98.5 }); // 100 bridged − 1% fee buffer − 0.5% margin
    expect(out.fundingNotes?.[0]).toMatch(/bridge was added/);
  });

  it("only bridges the shortfall when the target chain holds part of it", async () => {
    const out = await fundPlan(plan(supply("Base", 100)), deps([{ symbol: "USDC", chain: "Base", usd: 40 }, { symbol: "USDC", chain: "Optimism", usd: 500 }]));
    expect(out.legs[0]).toMatchObject({ side: "Bridge", chain: "Optimism", sizeUsd: 60 });
    expect(out.legs[1].sizeUsd).toBe(98.9);
  });

  it("stays on the source chain when the extra yield wouldn't repay the bridge in time", async () => {
    // $100 at +0.2% APY earns ~$0.05 in 90 days — far below a $0.50 bridge.
    const apyFor = async (_p: string, _s: string, chain: string) => (chain === "Base" ? 5.2 : 5.0);
    const out = await fundPlan(plan(supply("Base", 100)), deps([{ symbol: "USDC", chain: "Arbitrum", usd: 500 }], { apyFor }));
    expect(out.legs).toHaveLength(1);
    expect(out.legs[0]).toMatchObject({ side: "Supply", chain: "Arbitrum", sizeUsd: 100 });
    expect(out.fundingNotes?.[0]).toMatch(/moved to Arbitrum.*days to pay that back/);
  });

  it("bridges when the extra yield repays it within the window", async () => {
    // $10,000 at +2% APY earns ~$49 in 90 days — well above a $3 bridge.
    const apyFor = async (_p: string, _s: string, chain: string) => (chain === "Base" ? 7 : 5);
    const out = await fundPlan(plan(supply("Base", 10_000)), deps([{ symbol: "USDC", chain: "Arbitrum", usd: 20_000 }], { apyFor, bridgeCostUsd: async () => 3 }));
    expect(out.legs.map((l) => l.side)).toEqual(["Bridge", "Supply"]);
  });

  it("sizes a leg down to the chain's balance when there's nothing to bridge from", async () => {
    const out = await fundPlan(plan(supply("Base", 100)), deps([{ symbol: "USDC", chain: "Base", usd: 12.345 }]));
    expect(out.legs).toHaveLength(1);
    expect(out.legs[0].sizeUsd).toBe(12.28); // keeps a 0.5% margin so price drift can't overshoot the balance
    expect(out.fundingNotes?.[0]).toMatch(/sized down to \$12\.28/);
  });

  it("says so when the wallet holds none of the token anywhere", async () => {
    const out = await fundPlan(plan(supply("Base", 100)), deps([{ symbol: "ETH", chain: "Base", usd: 300 }]));
    expect(out.legs[0].sizeUsd).toBe(100);
    expect(out.fundingNotes?.[0]).toMatch(/holds no USDC on Base/);
  });

  it("spends running balances across legs, and credits an existing bridge to its destination", async () => {
    const out = await fundPlan(
      plan(
        { side: "Bridge", asset: "USDC", protocol: "deBridge", chain: "Arbitrum", toChain: "Base", sizeUsd: 200 },
        supply("Base", 150),
      ),
      deps([{ symbol: "USDC", chain: "Arbitrum", usd: 250 }]),
    );
    expect(out.legs).toHaveLength(2);
    expect(out.fundingNotes).toBeUndefined();
  });

  it("never bridges from or to a chain without a verified router", async () => {
    const out = await fundPlan(plan(supply("Avalanche", 100)), deps([{ symbol: "USDC", chain: "Arbitrum", usd: 500 }]));
    expect(out.legs.map((l) => l.side)).toEqual(["Supply"]);
    expect(out.fundingNotes?.[0]).toMatch(/holds no USDC on Avalanche \(and Meridian can.t bridge into Avalanche\)/);
  });

  it("swaps another stable on the same chain when the leg's stable isn't held anywhere", async () => {
    const out = await fundPlan(plan(supply("Base", 100)), deps([{ symbol: "USDT", chain: "Base", usd: 300 }]));
    expect(out.legs).toHaveLength(2);
    expect(out.legs[0]).toMatchObject({ side: "Swap", asset: "USDT → USDC", protocol: "Uniswap", chain: "Base", sizeUsd: 100 });
    expect(out.legs[1]).toMatchObject({ side: "Supply", sizeUsd: 98.5 });
    expect(out.fundingNotes?.[0]).toMatch(/swap was added/);
  });

  it("swaps and bridges in one route from another chain's stable", async () => {
    const out = await fundPlan(plan(supply("Base", 100)), deps([{ symbol: "DAI", chain: "Optimism", usd: 300 }]));
    expect(out.legs[0]).toMatchObject({ side: "Bridge", fromAsset: "DAI", asset: "USDC", chain: "Optimism", toChain: "Base", sizeUsd: 100 });
    expect(out.fundingNotes?.[0]).toMatch(/swaps it to USDC and bridges it to Base/);
  });

  it("prefers moving the same stable over converting another one", async () => {
    const out = await fundPlan(
      plan(supply("Base", 100)),
      deps([{ symbol: "USDT", chain: "Base", usd: 300 }, { symbol: "USDC", chain: "Arbitrum", usd: 300 }]),
    );
    expect(out.legs[0]).toMatchObject({ side: "Bridge", asset: "USDC", chain: "Arbitrum" });
    expect(out.legs[0].fromAsset).toBeUndefined();
  });

  it("never converts a volatile asset to fund a stable leg", async () => {
    const out = await fundPlan(plan(supply("Base", 100)), deps([{ symbol: "WETH", chain: "Base", usd: 5000 }]));
    expect(out.legs.map((l) => l.side)).toEqual(["Supply"]);
  });

  it("credits a swapping bridge with the token it delivers", async () => {
    const out = await fundPlan(
      plan({ side: "Bridge", asset: "USDC", fromAsset: "USDT", protocol: "deBridge", chain: "Arbitrum", toChain: "Base", sizeUsd: 200 }, supply("Base", 150)),
      deps([{ symbol: "USDT", chain: "Arbitrum", usd: 250 }]),
    );
    expect(out.legs).toHaveLength(2);
    expect(out.fundingNotes).toBeUndefined();
    expect(spentSymbol(out.legs[0], 42161)).toBe("USDT");
  });
});
