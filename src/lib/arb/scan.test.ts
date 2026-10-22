import { describe, expect, it } from "vitest";
import { dexPricesFrom, executablePrice, impactPct, perpBaseOf, scanArb, type DexPrice } from "@/lib/arb/scan";
import { extendedQuote, hlQuote } from "@/lib/planner/markets";

const weth: DexPrice = { chainId: 42161, symbol: "WETH", address: "0x82af", decimals: 18, base: "ETH", priceUsd: 2500, liquidityUsd: 50_000_000, dex: "uniswap" };
const hl = (mark: number, aprPct = 10) => hlQuote({ market: "ETH", base: "ETH", markUsd: mark, fundingHourly: aprPct / 100 / 8760, szDecimals: 4, maxLeverage: 25, dayVolumeUsd: 9e8 });

describe("arbitrage scan", () => {
  it("maps wrapped tokens to their perp, and skips stables and LSTs", () => {
    expect(perpBaseOf("WETH")).toBe("ETH");
    expect(perpBaseOf("cbBTC")).toBe("BTC");
    expect(perpBaseOf("ARB")).toBe("ARB");
    expect(perpBaseOf("USDC")).toBeNull();
    expect(perpBaseOf("wstETH")).toBeNull();
  });

  it("perp above the DEX: buy on-chain, short the perp; nets the round trip's costs", () => {
    const [o] = scanArb([weth], [hl(2525)], { sizeUsd: 1000 });
    expect(o.direction).toBe("buy-onchain-short-perp");
    expect(o.gapPct).toBeCloseTo(1, 6);
    // 2 × (0.05% fee + impact) + 2 × $0.05 gas on $1,000 + 2 × 0.045% taker.
    const cost = 2 * (0.05 + impactPct(1000, 50_000_000)) + 0.01 + 0.09;
    expect(o.costPct).toBeCloseTo(cost, 6);
    expect(o.netPct).toBeCloseTo(1 - cost, 6);
    expect(o.netUsd).toBeCloseTo((1 - cost) * 10, 6);
    // The short collects positive funding: 10%/yr ≈ 0.0274%/day.
    expect(o.fundingPctPerDay).toBeCloseTo(10 / 365, 6);
  });

  it("perp below the DEX: sell on-chain, long the perp, which pays the funding", () => {
    const [o] = scanArb([weth], [hl(2490)], { sizeUsd: 1000 });
    expect(o.direction).toBe("sell-onchain-long-perp");
    expect(o.fundingPctPerDay).toBeCloseTo(-10 / 365, 6);
  });

  it("ranks by what is left after costs, and ignores thin pools and quiet perps", () => {
    const ext = extendedQuote({ market: "ETH-USD", base: "ETH", markUsd: 2540, fundingHourly: 0, sizeStep: 0.001, minQty: 0.01, maxLeverage: 50, dayVolumeUsd: 8e7 });
    const r = scanArb([weth, { ...weth, chainId: 8453, liquidityUsd: 10_000 }], [hl(2525), ext], { sizeUsd: 1000 });
    expect(r.map((o) => `${o.venue}@${o.dex.chainId}`)).toEqual(["Extended@42161", "Hyperliquid@42161"]);
    expect(scanArb([weth], [{ ...hl(2525), dayVolumeUsd: 1000 }], { sizeUsd: 1000 })).toEqual([]);
  });

  it("impact grows with the size against the pool", () => {
    expect(impactPct(1000, 2_000_000)).toBeCloseTo(0.0999, 3);
    expect(impactPct(100_000, 2_000_000)).toBeGreaterThan(9);
  });
});

describe("DexScreener prices", () => {
  it("keeps the deepest pool where the token is the base", () => {
    const pairs = [
      { chainId: "arbitrum", dexId: "uniswap", baseToken: { address: "0x82AF" }, priceUsd: "2501", liquidity: { usd: 9e6 } },
      { chainId: "arbitrum", dexId: "camelot", baseToken: { address: "0x82af" }, priceUsd: "2499", liquidity: { usd: 2e7 } },
      { chainId: "arbitrum", dexId: "uniswap", baseToken: { address: "0xaf88" }, priceUsd: "1", liquidity: { usd: 5e7 } },
      { chainId: "base", dexId: "aerodrome", baseToken: { address: "0x82af" }, priceUsd: "2600", liquidity: { usd: 5e7 } },
    ];
    expect(dexPricesFrom(pairs, [{ chainId: 42161, symbol: "WETH", address: "0x82af", decimals: 18 }])).toEqual([
      { chainId: 42161, symbol: "WETH", address: "0x82af", decimals: 18, base: "ETH", priceUsd: 2499, liquidityUsd: 2e7, dex: "camelot" },
    ]);
    expect(dexPricesFrom(null, [])).toEqual([]);
  });

  it("prices a router quote", () => {
    expect(executablePrice(1000, 400_000_000_000_000_000n, 18)).toBe(2500);
    expect(executablePrice(1000, 0n, 18)).toBeNull();
  });
});

describe("arbitrage positions", () => {
  it("makes the gap's change on the quantity, whichever way prices move", async () => {
    const { arbPnlUsd, entryGapPct } = await import("@/lib/arb/positions");
    const p = { id: "1", base: "ETH", chainId: 42161, symbol: "WETH", address: "0x82af", decimals: 18, direction: "buy-onchain-short-perp" as const, qty: 2, venue: "Hyperliquid" as const, market: "ETH", entryDexPx: 2500, entryPerpPx: 2525, openedAt: 0 };
    expect(entryGapPct(p)).toBeCloseTo(1, 9);
    // Both up 100, gap closed from $25 to $0: +$50 on 2 ETH.
    expect(arbPnlUsd(p, 2600, 2600)).toBeCloseTo(50, 9);
    // Gap widened to $40: −$30.
    expect(arbPnlUsd(p, 2400, 2440)).toBeCloseTo(-30, 9);
    expect(arbPnlUsd({ ...p, direction: "sell-onchain-long-perp", entryPerpPx: 2475 }, 2500, 2500)).toBeCloseTo(50, 9);
  });
});
