import { describe, expect, it } from "vitest";
import { fitFallbackToPortfolio, type PortfolioContext } from "@/lib/intentEngine";
import { routeThesis } from "@/lib/routeThesis";

const portfolio = (hlFree: number, extFree: number, walletUsdc = 0): PortfolioContext => ({
  netUsd: hlFree + extFree + walletUsdc,
  freeBalanceUsd: walletUsdc,
  assets: walletUsdc ? [{ symbol: "USDC", venue: "Wallet", chain: "Arbitrum", balance: walletUsdc, usd: walletUsdc }] : [],
  lendingPositions: [],
  perps: [],
  netDeltaEthTotal: null,
  hyperliquid: { unified: true, collateralUsd: hlFree, marginUsedUsd: 0, freeMarginUsd: hlFree, spotUsdcUsd: 0 },
  extended: { connected: true, network: "mainnet", availableUsd: extFree },
});

describe("local fallback plan sized to the portfolio", () => {
  const thesis = "Beta-neutral ETH between Extended and Hyperliquid to farm volume";

  it("sizes the cross-venue pair from the thinner venue's free margin, at 1x", () => {
    const item = fitFallbackToPortfolio(routeThesis(thesis), thesis, portfolio(25.49, 40));
    const perps = item.plan!.legs.filter((l) => /^(long|short)$/i.test(l.side));
    expect(perps.map((l) => l.protocol)).toEqual(["Hyperliquid", "Extended"]);
    // min($25.49, $40) × 80% utilization × 1x
    expect(perps.map((l) => l.sizeUsd)).toEqual([20, 20]);
    expect(perps.every((l) => l.leverage === 1)).toBe(true);
  });

  it("keeps the amount the user typed", () => {
    const t = `${thesis} with $500`;
    const item = fitFallbackToPortfolio(routeThesis(t), t, portfolio(25, 40));
    expect(item.plan!.legs.find((l) => l.side === "Long")?.sizeUsd).toBe(500);
  });

  it("changes nothing without a portfolio", () => {
    const base = routeThesis(thesis);
    expect(fitFallbackToPortfolio(base, thesis, undefined)).toBe(base);
  });
});
