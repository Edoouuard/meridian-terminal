import { describe, expect, it } from "vitest";
import { isTrustedPendleRouter, marketNameFromAsset, parsePendleConvert, parsePendleMarkets, pickPendleMarket, PENDLE_ROUTER_V4 } from "@/lib/integrations/pendle";

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
  it("keeps prime, liquid markets with time left, strips the chain prefix, sorts by fixed APY", () => {
    const out = parsePendleMarkets(
      1,
      {
        markets: [
          raw("sUSDe", { apy: 0.05 }),
          raw("sUSDS", { apy: 0.06 }),
          raw("thin", { liquidity: 50_000 }),
          raw("expiring", { expiry: "2026-10-20T00:00:00.000Z" }),
          raw("uncurated", { apy: 0.3, prime: false }),
          { name: "broken" },
        ],
      },
      NOW,
    );
    expect(out.map((m) => m.name)).toEqual(["sUSDS", "sUSDe"]);
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

  it("offers nothing when no market of the kind is prime", () => {
    const noPrime = parsePendleMarkets(
      1,
      { markets: [raw("hot", { apy: 0.3, prime: false }), raw("deep", { apy: 0.07, prime: false, liquidity: 9_000_000 }), raw("wstETH", { cats: ["eth"] })] },
      NOW,
    );
    expect(pickPendleMarket(noPrime, "USDC")).toBeUndefined();
    expect(pickPendleMarket(noPrime, "ETH")?.name).toBe("wstETH");
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
