import { describe, expect, it } from "vitest";
import {
  applySlippage,
  defaultFeeTier,
  FEE_TIER_STABLE,
  FEE_TIER_STANDARD,
  parseSwapAsset,
  UNISWAP_SWAP_ROUTER02_BY_CHAIN,
  UNISWAP_QUOTER_V2_BY_CHAIN,
} from "@/lib/integrations/uniswap";

describe("uniswap — defaultFeeTier", () => {
  it("picks the stable tier for a stable-to-stable pair", () => {
    expect(defaultFeeTier("USDC", "USDT")).toBe(FEE_TIER_STABLE);
    expect(defaultFeeTier("dai", "usdc")).toBe(FEE_TIER_STABLE);
  });

  it("picks the standard tier for any pair involving a non-stable asset", () => {
    expect(defaultFeeTier("USDC", "WETH")).toBe(FEE_TIER_STANDARD);
    expect(defaultFeeTier("WETH", "wstETH")).toBe(FEE_TIER_STANDARD);
  });
});

describe("uniswap — applySlippage", () => {
  it("applies the default 0.5% tolerance", () => {
    expect(applySlippage(1_000_000n)).toBe(995_000n);
  });

  it("applies a custom tolerance", () => {
    expect(applySlippage(1_000_000n, 100)).toBe(990_000n); // 1%
    expect(applySlippage(1_000_000n, 0)).toBe(1_000_000n); // no slippage
  });

  it("floors rather than rounds up (never overstates the minimum)", () => {
    // 999 * 9950 / 10000 = 994.005 -> floors to 994
    expect(applySlippage(999n)).toBe(994n);
  });

  it("returns 0 for a non-positive quoted amount", () => {
    expect(applySlippage(0n)).toBe(0n);
    expect(applySlippage(-5n)).toBe(0n);
  });

  it("falls back to the default tolerance for an invalid slippageBps", () => {
    expect(applySlippage(1_000_000n, -1)).toBe(995_000n);
    expect(applySlippage(1_000_000n, 10_000)).toBe(995_000n);
    expect(applySlippage(1_000_000n, NaN)).toBe(995_000n);
  });
});

describe("uniswap — parseSwapAsset", () => {
  it("parses an arrow-separated swap leg asset", () => {
    expect(parseSwapAsset("USDC → wstETH")).toEqual({ from: "USDC", to: "wstETH" });
  });

  it("trims surrounding whitespace on both sides", () => {
    expect(parseSwapAsset("  ETH  →  USDC  ")).toEqual({ from: "ETH", to: "USDC" });
  });

  it("returns null when there is no arrow", () => {
    expect(parseSwapAsset("USDC")).toBeNull();
    expect(parseSwapAsset("")).toBeNull();
  });
});

describe("uniswap — address tables", () => {
  it("covers every chain Meridian tracks for Aave (mainnet, base, arbitrum, optimism, polygon, avalanche)", () => {
    const chains = [1, 8453, 42161, 10, 137, 43114];
    for (const id of chains) {
      expect(UNISWAP_SWAP_ROUTER02_BY_CHAIN[id]).toBeDefined();
      expect(UNISWAP_QUOTER_V2_BY_CHAIN[id]).toBeDefined();
    }
  });
});
