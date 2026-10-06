import { NextRequest, NextResponse } from "next/server";
import { getQuoteWithFallback, buildTransactionWithFallback } from "@/lib/mcp/providers/lifi";
import type { RouteRequest, RouteQuote } from "@/lib/mcp/types";
import type { Address } from "viem";

/**
 * POST /api/swap — Get a same-chain swap quote from LI.FI (DEX aggregator).
 *
 * LI.FI aggregates 30+ DEXes (1inch, Paraswap, 0x, CowSwap, etc.) and
 * picks the best rate. This complements the existing Uniswap v3 direct
 * integration: Uniswap is on-chain (live QuoterV2 quote), LI.FI is
 * off-chain aggregation. The UI can show both for comparison.
 *
 * Body: { chainId, fromToken, toToken, fromAmount, userAddress, slippage? }
 * Response: { quote, execution } or { error }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { chainId, fromToken, toToken, fromAmount, userAddress, slippage } = body;

    if (!chainId || !fromToken || !toToken || !fromAmount || !userAddress) {
      return NextResponse.json(
        { error: "Missing required fields: chainId, fromToken, toToken, fromAmount, userAddress" },
        { status: 400 },
      );
    }

    const request: RouteRequest = {
      fromChainId: Number(chainId),
      toChainId: Number(chainId), // same-chain swap
      fromToken: fromToken as Address,
      toToken: toToken as Address,
      fromAmount: String(fromAmount),
      userAddress: userAddress as Address,
      slippage: slippage !== undefined ? Number(slippage) : 0.005,
    };

    const quote = await getQuoteWithFallback(request);
    if (!quote) {
      return NextResponse.json(
        { error: "No swap route available for this pair via LI.FI" },
        { status: 404 },
      );
    }

    // Build the unsigned transaction
    const execution = await buildTransactionWithFallback(request, quote.routeData as Parameters<typeof buildTransactionWithFallback>[1]);

    return NextResponse.json({ quote, execution });
  } catch (err) {
    console.error("[api/swap] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Swap quote failed" },
      { status: 500 },
    );
  }
}
