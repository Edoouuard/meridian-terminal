import { NextRequest, NextResponse } from "next/server";
import { findBestRoute, planRoute, type RouteComparison, type RouteQuote as RouterQuote } from "@/lib/mcp/router";
import { getDebridgeOrderStatus } from "@/lib/mcp/debridge";
import { getLifiRouteStatus } from "@/lib/mcp/lifi";
import type { RouteRequest } from "@/lib/mcp/types";

/**
 * POST /api/bridge — Get a cross-chain bridge/swap quote + execution plan.
 *
 * Queries deBridge + LI.FI in parallel via the MCP routing layer, compares
 * net output, returns the best route with unsigned transactions ready to
 * sign client-side. Never signs or submits — that happens in the browser.
 *
 * Body: { fromChainId, toChainId, fromToken, toToken, fromAmount, userAddress, slippage? }
 * Response: { comparison, execution, best, alternatives } or { error }
 *   - comparison/execution: the shape useBridge consumes (display quote + ordered txs)
 *   - best/alternatives: the raw router quotes (same as /api/route-quote)
 */
function toDisplayQuote(q: RouterQuote, req: RouteRequest) {
  return {
    provider: q.provider,
    fromToken: { symbol: req.fromToken, address: req.fromToken, chainId: req.fromChainId },
    toToken: { symbol: req.toToken, address: req.toToken, chainId: req.toChainId },
    fromAmount: req.fromAmount,
    toAmount: q.toAmountEstimate ?? "0",
    estimatedFeesUsd: 0,
    estimatedTimeSeconds: q.etaSeconds ?? (req.fromChainId === req.toChainId ? 30 : 120),
    steps: [{
      type: req.fromChainId === req.toChainId ? "swap" : "bridge",
      provider: q.provider === "lifi" ? "LI.FI" : "deBridge",
      fromToken: req.fromToken,
      toToken: req.toToken,
    }],
    routeData: { orderId: q.orderId },
  };
}

function toExecution(q: RouterQuote) {
  const norm = (tx: { to: string; data: string; value?: string; chainId: number }) => ({
    to: tx.to, data: tx.data, value: tx.value ?? "0", chainId: tx.chainId,
  });
  return {
    provider: q.provider,
    transactions: [norm(q.tx)],
    approvals: q.approvalTx ? [norm(q.approvalTx)] : [],
  };
}

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

    const reason = result.alternatives.length > 0
      ? `Best of ${result.alternatives.length + 1} quotes (deBridge vs LI.FI) by destination amount`
      : `Only ${result.best.provider === "lifi" ? "LI.FI" : "deBridge"} returned a signable route`;
    return NextResponse.json({
      ...result,
      comparison: {
        best: toDisplayQuote(result.best, request),
        alternatives: result.alternatives.map((q) => toDisplayQuote(q, request)),
        reason,
      },
      execution: toExecution(result.best),
    } satisfies RouteComparison & Record<string, unknown>);
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
      const status = await getLifiRouteStatus(
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
    const status = await getDebridgeOrderStatus(orderId);
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
