import { describe, expect, it } from "vitest";
import { parseClearinghouseState, parseOpenOrders } from "@/lib/integrations/hyperliquid-live";
import { parseExtendedPositions } from "@/lib/integrations/extended-live";
import { liqDistancePct, roePct, rowsFromExtended, rowsFromHyperliquid, summarize } from "@/lib/perpPositions";

// Trimmed clearinghouseState for a 2x ETH short with a 20% stop.
const HL_STATE = {
  marginSummary: { accountValue: "66.4", totalMarginUsed: "64.6" },
  withdrawable: "1.8",
  assetPositions: [
    {
      position: {
        coin: "ETH",
        szi: "-0.0523",
        entryPx: "2470.0",
        positionValue: "128.39",
        unrealizedPnl: "0.79",
        leverage: { type: "cross", value: 2 },
        liquidationPx: "3655.2",
        marginUsed: "64.19",
        cumFunding: { allTime: "0.4", sinceOpen: "-0.12", sinceChange: "-0.12" },
      },
    },
  ],
};
const HL_ORDERS = parseOpenOrders([
  { coin: "ETH", side: "B", sz: "0.0523", limitPx: "3260", reduceOnly: true, oid: 1, orderType: "Stop Market", triggerPx: "2964.0", isTrigger: true },
  { coin: "BTC", side: "B", sz: "0.001", limitPx: "60000", reduceOnly: false, oid: 2, orderType: "Limit" },
]);

describe("rowsFromHyperliquid", () => {
  it("normalizes a short with its stop-loss and the funding it received", () => {
    const [row] = rowsFromHyperliquid(parseClearinghouseState(HL_STATE), HL_ORDERS, "Hyperliquid");
    expect(row).toMatchObject({ symbol: "ETH", side: "short", size: 0.0523, notional: 128.39, entry: 2470, liq: 3655.2, leverage: 2, margin: 64.19 });
    expect(row.mark).toBeCloseTo(128.39 / 0.0523, 6);
    expect(row.funding).toBeCloseTo(0.12, 6); // sinceOpen −0.12 = received
    expect(row.stopLoss).toBe(2964);
    expect(row.takeProfit).toBeNull();
  });

  it("strips the HIP-3 dex prefix", () => {
    const state = { assetPositions: [{ position: { coin: "xyz:TSLA", szi: "0.1", entryPx: "250", positionValue: "26", unrealizedPnl: "1", leverage: { value: 3 } } }] };
    const [row] = rowsFromHyperliquid(parseClearinghouseState(state), [], "Hyperliquid stocks");
    expect(row.symbol).toBe("TSLA");
    expect(row.margin).toBeCloseTo(26 / 3, 6);
  });
});

describe("rowsFromExtended", () => {
  it("normalizes Extended's position shape", () => {
    const [row] = rowsFromExtended(
      parseExtendedPositions([
        {
          market: "BTC-USD",
          side: "LONG",
          size: "0.002",
          value: "220",
          openPrice: "108000",
          markPrice: "110000",
          liquidationPrice: "75000",
          leverage: "5",
          unrealisedPnl: "4",
          realisedPnl: "-0.11",
          realisedPnlBreakdown: { fundingFees: "-0.02" },
          slPrice: "100000",
          tpPrice: null,
          createdAt: 1,
        },
      ]),
    );
    expect(row).toMatchObject({ venue: "Extended", symbol: "BTC", side: "long", notional: 220, margin: 44, funding: -0.02, stopLoss: 100000, takeProfit: null });
  });
});

describe("risk figures", () => {
  it("liquidation distance follows the side", () => {
    expect(liqDistancePct({ side: "long", mark: 100, liq: 80 })).toBeCloseTo(20, 6);
    expect(liqDistancePct({ side: "short", mark: 100, liq: 150 })).toBeCloseTo(50, 6);
    expect(liqDistancePct({ side: "short", mark: 100, liq: 0 })).toBeNull();
  });

  it("ROE is PnL over margin", () => {
    expect(roePct({ unrealizedPnl: 5, margin: 50 })).toBeCloseTo(10, 6);
    expect(roePct({ unrealizedPnl: 5, margin: 0 })).toBeNull();
  });

  it("summarizes across venues", () => {
    const rows = [
      ...rowsFromHyperliquid(parseClearinghouseState(HL_STATE), HL_ORDERS, "Hyperliquid"),
      ...rowsFromExtended(parseExtendedPositions([{ market: "SOL-USD", side: "SHORT", size: "1", value: "150", openPrice: "155", markPrice: "150", liquidationPrice: "160", leverage: "10", unrealisedPnl: "5" }])),
    ];
    const s = summarize(rows);
    expect(s.count).toBe(2);
    expect(s.unrealizedPnl).toBeCloseTo(5.79, 6);
    expect(s.funding).toBeCloseTo(0.12, 6);
    expect(s.fundingKnown).toBe(true);
    expect(s.margin).toBeCloseTo(64.19 + 15, 6);
    expect(s.closestLiqPct).toBeCloseTo(6.6667, 3);
  });
});

describe("rowsFromTxflow", () => {
  it("names positions from TxFlow's markets and keeps unknown funding unknown", async () => {
    const { rowsFromTxflow } = await import("@/lib/perpPositions");
    const rows = rowsFromTxflow(
      { accountValue: 1000, withdrawable: 800, marginUsed: 150, positions: [{ index: 2, size: -0.5, entry: 3010, mark: 3000, liq: 3900, unrealisedPnl: 5, value: 1500, leverage: 10, funding: null }] },
      [{ index: 2, name: "ETH-USDC", base: "ETH", szDecimals: 3, priceTick: "0.01", maxLeverage: 25, onlyIsolated: false, maxMarketOrderSize: 0 }],
    );
    expect(rows).toEqual([
      expect.objectContaining({ key: "TxFlow:2", venue: "TxFlow", symbol: "ETH", side: "short", size: 0.5, notional: 1500, margin: 150, funding: null, liq: 3900 }),
    ]);
  });
});
