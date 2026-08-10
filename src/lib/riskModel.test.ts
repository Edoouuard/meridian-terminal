import { describe, expect, it } from "vitest";
import {
  ethPriceFromAssets,
  netEthDelta,
  roundUsd,
  stakingConcentration,
  suggestConcentrationReduction,
  suggestDeltaHedge,
  suggestHealthFactorRepay,
  type RiskAsset,
} from "@/lib/riskModel";

const assets: RiskAsset[] = [
  { symbol: "ETH", usd: 1000, balance: 0.25 },
  { symbol: "stETH", usd: 2000, balance: 0.5 },
  { symbol: "USDC", usd: 7000, balance: 7000 },
];

describe("riskModel — netEthDelta", () => {
  it("sums tracked ETH-family dollar exposure and divides by price", () => {
    // ETH 1000 + stETH 2000 = 3000 USD exposure at $4000 → 0.75 ETH
    expect(netEthDelta(assets, 4000)).toBeCloseTo(0.75, 10);
  });

  it("returns null when no ETH spot price can be derived", () => {
    expect(netEthDelta(assets, null)).toBeNull();
    expect(netEthDelta(assets, 0)).toBeNull();
    expect(netEthDelta(assets, -1)).toBeNull();
  });

  it("ignores non-ETH assets", () => {
    expect(netEthDelta([{ symbol: "USDC", usd: 7000, balance: 7000 }], 4000)).toBe(0);
  });
});

describe("riskModel — ethPriceFromAssets + stakingConcentration", () => {
  it("derives spot ETH price from a tracked holding", () => {
    expect(ethPriceFromAssets(assets)).toBeCloseTo(4000, 10);
  });

  it("returns null when no tracked holding has balance", () => {
    expect(ethPriceFromAssets([{ symbol: "USDC", usd: 5, balance: 5 }])).toBeNull();
  });

  it("computes stETH+wstETH as a percent of net value", () => {
    const net = assets.reduce((s, a) => s + a.usd, 0); // 10000
    expect(stakingConcentration(assets, net)).toBeCloseTo(20, 10);
  });

  it("returns null for non-positive net value", () => {
    expect(stakingConcentration(assets, 0)).toBeNull();
  });
});

describe("riskModel — health-factor repay suggestion", () => {
  it("sizes a USDC repay that lifts HF toward target", () => {
    const s = suggestHealthFactorRepay(1.5, 10000);
    // HF' = HF*debt/(debt-R); target 1.8 → R = debt*(1 - 1.5/1.8) = 1666.67
    expect(s).not.toBeNull();
    expect(s!.skip).toBe(false);
    expect(s!.target).toBe(1.8);
    expect(s!.repay).toBeCloseTo(10000 * (1 - 1.5 / 1.8), 5);
  });

  it("skips when HF is already safe (>= 1.95)", () => {
    const s = suggestHealthFactorRepay(2.1, 10000);
    expect(s).not.toBeNull();
    expect(s!.skip).toBe(true);
  });

  it("skips when there is no debt", () => {
    const s = suggestHealthFactorRepay(1.5, 0);
    expect(s!.skip).toBe(true);
  });

  it("returns null when no health factor is available", () => {
    expect(suggestHealthFactorRepay(null, 10000)).toBeNull();
  });

  it("skips a repay that is too small to bother with", () => {
    const s = suggestHealthFactorRepay(1.8 - 0.001, 100);
    expect(s!.skip).toBe(true);
  });
});

describe("riskModel — delta hedge + concentration suggestions", () => {
  it("sizes a short hedge for a net-long portfolio", () => {
    // netDelta 2 ETH at $4000 → $8000 → rounds cleanly
    const s = suggestDeltaHedge(2, 4000);
    expect(s).not.toBeNull();
    expect(s!.skip).toBe(false);
    expect(s!.direction).toBe("long");
    expect(s!.shortUsd).toBe(8000);
  });

  it("skips when net delta is already small", () => {
    expect(suggestDeltaHedge(0.05, 4000)!.skip).toBe(true);
  });

  it("returns null without net delta or price", () => {
    expect(suggestDeltaHedge(null, 4000)).toBeNull();
    expect(suggestDeltaHedge(2, null)).toBeNull();
  });

  it("suggests a concentration move toward the 30% target", () => {
    const s = suggestConcentrationReduction(100000, 50);
    expect(s).not.toBeNull();
    expect(s!.skip).toBe(false);
    expect(s!.target).toBe(30);
    expect(s!.amount).toBeCloseTo(100000 * (50 - 30) / 100, 5);
  });

  it("skips concentration outside the acceptable band or too small", () => {
    expect(suggestConcentrationReduction(100000, 10)!.skip).toBe(true);
    expect(suggestConcentrationReduction(1000, 35)!.skip).toBe(true);
  });

  it("returns null when concentration is unavailable", () => {
    expect(suggestConcentrationReduction(100000, null)).toBeNull();
  });

  it("rounds USD to the nearest $50", () => {
    expect(roundUsd(1012)).toBe(1000);
    expect(roundUsd(8050)).toBe(8050);
  });
});