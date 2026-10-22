import { describe, expect, it } from "vitest";
import { extendedQuote, hlQuote, txflowQuote } from "@/lib/planner/markets";
import { describePair, farmCostBpsPerVolume, orientPair, rankForCarry, rankForFarming, scanPairs } from "@/lib/neutralBot/opportunities";

const hourly = (aprPct: number) => aprPct / 100 / 8760;
const quotes = [
  hlQuote({ market: "ETH", base: "ETH", markUsd: 2400, fundingHourly: hourly(11), szDecimals: 4, maxLeverage: 25, dayVolumeUsd: 900e6 }),
  extendedQuote({ market: "ETH-USD", base: "ETH", markUsd: 2401, fundingHourly: hourly(-11), sizeStep: 0.001, minQty: 0.01, maxLeverage: 50, dayVolumeUsd: 80e6 }),
  txflowQuote({ market: "ETH-USDC", base: "ETH", markUsd: 2400, fundingHourly: hourly(10), szDecimals: 4, maxLeverage: 20, dayVolumeUsd: 5e6 }),
  hlQuote({ market: "SOL", base: "SOL", markUsd: 150, fundingHourly: hourly(60), szDecimals: 2, maxLeverage: 20, dayVolumeUsd: 300e6 }),
  extendedQuote({ market: "SOL-USD", base: "SOL", markUsd: 150, fundingHourly: hourly(5), sizeStep: 0.01, minQty: 0.1, maxLeverage: 20, dayVolumeUsd: 20e6 }),
  hlQuote({ market: "THIN", base: "THIN", markUsd: 1, fundingHourly: hourly(200), szDecimals: 0, maxLeverage: 3, dayVolumeUsd: 50e6 }),
  extendedQuote({ market: "THIN-USD", base: "THIN", markUsd: 1, fundingHourly: hourly(0), sizeStep: 1, minQty: 10, maxLeverage: 5, dayVolumeUsd: 20_000 }),
];

describe("pair scanner", () => {
  it("orients each pair the way funding pays and prices its round trip", () => {
    const p = orientPair("ETH", quotes[0], quotes[1]);
    expect(p.long.venue).toBe("Extended");
    expect(p.short.venue).toBe("Hyperliquid");
    expect(p.spreadAprPct).toBeCloseTo(22);
    expect(p.roundTripFeePct).toBeCloseTo(0.14);
    expect(p.breakEvenDays).toBeCloseTo((0.14 / 22) * 365);
    expect(p.minNotionalUsd).toBeCloseTo(24.01);
    expect(p.maxLeverage).toBe(25);
  });

  it("lists every liquid venue couple and drops thin books", () => {
    const pairs = scanPairs({ quotes });
    expect(pairs.map((p) => `${p.base}:${p.long.venue}/${p.short.venue}`).sort()).toEqual(["ETH:Extended/Hyperliquid", "ETH:Extended/TxFlow", "ETH:TxFlow/Hyperliquid", "SOL:Extended/Hyperliquid"]);
    expect(scanPairs({ quotes }, { venues: ["Hyperliquid", "Extended"] })).toHaveLength(2);
  });

  it("flags a funding arbitrage and ranks carry by spread", () => {
    const carry = rankForCarry(scanPairs({ quotes }));
    expect(carry[0].base).toBe("SOL");
    expect(carry[0].arbitrage).toBe(true);
    expect(describePair(carry[0])).toMatch(/SOL: long Extended .* short Hyperliquid .* spread \+55\.0%\/yr .* funding arbitrage/);
  });

  it("ranks farming by the cost of a dollar of volume", () => {
    const pairs = scanPairs({ quotes });
    const ranked = rankForFarming(pairs);
    expect(farmCostBpsPerVolume(ranked[0], 24)).toBeLessThanOrEqual(farmCostBpsPerVolume(ranked[ranked.length - 1], 24));
    // Extended's cheaper taker fee and a paying spread beat a TxFlow/Hyperliquid pair.
    expect(ranked.at(-1)!.long.venue === "TxFlow" || ranked.at(-1)!.short.venue === "TxFlow").toBe(true);
  });
});
