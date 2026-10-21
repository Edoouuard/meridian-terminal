import { describe, expect, it } from "vitest";
import { crossVenueFunding, crossVenueSummary, extendedSummary, marketBase, parseExtendedMarketRows } from "@/lib/perpVenues";

// Shape of Extended's GET /api/v1/info/markets (mainnet, 2026-10-16), trimmed.
const RAW = [
  { name: "ETH-USD", category: "Crypto", active: true, status: "ACTIVE", marketStats: { markPrice: "2470.28", fundingRate: "0.000013", dailyVolume: "72885736" }, tradingConfig: { maxLeverage: "50.00" } },
  { name: "AMD_24_5-USD", category: "RWA", active: true, status: "ACTIVE", marketStats: { markPrice: "543.2", fundingRate: "0.00001", dailyVolume: "1500000" }, tradingConfig: { maxLeverage: "10.00" } },
  { name: "XAU-USD", category: "RWA", active: true, status: "ACTIVE", marketStats: { markPrice: "4100", fundingRate: "0.000004", dailyVolume: "51974070" }, tradingConfig: { maxLeverage: "25.00" } },
  { name: "OLD-USD", category: "Crypto", active: false, status: "DELISTED", marketStats: { markPrice: "1" }, tradingConfig: {} },
];

describe("perpVenues", () => {
  it("names what a market tracks, the same on both venues", () => {
    expect(marketBase("AMD_24_5-USD")).toBe("AMD");
    expect(marketBase("xyz:AMD PERP")).toBe("AMD");
    expect(marketBase("SPX500m-USD")).toBe("SP500");
    expect(marketBase("xyz:SP500")).toBe("SP500");
    expect(marketBase("XAU-USD")).toBe("GOLD");
    expect(marketBase("ETH PERP")).toBe("ETH");
  });

  it("lists Extended's live markets with exact names, funding sign spelled out", () => {
    const rows = parseExtendedMarketRows(RAW);
    expect(rows.map((r) => r.name)).toEqual(["ETH-USD", "XAU-USD", "AMD_24_5-USD"]);
    const text = extendedSummary(rows);
    expect(text).toContain("AMD_24_5-USD (AMD)");
    expect(text).toContain("positive = longs pay shorts");
    expect(text).toMatch(/ETH-USD \(ETH\) \| \$2,470\.28 \| funding \+11\.4%\/yr \| 50x/);
  });

  it("pairs the same market across venues: long where funding is lower, short where higher", () => {
    const rows = parseExtendedMarketRows(RAW);
    const pairs = crossVenueFunding(
      [
        { coin: "ETH", hourlyRate: 0.0000125 },
        { coin: "xyz:AMD", hourlyRate: 0.000011 },
        { coin: "DOGE", hourlyRate: 0.00002 },
      ],
      rows,
    );
    expect(pairs.map((p) => p.base)).toEqual(["ETH", "AMD"]);
    const eth = pairs[0];
    expect(eth.longOn).toBe("Hyperliquid");
    expect(eth.shortOn).toBe("Extended");
    expect(eth.spreadPct).toBeCloseTo((0.000013 - 0.0000125) * 8760 * 100, 6);
    expect(crossVenueSummary(pairs)).toMatch(/- ETH \| ETH: \+10\.9% \| ETH-USD: \+11\.4% \| long Hyperliquid → short Extended/);
  });
});

describe("TxFlow in the planner's market data", () => {
  it("reads TxFlow names as their base", () => {
    expect(marketBase("ETH-USDC")).toBe("ETH");
    expect(marketBase("ETH-USDC PERP")).toBe("ETH");
    expect(marketBase("ETH-USD")).toBe("ETH");
  });

  it("pairs each TxFlow market with the venue whose funding differs most", async () => {
    const { txflowCrossVenue, txflowCrossVenueSummary, txflowSummary } = await import("@/lib/perpVenues");
    const tx = [{ name: "ETH-USDC", base: "ETH", mark: 3000, fundingHourly: 0.00003, maxLeverage: 25, dayVolumeUsd: 4e7 }];
    const ext = parseExtendedMarketRows(RAW as never).filter((m) => m.base === "ETH");
    const rows = txflowCrossVenue([{ coin: "ETH", hourlyRate: 0.0000125 }], ext, tx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ base: "ETH", txflow: "ETH-USDC", shortOn: "TxFlow" });
    expect(rows[0].spreadPct).toBeGreaterThan(0);
    expect(txflowCrossVenueSummary(rows)).toContain("ETH | ETH-USDC: +26.3%");
    expect(txflowSummary(tx)).toContain("- ETH-USDC (ETH) | $3,000 | +26.3%/yr | 25x | $40.0M");
  });
});
