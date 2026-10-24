import { describe, expect, it } from "vitest";
import type { MarketQuote } from "@/lib/planner/markets";
import {
  averageAnnualPct,
  candidatePairs,
  evaluatePair,
  fundingArbPrompt,
  legsFromSnapshot,
  parseExtendedFundingHistory,
  parseHlFundingHistory,
  rankFundingArbs,
  type FundingLeg,
} from "./fundingArb";

const quote = (q: Partial<MarketQuote>): MarketQuote => ({
  venue: "Hyperliquid",
  kind: "perp",
  market: "BTC",
  base: "BTC",
  markUsd: 100_000,
  fundingHourly: 0.0000125,
  sizeStep: 0.00001,
  minQty: 0,
  minNotionalUsd: 10,
  takerFee: 0.00045,
  maxLeverage: 40,
  dayVolumeUsd: 5e9,
  ...q,
});

const leg = (l: Partial<FundingLeg>): FundingLeg => ({ venue: "Hyperliquid", market: "BTC", base: "BTC", markUsd: 100_000, ratePct: 10, rate7dPct: null, takerFee: 0.00045, dayVolumeUsd: 5e9, ...l });

describe("funding arbitrage", () => {
  it("legs: hourly rate to % a year; thin, spot and absurd markets are left out; one market per venue", () => {
    const legs = legsFromSnapshot([
      quote({}),
      quote({ venue: "Extended", market: "BTC-USD", fundingHourly: -0.00001, dayVolumeUsd: 2e8 }),
      quote({ venue: "Extended", market: "BTC-USD-OLD", dayVolumeUsd: 1e6 }),
      quote({ venue: "TxFlow", market: "BTC-PERP", dayVolumeUsd: 500_000 }),
      quote({ kind: "spot", market: "UBTC", dayVolumeUsd: 9e9 }),
      quote({ market: "JUNK", base: "JUNK", fundingHourly: 0.01 }),
    ]);
    expect(legs.map((l) => `${l.venue}:${l.market}`).sort()).toEqual(["Extended:BTC-USD", "Hyperliquid:BTC"]);
    expect(legs.find((l) => l.venue === "Hyperliquid")?.ratePct).toBeCloseTo(10.95, 6);
  });

  it("candidates: long where funding is lowest, short where it is highest, widest first", () => {
    const c = candidatePairs([leg({ venue: "Hyperliquid", ratePct: 10.95 }), leg({ venue: "Extended", ratePct: -8.76 }), leg({ venue: "TxFlow", ratePct: 2 })]);
    expect(`${c[0].long.venue}→${c[0].short.venue}`).toBe("Extended→Hyperliquid");
    expect(c).toHaveLength(3);
  });

  it("histories parse, and the 7-day average needs at least 5 days of points", () => {
    const now = Date.parse("2026-10-24T00:00:00Z");
    const hl = parseHlFundingHistory(Array.from({ length: 168 }, (_, i) => ({ coin: "BTC", fundingRate: "0.00001", premium: "0", time: now - i * 3_600_000 })));
    expect(averageAnnualPct(hl, now - 7 * 86_400_000, now)).toBeCloseTo(8.76, 6);
    const ext = parseExtendedFundingHistory({ status: "OK", data: [{ m: "BTC-USD", f: "0.000013", T: now - 3_600_000 }, { m: "BTC-USD", f: "0.000013", T: now - 2 * 86_400_000 }] });
    expect(ext).toHaveLength(2);
    expect(averageAnnualPct(ext, now - 7 * 86_400_000, now)).toBeNull();
    expect(parseHlFundingHistory(null)).toEqual([]);
  });

  it("a pair: what each leg earns, fees on four fills, the price gap, the 30-day net on the 7-day spread", () => {
    const a = evaluatePair(
      leg({ venue: "Extended", market: "BTC-USD", ratePct: -5, rate7dPct: 1, takerFee: 0.00025, markUsd: 100_000 }),
      leg({ venue: "Hyperliquid", ratePct: 10.95, rate7dPct: 11, takerFee: 0.00045, markUsd: 100_050 }),
    );
    expect(a.longEarnsPct).toBeCloseTo(5, 6); // negative funding: the long is paid
    expect(a.shortEarnsPct).toBeCloseTo(10.95, 6);
    expect(a.spreadNowPct).toBeCloseTo(15.95, 6);
    expect(a.spread7dPct).toBeCloseTo(10, 6);
    expect(a.basis).toBe("7d");
    expect(a.roundTripFeePct).toBeCloseTo(0.14, 6);
    expect(a.priceGapPct).toBeCloseTo(0.05, 6);
    expect(a.netHoldPct).toBeCloseTo((10 * 30) / 365 - 0.14, 6);
    expect(a.breakEvenDays).toBeCloseTo((0.14 / 10) * 365, 6);
    expect(fundingArbPrompt(a)).toContain("long BTC-USD on Extended, short BTC on Hyperliquid");
  });

  it("ranking: a spread that is negative over 7 days is a spike and is dropped; history first; one pair per asset", () => {
    const spike = evaluatePair(leg({ base: "ETH", ratePct: -50, rate7dPct: 12 }), leg({ base: "ETH", venue: "Extended", ratePct: 11.39, rate7dPct: 5 }));
    const steady = evaluatePair(leg({ base: "SOL", ratePct: 0, rate7dPct: 0 }), leg({ base: "SOL", venue: "Extended", ratePct: 11.39, rate7dPct: 11 }));
    const solWorse = evaluatePair(leg({ base: "SOL", ratePct: 5, rate7dPct: 5 }), leg({ base: "SOL", venue: "Extended", ratePct: 11.39, rate7dPct: 11 }));
    const noHistory = evaluatePair(leg({ base: "DOGE", ratePct: -40 }), leg({ base: "DOGE", venue: "TxFlow", ratePct: 40 }));
    expect(rankFundingArbs([noHistory, spike, solWorse, steady]).map((a) => a.base)).toEqual(["SOL", "DOGE"]);
    expect(rankFundingArbs([steady, solWorse])[0]).toBe(steady);
  });
});
