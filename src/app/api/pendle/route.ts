import { NextRequest, NextResponse } from "next/server";
import { isAddress, type Address } from "viem";
import { PENDLE_CHAINS, fetchPendleBuyQuote, fetchPendleMarkets } from "@/lib/integrations/pendle";

/**
 * Pendle fixed yield (see lib/integrations/pendle.ts).
 *   GET  /api/pendle?chainId=42161 → live markets (≥ $1M liquidity, > 14 days to expiry), best fixed APY first.
 *   POST /api/pendle { chainId, pt, tokenIn, amountIn, receiver } → the router call that buys PT.
 * Never signs; the browser re-checks the router address before signing.
 */
export async function GET(req: NextRequest) {
  const chainId = Number(new URL(req.url).searchParams.get("chainId"));
  if (!(PENDLE_CHAINS as readonly number[]).includes(chainId)) return NextResponse.json([]);
  return NextResponse.json(await fetchPendleMarkets(chainId));
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const { chainId, pt, tokenIn, amountIn, receiver } = body;
  if (
    typeof chainId !== "number" ||
    !(PENDLE_CHAINS as readonly number[]).includes(chainId) ||
    typeof pt !== "string" || !isAddress(pt) ||
    typeof tokenIn !== "string" || !isAddress(tokenIn) ||
    typeof receiver !== "string" || !isAddress(receiver) ||
    typeof amountIn !== "string" || !/^\d+$/.test(amountIn)
  ) {
    return NextResponse.json({ error: "Missing/invalid fields: chainId, pt, tokenIn, amountIn, receiver" }, { status: 400 });
  }
  const quote = await fetchPendleBuyQuote({ chainId, pt: pt as Address, tokenIn: tokenIn as Address, amountIn, receiver: receiver as Address });
  if (!quote) return NextResponse.json({ error: "Pendle returned no route for this market and amount" }, { status: 502 });
  return NextResponse.json(quote);
}
