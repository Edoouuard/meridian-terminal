/**
 * GET /api/funding-board — funding rates on nine perp venues and the
 * cross-venue pairs they make (lib/markets/funding.ts). Hyperliquid,
 * Extended and TxFlow come from the perp snapshot Meridian trades on;
 * Lighter (with Binance and Bybit), Paradex, dYdX and Aster from their own
 * public APIs. A venue that doesn't answer is simply absent (listed in
 * `venuesDown`), never zeros. Cached briefly at the edge.
 */
import { NextResponse } from "next/server";
import { fetchPerpSnapshot } from "@/lib/perpFeed";
import { buildFundingPairs, parseAster, parseDydx, parseLighterFeed, parseParadex, quotesFromSnapshot, type FundingQuote, type FundingVenue } from "@/lib/markets/funding";

export const dynamic = "force-dynamic";

const TIMEOUT = 8000;

async function getJson(url: string): Promise<unknown> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), next: { revalidate: 30 } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export async function GET() {
  const [snapshot, lighter, paradex, dydx, asterPremium, asterInfo, asterTickers] = await Promise.all([
    fetchPerpSnapshot(),
    getJson("https://mainnet.zklighter.elliot.ai/api/v1/funding-rates"),
    getJson("https://api.prod.paradex.trade/v1/markets/summary?market=ALL"),
    getJson("https://indexer.dydx.trade/v4/perpetualMarkets"),
    getJson("https://fapi.asterdex.com/fapi/v1/premiumIndex"),
    getJson("https://fapi.asterdex.com/fapi/v1/fundingInfo"),
    getJson("https://fapi.asterdex.com/fapi/v1/ticker/24hr"),
  ]);
  const quotes: FundingQuote[] = [
    ...quotesFromSnapshot(snapshot.quotes),
    ...parseLighterFeed(lighter),
    ...parseParadex(paradex),
    ...parseDydx(dydx),
    ...parseAster(asterPremium, asterInfo, asterTickers),
  ];
  const all: FundingVenue[] = ["Hyperliquid", "Extended", "TxFlow", "Lighter", "Binance", "Bybit", "Paradex", "dYdX", "Aster"];
  const seen = new Set(quotes.map((q) => q.venue));
  return NextResponse.json(
    {
      fetchedAt: new Date().toISOString(),
      venues: all.filter((v) => seen.has(v)),
      venuesDown: all.filter((v) => !seen.has(v)),
      quoteCount: quotes.length,
      pairs: buildFundingPairs(quotes).slice(0, 150),
      executablePairs: buildFundingPairs(quotes, { executableOnly: true }).slice(0, 60),
    },
    { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=60" } },
  );
}
