import { describe, expect, it } from "vitest";
import { CARRY_BORROW_SHARE, neutralCarryRows, neutralCarrySummary } from "@/lib/neutralCarry";

const reserves = [
  { symbol: "USDC", supplyApy: 4, borrowApy: 5.5, totalSupplyUsd: 500e6 },
  { symbol: "WETH", supplyApy: 1.8, borrowApy: 2.2, totalSupplyUsd: 900e6 },
  { symbol: "wstETH", supplyApy: 0.1, borrowApy: 0.3, totalSupplyUsd: 400e6 },
  { symbol: "weETH", supplyApy: 0.05, borrowApy: 0.4, totalSupplyUsd: 200e6 },
  // A thinner second market listing USDC again must not win.
  { symbol: "USDC", supplyApy: 9, borrowApy: 10, totalSupplyUsd: 1e6 },
];

describe("neutralCarry", () => {
  it("prices USDC supply plus the borrowed share's staking spread, best LST first", () => {
    const rows = neutralCarryRows("Base", reserves, { WSTETH: 2.7, WEETH: 3.1 }, ["wstETH", "weETH", "rETH"]);
    expect(rows.map((r) => r.lst)).toEqual(["weETH", "wstETH"]);
    const w = rows.find((r) => r.lst === "wstETH")!;
    expect(w.usdcSupplyApy).toBe(4);
    expect(w.edgeApy).toBeCloseTo(CARRY_BORROW_SHARE * (2.7 + 0.1 - 2.2), 2);
    expect(w.netApy).toBeCloseTo(4 + CARRY_BORROW_SHARE * 0.6, 2);
    expect(w.healthFactor).toBeGreaterThan(2);
    expect(w.liquidationRallyPct).toBeGreaterThan(300);
  });

  it("skips an LST Aave doesn't list or without a staking yield", () => {
    expect(neutralCarryRows("Base", reserves, { RETH: 2.5 }, ["rETH"])).toEqual([]);
    expect(neutralCarryRows("Base", reserves, {}, ["wstETH"])).toEqual([]);
  });

  it("says plainly when the carry loses to just supplying USDC", () => {
    const pricey = reserves.map((r) => (r.symbol === "WETH" ? { ...r, borrowApy: 4 } : r));
    const rows = neutralCarryRows("Arbitrum", pricey, { WSTETH: 2.7 }, ["wstETH"]);
    expect(rows[0].edgeApy).toBeLessThan(0);
    expect(neutralCarrySummary(rows)).toMatch(/NOT worth it now/);
  });

  it("writes nothing without rows", () => {
    expect(neutralCarrySummary([])).toBe("");
  });
});
