import { NextRequest, NextResponse } from "next/server";
import { getBestRoute, type RouteRequest } from "@/lib/mcp/router";

/**
 * POST /api/route-quote
 *
 * Fetches the best swap/bridge route from Meridian's routing layer
 * (deBridge + LI.FI, compared — see lib/mcp/router.ts) for a given
 * from/to chain + token + amount. Runs server-side because the MCP SDK
 * client isn't meant for the browser bundle (same reason Aave/Hyperliquid's
 * MCP calls go through their own API routes).
 *
 * Request: { fromChainId, toChainId, fromTokenAddress, toTokenAddress,
 *            fromAmount, fromAddress, toAddress?, slippageBps? }
 * Response: { best: RouteQuote | null, alternatives: RouteQuote[] }
 *
 * Returns only an unsigned quote — read-only. Signing happens exclusively
 * client-side via wagmi, same as every other execution path in this app.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<RouteRequest>;
    const { fromChainId, toChainId, fromTokenAddress, toTokenAddress, fromAmount, fromAddress } = body;

    if (
      typeof fromChainId !== "number" ||
      typeof toChainId !== "number" ||
      typeof fromTokenAddress !== "string" ||
      typeof toTokenAddress !== "string" ||
      typeof fromAmount !== "string" ||
      typeof fromAddress !== "string"
    ) {
      return NextResponse.json(
        {
          error:
            "Missing/invalid required fields: fromChainId, toChainId, fromTokenAddress, toTokenAddress, fromAmount, fromAddress",
        },
        { status: 400 },
      );
    }

    const result = await getBestRoute({
      fromChainId,
      toChainId,
      fromTokenAddress,
      toTokenAddress,
      fromAmount,
      fromAddress,
      toAddress: typeof body.toAddress === "string" ? body.toAddress : undefined,
      slippageBps: typeof body.slippageBps === "number" ? body.slippageBps : undefined,
    });

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message || "Route quote failed" }, { status: 500 });
  }
}
