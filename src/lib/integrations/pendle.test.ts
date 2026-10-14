import { describe, expect, it } from "vitest";
import { isTrustedPendleRouter, marketNameFromAsset, parsePendleConvert, parsePendleMarkets, pickPendleMarket, pickPendleMarketAcrossChains, PENDLE_ROUTER_V4, type PendleMarket } from "@/lib/integrations/pendle";

const NOW = new Date("2026-10-13T00:00:00Z");
const raw = (name: string, opts: { expiry?: string; liquidity?: number; apy?: number; prime?: boolean; cats?: string[] } = {}) => ({
  name,
  address: "0x" + name.length.toString(16).padStart(40, "a"),
  expiry: opts.expiry ?? "2026-12-31T00:00:00.000Z",
  pt: "1-0x" + "b".repeat(40),
  isPrime: opts.prime ?? true,
  categoryIds: opts.cats ?? ["stables"],
  details: { liquidity: opts.liquidity ?? 5_000_000, impliedApy: opts.apy ?? 0.08 },
});

describe("pendle — parsePendleMarkets", () => {
  it("keeps prime or major-stable, liquid markets with time left, strips the chain prefix, sorts by fixed APY", () => {
    const out = parsePendleMarkets(
      1,
      {
        markets: [
          raw("sUSDe", { apy: 0.05 }),
          raw("sUSDS", { apy: 0.06 }),
          raw("thin", { liquidity: 50_000 }),
          raw("expiring", { expiry: "2026-10-20T00:00:00.000Z" }),
          raw("uncurated", { apy: 0.3, prime: false }),
          raw("USDe", { apy: 0.055, prime: false }), // major stable: kept without the prime flag
          { name: "broken" },
        ],
      },
      NOW,
    );
    expect(out.map((m) => m.name)).toEqual(["sUSDS", "USDe", "sUSDe"]);
    expect(out.find((m) => m.name === "USDe")).toMatchObject({ isPrime: false, majorStable: true });
    expect(out[0]).toMatchObject({ chainId: 1, pt: "0x" + "b".repeat(40), impliedApyPct: 6 });
  });

  it("returns [] for anything unexpected", () => {
    expect(parsePendleMarkets(1, null)).toEqual([]);
    expect(parsePendleMarkets(1, { markets: "nope" })).toEqual([]);
  });
});

describe("pendle — market choice", () => {
  const markets = parsePendleMarkets(
    1,
    { markets: [raw("USDai", { apy: 0.2, prime: false }), raw("sUSDS", { apy: 0.06 }), raw("wstETH", { apy: 0.03, cats: ["eth"] })] },
    NOW,
  );

  it("takes the prime market the plan names, never an uncurated one", () => {
    expect(marketNameFromAsset("PT-sUSDS")).toBe("sUSDS");
    expect(pickPendleMarket(markets, "PT-sUSDS")?.name).toBe("sUSDS");
    // USDai pays more but isn't prime: named or not, it's never offered.
    expect(pickPendleMarket(markets, "PT-USDai")?.name).toBe("sUSDS");
  });

  it("otherwise picks the best prime market of the leg's kind", () => {
    expect(pickPendleMarket(markets, "USDC")?.name).toBe("sUSDS");
    expect(pickPendleMarket(markets, "ETH")?.name).toBe("wstETH");
  });

  it("falls to a major-stable market when no stablecoin market is prime", () => {
    const noPrime = parsePendleMarkets(
      1,
      { markets: [raw("hot", { apy: 0.3, prime: false }), raw("sUSDe", { apy: 0.07, prime: false }), raw("wstETH", { cats: ["eth"] })] },
      NOW,
    );
    expect(pickPendleMarket(noPrime, "USDC")?.name).toBe("sUSDe");
    expect(pickPendleMarket(noPrime, "ETH")?.name).toBe("wstETH");
  });

  it("offers nothing when no market of the kind is prime or a major stable", () => {
    const exotic = parsePendleMarkets(1, { markets: [raw("hot", { apy: 0.3, prime: false }), raw("reUSD", { prime: false })] }, NOW);
    expect(exotic).toEqual([]);
    expect(pickPendleMarket(exotic, "USDC")).toBeUndefined();
  });
});

describe("pendle — parsePendleConvert", () => {
  it("reads the router call, PT out and price impact from Pendle's convert response", () => {
    const q = parsePendleConvert({
      routes: [
        {
          tx: { to: PENDLE_ROUTER_V4, data: "0xc81f847a00", from: "0x1" },
          outputs: [{ token: "0xpt", amount: "100034557502073484859" }],
          data: { priceImpact: -0.0002 },
        },
      ],
    });
    expect(q).toEqual({ tx: { to: PENDLE_ROUTER_V4, data: "0xc81f847a00", value: undefined }, ptOut: "100034557502073484859", priceImpact: -0.0002 });
  });

  it("rejects a response without a usable transaction", () => {
    expect(parsePendleConvert({ routes: [{ tx: { to: PENDLE_ROUTER_V4, data: "not hex" } }] })).toBeNull();
    expect(parsePendleConvert({})).toBeNull();
  });
});

describe("pendle — router allowlist", () => {
  it("trusts only RouterV4 on the wired chains", () => {
    expect(isTrustedPendleRouter(42161, PENDLE_ROUTER_V4.toLowerCase())).toBe(true);
    expect(isTrustedPendleRouter(10, PENDLE_ROUTER_V4)).toBe(false);
    expect(isTrustedPendleRouter(1, "0x" + "1".repeat(40))).toBe(false);
  });
});

describe("pickPendleMarketAcrossChains", () => {
  const mk = (chainId: number, name: string, apy: number, cats: string[] = ["stables"]): PendleMarket => ({
    chainId,
    name,
    address: "0x0000000000000000000000000000000000000001",
    pt: "0x0000000000000000000000000000000000000002",
    expiry: "2027-01-01T00:00:00.000Z",
    impliedApyPct: apy,
    liquidityUsd: 5_000_000,
    isPrime: false,
    majorStable: true,
    categories: cats,
  });

  it("stays on the leg's chain when it has a fitting market", () => {
    const r = pickPendleMarketAcrossChains({ 42161: [mk(42161, "sUSDe", 6)], 1: [mk(1, "sUSDS", 9)] }, "USDC", 42161);
    expect(r).toMatchObject({ moved: false, market: { chainId: 42161, name: "sUSDe" } });
  });

  it("moves to Ethereum when Arbitrum has no eligible market (the live case)", () => {
    const r = pickPendleMarketAcrossChains({ 42161: [], 1: [mk(1, "sUSDS", 4.97), mk(1, "sUSDe", 4.93)], 8453: [mk(8453, "USDC", 7)] }, "PT-sUSDe", 42161);
    expect(r).toMatchObject({ moved: true, market: { chainId: 1, name: "sUSDe" } });
    // No exact name anywhere: best stable on the next chain in order (Ethereum first).
    const any = pickPendleMarketAcrossChains({ 42161: [], 1: [mk(1, "sUSDS", 4.97)], 8453: [mk(8453, "GHO", 7)] }, "USD", 42161);
    expect(any).toMatchObject({ moved: true, market: { chainId: 1 } });
  });

  it("returns nothing when no chain has a market of the kind", () => {
    expect(pickPendleMarketAcrossChains({ 1: [mk(1, "wstETH", 2, ["eth"])] }, "USDC", 42161)).toBeUndefined();
  });
});
