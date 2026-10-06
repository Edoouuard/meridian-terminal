import { NextRequest, NextResponse } from "next/server";
import * as haiku from "@/lib/mcp/providers/haiku";
import type { Address } from "viem";

/**
 * GET /api/haiku — Haiku MCP aggregated portfolio data.
 *
 * ?action=balances&address=0x...     — Multi-chain token balances
 * ?action=positions&address=0x...    — DeFi positions (lending, staking, LP, vaults)
 * ?action=yields&asset=ETH&minApy=3 — Yield opportunities across protocols
 * ?action=history&address=0x...      — Trade history
 * ?action=token&symbol=ETH&chainId=1 — Resolve token info
 * ?action=health                     — Provider health check
 */
export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action") ?? "health";

  if (action === "health") {
    const status = await haiku.checkHealth();
    return NextResponse.json(status);
  }

  if (action === "balances") {
    const address = req.nextUrl.searchParams.get("address");
    if (!address) {
      return NextResponse.json({ error: "address required" }, { status: 400 });
    }
    const balances = await haiku.fetchBalances(address as Address);
    return NextResponse.json({ balances });
  }

  if (action === "positions") {
    const address = req.nextUrl.searchParams.get("address");
    if (!address) {
      return NextResponse.json({ error: "address required" }, { status: 400 });
    }
    const positions = await haiku.fetchPositions(address as Address);
    return NextResponse.json({ positions });
  }

  if (action === "yields") {
    const asset = req.nextUrl.searchParams.get("asset") ?? undefined;
    const minApy = req.nextUrl.searchParams.get("minApy");
    const chainIds = req.nextUrl.searchParams.get("chainIds");
    const opportunities = await haiku.fetchYieldOpportunities({
      asset,
      minApy: minApy ? Number(minApy) : undefined,
      chainIds: chainIds ? chainIds.split(",").map(Number) : undefined,
    });
    return NextResponse.json({ opportunities });
  }

  if (action === "history") {
    const address = req.nextUrl.searchParams.get("address");
    if (!address) {
      return NextResponse.json({ error: "address required" }, { status: 400 });
    }
    const chainId = req.nextUrl.searchParams.get("chainId");
    const limit = req.nextUrl.searchParams.get("limit");
    const history = await haiku.fetchTradeHistory(address as Address, {
      chainId: chainId ? Number(chainId) : undefined,
      limit: limit ? Number(limit) : 50,
    });
    return NextResponse.json({ history });
  }

  if (action === "token") {
    const symbol = req.nextUrl.searchParams.get("symbol");
    const chainId = req.nextUrl.searchParams.get("chainId");
    if (!symbol || !chainId) {
      return NextResponse.json({ error: "symbol and chainId required" }, { status: 400 });
    }
    const token = await haiku.resolveToken(symbol, Number(chainId));
    if (!token) {
      return NextResponse.json({ error: "Token not found" }, { status: 404 });
    }
    return NextResponse.json({ token });
  }

  return NextResponse.json({ error: "Unknown action. Use balances, positions, yields, history, token, or health" }, { status: 400 });
}
