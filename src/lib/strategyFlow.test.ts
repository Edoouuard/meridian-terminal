import { describe, expect, it } from "vitest";
import { assetsMentioned, ensureAssetFlow, fitToBudget, normalizeAsset, quotedRatePct, removeNegativeCarryLoops, stableBudgetsMentioned, type FlowLeg } from "@/lib/strategyFlow";

const leg = (side: string, asset: string, protocol = "Aave", sizeUsd = 1000): FlowLeg => ({ side, asset, protocol, sizeUsd });

describe("strategyFlow — ensureAssetFlow", () => {
  it("inserts the missing swap when a bridged asset is supplied as a different token", () => {
    const { legs, insertedFor } = ensureAssetFlow(
      [leg("Bridge", "USDC", "deBridge", 5000), leg("Supply", "USDC", "Morpho", 2500), leg("Supply", "GHO", "Aave", 2500)],
      ["USDC"],
    );
    expect(insertedFor).toEqual(["GHO"]);
    expect(legs.map((l) => `${l.side} ${l.asset}`)).toEqual([
      "Bridge USDC",
      "Supply USDC",
      "Swap USDC → GHO",
      "Supply GHO",
    ]);
    expect(legs[2]).toMatchObject({ protocol: "LI.FI", sizeUsd: 2500 });
  });

  it("leaves a coherent strategy untouched", () => {
    const input = [leg("Swap", "USDC → ETH", "LI.FI"), leg("Stake", "stETH", "Lido"), leg("Short", "ETH PERP", "Hyperliquid")];
    const { legs, insertedFor } = ensureAssetFlow(input, ["USDC"]);
    expect(insertedFor).toEqual([]);
    expect(legs).toEqual(input);
  });

  it("treats Lido staking as spending ETH and adds the USDC → ETH swap it needs", () => {
    const { legs } = ensureAssetFlow([leg("Stake", "stETH", "Lido")], ["USDC"]);
    expect(legs.map((l) => `${l.side} ${l.asset}`)).toEqual(["Swap USDC → ETH", "Stake stETH"]);
  });

  it("counts WETH and ETH as the same asset", () => {
    const { insertedFor } = ensureAssetFlow([leg("Supply", "WETH")], ["ETH"]);
    expect(insertedFor).toEqual([]);
  });

  it("counts borrowed and withdrawn assets as held", () => {
    const { insertedFor } = ensureAssetFlow(
      [leg("Supply", "ETH"), leg("Borrow", "USDC"), leg("Supply", "USDC", "Morpho")],
      ["ETH"],
    );
    expect(insertedFor).toEqual([]);
  });

  it("assumes the first spent asset is held when holdings are unknown", () => {
    const { insertedFor } = ensureAssetFlow([leg("Supply", "USDC"), leg("Supply", "DAI")], []);
    expect(insertedFor).toEqual(["DAI"]);
  });

  it("ignores perp legs (margin lives on the venue)", () => {
    const input = [leg("Long", "BTC PERP", "Hyperliquid"), leg("Short", "ETH PERP", "Hyperliquid")];
    expect(ensureAssetFlow(input, ["USDC"]).legs).toEqual(input);
  });
});

describe("strategyFlow — helpers", () => {
  it("normalizes aliases and perp suffixes", () => {
    expect(normalizeAsset("weth")).toBe("ETH");
    expect(normalizeAsset("USDC.e")).toBe("USDC");
    expect(normalizeAsset("ETH PERP")).toBe("ETH");
  });

  it("finds held assets named in the user's request", () => {
    expect(assetsMentioned("I have 5000 USDC on Arbitrum, want ~8%", ["USDC", "GHO", "ETH"])).toEqual(["USDC"]);
    expect(assetsMentioned("stake my eth", ["ETH"])).toEqual(["ETH"]);
  });
});

describe("strategyFlow — fitToBudget", () => {
  it("drops legs that re-spend money already deployed (supply then bridge the same USDC)", () => {
    const { legs, adjustments } = fitToBudget(
      [
        leg("Supply", "USDC", "Morpho", 3000),
        leg("Bridge", "USDC", "deBridge", 3000),
        leg("Swap", "USDC → GHO", "LI.FI", 3000),
        leg("Supply", "GHO", "Aave", 3000),
      ],
      { USDC: 3000 },
    );
    expect(legs.map((l) => `${l.side} ${l.asset} $${l.sizeUsd}`)).toEqual(["Supply USDC $3000"]);
    expect(adjustments).toHaveLength(3);
  });

  it("carries a bridged amount through to the next legs", () => {
    const input = [
      leg("Bridge", "USDC", "deBridge", 5000),
      leg("Supply", "USDC", "Morpho", 2500),
      leg("Swap", "USDC → GHO", "LI.FI", 2500),
      leg("Supply", "GHO", "Aave", 2500),
    ];
    expect(fitToBudget(input, { USDC: 5000 })).toEqual({ legs: input, adjustments: [] });
  });

  it("shrinks an oversized leg to what is left", () => {
    const { legs, adjustments } = fitToBudget([leg("Supply", "USDC", "Aave", 8000)], { USDC: 5000 });
    expect(legs[0].sizeUsd).toBe(5000);
    expect(adjustments[0]).toContain("$8000 to $5000");
  });

  it("counts borrowed funds as spendable", () => {
    const input = [leg("Supply", "ETH", "Aave", 10000), leg("Borrow", "USDC", "Aave", 4000), leg("Supply", "USDC", "Morpho", 4000)];
    expect(fitToBudget(input, { ETH: 10000 }).adjustments).toEqual([]);
  });

  it("leaves assets with unknown amounts alone", () => {
    const input = [leg("Stake", "stETH", "Lido", 7000)];
    expect(fitToBudget(input, { USDC: 100 }).legs).toEqual(input);
  });

  it("does nothing without any known budget", () => {
    const input = [leg("Supply", "USDC", "Aave", 99999)];
    expect(fitToBudget(input, {}).legs).toEqual(input);
  });
});

describe("strategyFlow — stableBudgetsMentioned", () => {
  it("reads stablecoin amounts from the request", () => {
    expect(stableBudgetsMentioned("I have 5,000 USDC on Arbitrum")).toEqual({ USDC: 5000 });
    expect(stableBudgetsMentioned("put 2.5k usdt and 300 DAI to work")).toEqual({ USDT: 2500, DAI: 300 });
  });

  it("ignores volatile assets and bare numbers", () => {
    expect(stableBudgetsMentioned("I hold 3 ETH and want 8% APY")).toEqual({});
  });
});

describe("strategyFlow — removeNegativeCarryLoops", () => {
  const noted = (side: string, asset: string, note: string, sizeUsd = 1500): FlowLeg => ({ side, asset, protocol: "Aave", sizeUsd, note });

  it("drops a loop that borrows dearer than it earns", () => {
    const supply = noted("Supply", "GHO", "Supply GHO to Aave v3 on Base, currently earning 24.39% APY.", 3000);
    const { legs, removed } = removeNegativeCarryLoops([
      supply,
      noted("Borrow", "GHO", "Borrow GHO from Aave v3 on Base at 29.35% APY, using your supplied GHO as collateral."),
      noted("Supply", "GHO", "Re-supply the borrowed GHO to Aave v3 on Base, earning an additional 24.39% APY."),
    ]);
    expect(legs).toEqual([supply]);
    expect(removed[0]).toContain("29.35% to earn 24.39%");
  });

  it("keeps a loop that earns more than it costs", () => {
    const input = [
      noted("Supply", "wstETH", "Currently 3.1% APY", 5000),
      noted("Borrow", "WETH", "Borrow WETH at a rate of 1.9%"),
      noted("Stake", "wstETH", "Currently 3.1% APY"),
    ];
    expect(removeNegativeCarryLoops(input).legs).toEqual(input);
  });

  it("leaves loops alone when a rate isn't quoted", () => {
    const input = [noted("Borrow", "USDC", "Borrow USDC"), noted("Supply", "USDC", "Currently 5% APY")];
    expect(removeNegativeCarryLoops(input).legs).toEqual(input);
  });

  it("reads quoted rates", () => {
    expect(quotedRatePct("Currently 4.23% APY on Ethereum")).toBe(4.23);
    expect(quotedRatePct("at a current borrow rate of 29.35%")).toBe(29.35);
    expect(quotedRatePct("LTV 80%")).toBeNull();
  });
});

describe("strategyFlow — pointless swaps", () => {
  it("drops a swap that buys an asset already held with one that isn't (no circular funding)", () => {
    const { legs, dropped, insertedFor } = ensureAssetFlow(
      [leg("Swap", "USDC → ETH", "Uniswap", 3600), leg("Supply", "WETH", "Aave", 3600), leg("Short", "ETH PERP", "Hyperliquid", 3600)],
      ["ETH"],
    );
    expect(legs.map((l) => `${l.side} ${l.asset}`)).toEqual(["Supply WETH", "Short ETH PERP"]);
    expect(insertedFor).toEqual([]);
    expect(dropped).toHaveLength(1);
  });
});

describe("strategyFlow — LP pairs", () => {
  it("never inserts a swap into an LP pair (WETH-USDC is two tokens, not one asset)", () => {
    const input = [leg("Supply", "USDC", "Aave", 1250), leg("Supply", "WETH-USDC", "Uniswap", 2950)];
    const { legs, insertedFor } = ensureAssetFlow(input, ["USDC", "ETH"]);
    expect(insertedFor).toEqual([]);
    expect(legs).toEqual(input);
    expect(fitToBudget(input, { USDC: 2500, ETH: 1700 }).legs).toEqual(input);
  });
});

describe("strategyFlow — LP entries written as swaps", () => {
  it("treats a swap into an LP pair as an LP leg", () => {
    const input = [leg("Swap", "USDC → WETH-USDC LP", "LI.FI", 2950), leg("Supply", "WETH-USDC LP", "Uniswap", 2950)];
    expect(ensureAssetFlow(input, ["USDC", "ETH"])).toEqual({ legs: input, insertedFor: [], dropped: [] });
    expect(fitToBudget(input, { USDC: 1000 }).legs).toEqual(input);
  });
});

describe("strategyFlow — vault share tokens", () => {
  it("treats a deposit into a Morpho vault token as spending its base asset", () => {
    const input = [leg("Supply", "EDGEUSDC", "Morpho", 2500)];
    expect(ensureAssetFlow(input, ["USDC"])).toEqual({ legs: input, insertedFor: [], dropped: [] });
    expect(fitToBudget(input, { USDC: 1000 }).legs[0].sizeUsd).toBe(1000);
  });

  it("still inserts the swap when the base asset isn't held", () => {
    const { insertedFor } = ensureAssetFlow([leg("Supply", "FCUSDT", "Morpho", 2500)], ["USDC"]);
    expect(insertedFor).toEqual(["USDT"]);
  });

  it("leaves plain tokens on non-vault protocols untouched", () => {
    expect(ensureAssetFlow([leg("Supply", "USDC", "Aave")], ["USDC"]).insertedFor).toEqual([]);
  });
});
