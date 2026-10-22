/**
 * GET /api/perp-markets — the perp markets of Hyperliquid, Extended and
 * TxFlow (funding, mark, size rules, 24h volume) as a MarketSnapshot, for the
 * opportunity scanner and the neutral bot in Tools. Public data only; cached
 * a few seconds at the edge so a bot tick never hammers the venues.
 */
import { NextResponse } from "next/server";
import { fetchPerpSnapshot } from "@/lib/perpFeed";

export const dynamic = "force-dynamic";

export async function GET() {
  const snapshot = await fetchPerpSnapshot();
  return NextResponse.json(snapshot, { headers: { "cache-control": "public, s-maxage=15, stale-while-revalidate=30" } });
}
