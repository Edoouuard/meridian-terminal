import { describe, expect, it } from "vitest";
import { enrichPositions, parsePendlePositions, type MarketInfo } from "@/lib/integrations/pendlePositions";
import { pendlePositions } from "@/lib/defiPositions";
import { isLockedVenue } from "@/lib/budgetFit";

// Shape from Pendle's OpenAPI spec (UserPositionsCrossChainResponse → MarketPosition → Position).
const body = {
  positions: [
    {
      chainId: 1,
      totalOpen: 2,
      totalClosed: 0,
      totalSy: 0,
      openPositions: [
        {
          marketId: "1-0xb162b764044697cf03617c2efbcb1f42e31e4766",
          pt: { balance: "1050000000000000000000", valuation: 1012.4, claimTokenAmounts: [] },
          yt: { balance: "0", valuation: 0 },
          lp: { balance: "2000000000000000000", activeBalance: "2000000000000000000", valuation: 4.2 },
          crossPtPositions: [],
        },
        { marketId: "1-0xdust", pt: { balance: "1", valuation: 0.0001 }, yt: { balance: "0", valuation: 0 }, lp: { balance: "0", valuation: 0 }, crossPtPositions: [] },
      ],
      closedPositions: [],
      syPositions: [],
      updatedAt: "2026-10-21T00:00:00.000Z",
    },
    { chainId: 42161, totalOpen: 1, openPositions: [{ marketId: "42161-0x0000000000000000000000000000000000000abc", pt: { balance: "25000000", valuation: 24.9 }, yt: { balance: "0", valuation: 0 }, lp: { balance: "0", valuation: 0 } }] },
  ],
};

describe("Pendle positions", () => {
  it("keeps open PT / YT / LP worth $1+, one row per token kind, and drops malformed markets", () => {
    expect(parsePendlePositions(body)).toEqual([
      { chainId: 1, market: "0xb162b764044697cf03617c2efbcb1f42e31e4766", kind: "PT", balance: "1050000000000000000000", usd: 1012.4 },
      { chainId: 1, market: "0xb162b764044697cf03617c2efbcb1f42e31e4766", kind: "LP", balance: "2000000000000000000", usd: 4.2 },
      { chainId: 42161, market: "0x0000000000000000000000000000000000000abc", kind: "PT", balance: "25000000", usd: 24.9 },
    ]);
    expect(parsePendlePositions({ error: "x" })).toEqual([]);
  });

  it("names tokens and dates the maturity from the market contracts; an unreadable chain keeps a generic label", () => {
    const info: MarketInfo = { ptSymbol: "PT-sUSDE-27NOV2026", ytSymbol: "YT-sUSDE-27NOV2026", lpSymbol: "PENDLE-LPT", ptDecimals: 18, ytDecimals: 18, lpDecimals: 18, expiry: "2026-11-27T00:00:00.000Z" };
    const rows = enrichPositions(parsePendlePositions(body), new Map([["1:0xb162b764044697cf03617c2efbcb1f42e31e4766", info]]));
    expect(rows[0]).toEqual({ chainId: 1, market: "0xb162b764044697cf03617c2efbcb1f42e31e4766", kind: "PT", symbol: "PT-sUSDE-27NOV2026", balance: 1050, usd: 1012.4, expiry: "2026-11-27T00:00:00.000Z" });
    expect(rows[2]).toMatchObject({ symbol: "Pendle PT", usd: 24.9, expiry: undefined });

    const assets = pendlePositions(rows, new Date("2026-10-21T00:00:00Z"));
    expect(assets[0]).toEqual({ symbol: "PT-sUSDE-27NOV2026", venue: "Pendle PT · matures 27 Nov 2026", chain: "Ethereum", balance: 1050, usd: 1012.4 });
    expect(assets.every((a) => isLockedVenue(a.venue))).toBe(true);
    expect(pendlePositions(rows, new Date("2026-12-01T00:00:00Z"))[0].venue).toBe("Pendle PT · matured, redeemable");
  });
});
