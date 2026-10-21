import { describe, expect, it } from "vitest";
import { findTxflowMarket, parseTxflowAccount, parseTxflowCtx, parseTxflowMarkets } from "@/lib/integrations/txflow-live";
import { fillFromPositions, txflowMarketPrice, txflowOrderSize } from "@/lib/integrations/txflowTrade";

// Shapes from docs.txflow.com/api/info (perpMeta, activeAssetCtx, clearinghouseState).
const universe = [
  { baseCurrency: "BTC", index: 1, maxLeverage: 50, maxMarketOrderSize: 100, name: "BTC-USDC", onlyIsolated: false, priceTick: "0.1", szDecimals: 4, delisted: false, haltTrading: false },
  { baseCurrency: "ETH", index: 2, maxLeverage: 25, name: "ETH-USDC", priceTick: "0.01", szDecimals: 3 },
  { baseCurrency: "OLD", index: 3, name: "OLD-USDC", priceTick: "0.1", szDecimals: 1, delisted: true },
  { baseCurrency: "HALT", index: 4, name: "HALT-USDC", priceTick: "0.1", szDecimals: 1, haltTrading: true },
];

describe("TxFlow reads", () => {
  it("keeps tradable perp markets and finds them by base", () => {
    const markets = parseTxflowMarkets({ universe });
    expect(markets.map((m) => m.name)).toEqual(["BTC-USDC", "ETH-USDC"]);
    expect(markets[0]).toMatchObject({ index: 1, base: "BTC", szDecimals: 4, priceTick: "0.1", maxLeverage: 50, maxMarketOrderSize: 100 });
    expect(findTxflowMarket(markets, "ETH-PERP")?.index).toBe(2);
    expect(findTxflowMarket(markets, "btc")?.index).toBe(1);
    expect(findTxflowMarket(markets, "BTC-USDC")?.index).toBe(1);
    expect(findTxflowMarket(markets, "SOL")).toBeUndefined();
  });

  it("reads funding in percent per hour as a fraction", () => {
    const ctx = parseTxflowCtx({ markPx: "3000.5", oraclePx: "3000", dayNtlVlm: "1250000", openInterest: "42", nodeCtx: { funding: "0.0125" } });
    expect(ctx).toMatchObject({ mark: 3000.5, oracle: 3000, dayVolumeUsd: 1250000, openInterest: 42 });
    expect(ctx!.fundingHourly).toBeCloseTo(0.000125);
    expect(parseTxflowCtx({ markPx: "0", nodeCtx: { midPx: "0" } })).toBeNull();
  });

  it("reads margin and open positions", () => {
    const acct = parseTxflowAccount({
      withdrawable: "812.5",
      marginSummary: { accountValue: "1000", totalMarginUsed: "150" },
      assetPositions: [
        { position: { asset: "2", szi: "-0.5", entryPx: "3010", markPx: "3000", liquidationPx: "3900", unrealizedPnl: "5", positionValue: "1500", leverage: { value: 10 } } },
        { position: { asset: "1", szi: "0" } },
      ],
    });
    expect(acct).toMatchObject({ accountValue: 1000, withdrawable: 812.5, marginUsed: 150 });
    expect(acct.positions).toEqual([{ index: 2, size: -0.5, entry: 3010, mark: 3000, liq: 3900, unrealisedPnl: 5, value: 1500, leverage: 10, funding: null }]);
  });
});

describe("TxFlow order sizing", () => {
  it("sizes from USD or an exact quantity, rounded down to szDecimals", () => {
    expect(txflowOrderSize({ sizeUsd: 1000, mark: 3000, szDecimals: 3 })).toBe("0.333");
    expect(txflowOrderSize({ coinQty: 0.31234, sizeUsd: 1000, mark: 3000, szDecimals: 3 })).toBe("0.312");
    expect(txflowOrderSize({ sizeUsd: 1, mark: 65000, szDecimals: 4 })).toBe("0");
  });

  it("prices an IOC 1% through the mark, on the tick, away from the mark", () => {
    expect(txflowMarketPrice(3000, true, "0.01")).toBe("3030.00");
    expect(txflowMarketPrice(3000, false, "0.01")).toBe("2970.00");
    expect(txflowMarketPrice(65012.34, true, "1")).toBe("65663");
    expect(txflowMarketPrice(65012.34, false, "1")).toBe("64362");
  });

  it("reads a fill from the change in position size", () => {
    expect(fillFromPositions(0, 0.5, true)).toBe(0.5);
    expect(fillFromPositions(0, -0.5, false)).toBe(0.5);
    expect(fillFromPositions(-0.5, 0, true)).toBe(0.5);
    expect(fillFromPositions(0.5, 0.5, true)).toBe(0);
    expect(fillFromPositions(0.5, 0.7, false)).toBe(0);
  });
});
