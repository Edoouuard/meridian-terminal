import { describe, expect, it } from "vitest";
import { buildFundingPairs, normalizeBase, pairPrompt, parseAster, parseDydx, parseLighterFeed, parseParadex, quotesFromSnapshot, type FundingQuote } from "./funding";
import type { MarketQuote } from "@/lib/planner/markets";

// Excerpts of the venues' real answers, read on 24 Oct 2026.
const LIGHTER = {
  code: 200,
  funding_rates: [
    { market_id: 50, exchange: "binance", symbol: "ARB", rate: 2.003e-5 },
    { market_id: 50, exchange: "bybit", symbol: "ARB", rate: 8.371e-5 },
    { market_id: 50, exchange: "hyperliquid", symbol: "ARB", rate: 0.0001 },
    { market_id: 50, exchange: "lighter", symbol: "ARB", rate: 9.6e-5 },
  ],
};
const PARADEX = { results: [{ symbol: "BTC-USD-PERP", funding_rate: "0.000099094908", funding_interval_minutes: 480, volume_24h: "1542965.3570189995" }, { symbol: "BTC-USD-27OCT26-80000-C", funding_rate: "0.1" }] };
const DYDX = { markets: { "BTC-USD": { ticker: "BTC-USD", status: "ACTIVE", nextFundingRate: "0.00005596875", volume24H: "4664071.2001" }, "OLD-USD": { ticker: "OLD-USD", status: "FINAL_SETTLEMENT", nextFundingRate: "0.01" } } };
const ASTER_PREMIUM = [{ symbol: "BTCUSDT", lastFundingRate: "0.00010000" }, { symbol: "SUSHIUSDT", lastFundingRate: "0.00005" }, { symbol: "ASTERU", lastFundingRate: "0.1" }];
const ASTER_INFO = [{ symbol: "SUSHIUSDT", fundingIntervalHours: 4 }];
const ASTER_TICKERS = [{ symbol: "BTCUSDT", quoteVolume: "250000000" }];

describe("funding parsers", () => {
  it("Lighter's feed: Lighter, Binance and Bybit, 8-hour rates to a % a year; its Hyperliquid rows are skipped", () => {
    const q = parseLighterFeed(LIGHTER);
    expect(q.map((x) => x.venue)).toEqual(["Binance", "Bybit", "Lighter"]);
    expect(q.find((x) => x.venue === "Lighter")!.annualPct).toBeCloseTo(9.6e-5 * 1095 * 100, 6); // 10.51%/yr
    expect(q.every((x) => x.base === "ARB" && x.dayVolumeUsd === null && x.takerFee === null)).toBe(true);
  });

  it("the 8-hour normalisation matches Hyperliquid's own hourly rate (ARB 0.0001 / 8h = 0.0000125 / h)", () => {
    expect(0.0001 * 1095).toBeCloseTo(0.0000125 * 8760, 10);
  });

  it("Paradex: perps only, the rate per its own interval", () => {
    const [btc, ...rest] = parseParadex(PARADEX);
    expect(rest).toHaveLength(0);
    expect(btc.base).toBe("BTC");
    expect(btc.annualPct).toBeCloseTo(0.000099094908 * 1095 * 100, 6);
    expect(btc.dayVolumeUsd).toBeCloseTo(1542965.36, 1);
  });

  it("dYdX: active markets, hourly rate", () => {
    const q = parseDydx(DYDX);
    expect(q).toHaveLength(1);
    expect(q[0].base).toBe("BTC");
    expect(q[0].annualPct).toBeCloseTo(0.00005596875 * 8760 * 100, 6);
  });

  it("Aster: USDT perps, each rate per its own interval (8 hours when unlisted), volume from the 24h ticker", () => {
    const q = parseAster(ASTER_PREMIUM, ASTER_INFO, ASTER_TICKERS);
    expect(q.map((x) => x.base)).toEqual(["BTC", "SUSHI"]);
    expect(q[0].annualPct).toBeCloseTo(0.0001 * 1095 * 100, 6);
    expect(q[1].annualPct).toBeCloseTo(0.00005 * 2190 * 100, 6);
    expect(q[0].dayVolumeUsd).toBe(250_000_000);
    expect(q[1].dayVolumeUsd).toBeNull();
  });

  it("a broken answer is an empty list, never zeros", () => {
    for (const f of [parseLighterFeed, parseParadex, parseDydx]) expect(f(null)).toEqual([]);
    expect(parseAster(null, null, null)).toEqual([]);
  });

  it("price-scaled tickers name the same asset; uppercase K tickers are left alone", () => {
    expect(normalizeBase("kPEPE")).toBe("PEPE");
    expect(normalizeBase("1000PEPE")).toBe("PEPE");
    expect(normalizeBase("KAITO")).toBe("KAITO");
    expect(normalizeBase("BTC-USD-PERP")).toBe("BTC");
  });
});

const q = (venue: FundingQuote["venue"], base: string, annualPct: number, extra: Partial<FundingQuote> = {}): FundingQuote => ({ venue, market: base, base, annualPct, dayVolumeUsd: 5_000_000, takerFee: null, ...extra });

describe("buildFundingPairs", () => {
  it("long where funding is lowest, short where it is highest; fees and break-even only when both fees are known", () => {
    const pairs = buildFundingPairs([
      q("Extended", "ARB", -2.63, { takerFee: 0.00025 }),
      q("Hyperliquid", "ARB", 10.95, { takerFee: 0.00045 }),
      q("Binance", "ARB", 2.19),
    ]);
    expect(pairs).toHaveLength(1);
    const p = pairs[0];
    expect([p.long.venue, p.short.venue]).toEqual(["Extended", "Hyperliquid"]);
    expect(p.spreadAprPct).toBeCloseTo(13.58, 2);
    expect(p.executable).toBe(true);
    expect(p.roundTripFeePct).toBeCloseTo(0.14, 6);
    expect(p.breakEvenDays).toBeCloseTo((0.14 / 13.58) * 365, 6);
    expect(pairPrompt(p)).toBe("Open a beta-neutral pair on ARB: long on Extended, short on Hyperliquid, to earn the funding spread.");
  });

  it("a pair with a reference venue is shown but not executable, with no fee figure", () => {
    const [p] = buildFundingPairs([q("Binance", "SOL", -5), q("Hyperliquid", "SOL", 8, { takerFee: 0.00045 })]);
    expect(p.executable).toBe(false);
    expect(p.roundTripFeePct).toBeNull();
    expect(p.breakEvenDays).toBeNull();
  });

  it("executableOnly keeps Meridian's venues; thin legs and absurd rates are dropped", () => {
    const quotes = [q("Binance", "ETH", -50), q("Hyperliquid", "ETH", 4, { takerFee: 0.00045 }), q("TxFlow", "ETH", 1, { takerFee: 0.00045 }), q("Aster", "BULLA", 4000), q("Paradex", "BULLA", 1), q("dYdX", "THIN", 30, { dayVolumeUsd: 20_000 }), q("Paradex", "THIN", 1)];
    expect(buildFundingPairs(quotes).map((p) => p.base)).toEqual(["ETH"]);
    const [eth] = buildFundingPairs(quotes, { executableOnly: true });
    expect([eth.long.venue, eth.short.venue]).toEqual(["TxFlow", "Hyperliquid"]);
  });

  it("two legs with no reported volume make no pair: one must show real volume", () => {
    expect(buildFundingPairs([q("Binance", "CXMT", -50, { dayVolumeUsd: null }), q("Bybit", "CXMT", 60, { dayVolumeUsd: null })])).toEqual([]);
    expect(buildFundingPairs([q("Binance", "CXMT", -50, { dayVolumeUsd: null }), q("Paradex", "CXMT", 60)])).toHaveLength(1);
  });

  it("one market per venue and asset: the most traded", () => {
    const [p] = buildFundingPairs([q("Hyperliquid", "AMD", 50, { market: "flx:AMD", dayVolumeUsd: 1_500_000 }), q("Hyperliquid", "AMD", 5, { market: "xyz:AMD", dayVolumeUsd: 90_000_000 }), q("Extended", "AMD", 1)]);
    expect(p.short.market).toBe("xyz:AMD");
  });

  it("Meridian's snapshot quotes: hourly funding to a % a year, the taker fee carried", () => {
    const [x] = quotesFromSnapshot([{ venue: "Hyperliquid", kind: "perp", market: "ARB", base: "ARB", markUsd: 0.18, fundingHourly: 0.0000125, sizeStep: 0.1, minQty: 0, minNotionalUsd: 10, takerFee: 0.00045, maxLeverage: 10, dayVolumeUsd: 9_700_000 } as MarketQuote]);
    expect(x.annualPct).toBeCloseTo(10.95, 2);
    expect(x.takerFee).toBe(0.00045);
  });
});
