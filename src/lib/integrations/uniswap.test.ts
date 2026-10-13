import { describe, expect, it } from "vitest";
import {
  applySlippage,
  defaultFeeTier,
  FEE_TIER_LOWEST,
  FEE_TIER_STABLE,
  FEE_TIER_STANDARD,
  parseSwapAsset,
  pickBestFeeQuote,
  UNISWAP_SWAP_ROUTER02_BY_CHAIN,
  UNISWAP_QUOTER_V2_BY_CHAIN,
} from "@/lib/integrations/uniswap";

describe("uniswap — defaultFeeTier", () => {
  it("picks the lowest tier for USDC↔USDT (tightest stablecoin pair)", () => {
    expect(defaultFeeTier("USDC", "USDT")).toBe(FEE_TIER_LOWEST);
    expect(defaultFeeTier("usdt", "usdc")).toBe(FEE_TIER_LOWEST);
  });

  it("picks the stable tier for other stable-to-stable pairs", () => {
    expect(defaultFeeTier("dai", "usdc")).toBe(FEE_TIER_STABLE);
    expect(defaultFeeTier("DAI", "USDT")).toBe(FEE_TIER_STABLE);
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
  it("covers all chains where Uniswap v3 is deployed", () => {
    const chains = [1, 8453, 42161, 10, 137, 43114, 56, 42220, 534352, 59144]; // not Mantle (5000) or zkSync (324)
    for (const id of chains) {
      expect(UNISWAP_SWAP_ROUTER02_BY_CHAIN[id]).toBeDefined();
      expect(UNISWAP_QUOTER_V2_BY_CHAIN[id]).toBeDefined();
    }
  });
});

describe("uniswap — pickBestFeeQuote", () => {
  it("keeps the tier with the highest output and skips tiers without a pool", () => {
    expect(
      pickBestFeeQuote([
        { fee: 100, amountOut: undefined },
        { fee: 500, amountOut: BigInt(39_776) },
        { fee: 3000, amountOut: BigInt(39_663) },
        { fee: 10000, amountOut: BigInt(0) },
      ]),
    ).toEqual({ fee: 500, amountOut: BigInt(39_776) });
  });

  it("returns null when no tier quotes", () => {
    expect(pickBestFeeQuote([{ fee: 500, amountOut: undefined }])).toBeNull();
  });
});
