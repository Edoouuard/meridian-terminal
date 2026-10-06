import { NextRequest, NextResponse } from "next/server";
import { findBestRoute, planRoute, type RouteComparison } from "@/lib/mcp/router";
import { getOrderStatus } from "@/lib/mcp/providers/debridge";
import { getRouteStatusWithFallback } from "@/lib/mcp/providers/lifi";
import type { RouteRequest } from "@/lib/mcp/types";

/**
 * POST /api/bridge — Get a cross-chain bridge/swap quote + execution plan.
 *
 * Queries deBridge + LI.FI in parallel via the MCP routing layer, compares
 * net output, returns the best route with unsigned transactions ready to
 * sign client-side. Never signs or submits — that happens in the browser.
 *
 * Body: { fromChainId, toChainId, fromToken, toToken, fromAmount, userAddress, slippage? }
 * Response: { comparison, execution } or { error }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { fromChainId, toChainId, fromToken, toToken, fromAmount, userAddress, slippage } = body;

    if (!fromChainId || !toChainId || !fromToken || !toToken || !fromAmount || !userAddress) {
      return NextResponse.json(
        { error: "Missing required fields: fromChainId, toChainId, fromToken, toToken, fromAmount, userAddress" },
        { status: 400 },
      );
    }

    const request: RouteRequest = {
      fromChainId: Number(fromChainId),
      toChainId: Number(toChainId),
      fromToken,
      toToken,
      fromAmount: String(fromAmount),
      userAddress,
      slippage: slippage !== undefined ? Number(slippage) : undefined,
    };

    const result = await planRoute(request);
    if (!result) {
      return NextResponse.json(
        { error: "No bridge route available for this pair. Both deBridge and LI.FI failed to quote." },
        { status: 404 },
      );
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error("[api/bridge] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Bridge quote failed" },
      { status: 500 },
    );
  }
}

/**
 * GET /api/bridge?action=quote&... — Quick quote without building tx.
 * GET /api/bridge?action=status&orderId=... — Track cross-chain order.
 */
export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action");

  if (action === "status") {
    const provider = req.nextUrl.searchParams.get("provider") ?? "debridge";

    if (provider === "lifi") {
      // LI.FI tracks by source tx hash + chain ids
      const txHash = req.nextUrl.searchParams.get("txHash");
      const fromChainId = req.nextUrl.searchParams.get("fromChainId");
      const toChainId = req.nextUrl.searchParams.get("toChainId");
      if (!txHash || !fromChainId) {
        return NextResponse.json({ error: "txHash and fromChainId required for LI.FI status" }, { status: 400 });
      }
      const status = await getRouteStatusWithFallback(
        txHash,
        Number(fromChainId),
        toChainId ? Number(toChainId) : undefined,
      );
      if (!status) {
        return NextResponse.json({ error: "Route status unavailable" }, { status: 404 });
      }
      return NextResponse.json(status);
    }

    // deBridge tracks by orderId
    const orderId = req.nextUrl.searchParams.get("orderId");
    if (!orderId) {
      return NextResponse.json({ error: "orderId is required" }, { status: 400 });
    }
    const status = await getOrderStatus(orderId);
    if (!status) {
      return NextResponse.json({ error: "Order not found or tracking unavailable" }, { status: 404 });
    }
    return NextResponse.json(status);
  }

  if (action === "quote") {
    const fromChainId = req.nextUrl.searchParams.get("fromChainId");
    const toChainId = req.nextUrl.searchParams.get("toChainId");
    const fromToken = req.nextUrl.searchParams.get("fromToken");
    const toToken = req.nextUrl.searchParams.get("toToken");
    const fromAmount = req.nextUrl.searchParams.get("fromAmount");
    const userAddress = req.nextUrl.searchParams.get("userAddress");

    if (!fromChainId || !toChainId || !fromToken || !toToken || !fromAmount || !userAddress) {
      return NextResponse.json({ error: "Missing required query params" }, { status: 400 });
    }

    const request: RouteRequest = {
      fromChainId: Number(fromChainId),
      toChainId: Number(toChainId),
      fromToken: fromToken as `0x${string}`,
      toToken: toToken as `0x${string}`,
      fromAmount,
      userAddress: userAddress as `0x${string}`,
    };

    const comparison = await findBestRoute(request);
    if (!comparison) {
      return NextResponse.json({ error: "No route available" }, { status: 404 });
    }

    return NextResponse.json(comparison);
  }

  return NextResponse.json({ error: "Unknown action. Use action=quote or action=status" }, { status: 400 });
}
