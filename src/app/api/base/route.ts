import { NextRequest, NextResponse } from "next/server";
import * as baseMcp from "@/lib/mcp/providers/base";
import type { Address } from "viem";

/**
 * GET /api/base — Base MCP provider endpoints.
 *
 * ?action=resolve&name=vitalik.base.eth   — Resolve Basename/ENS → address
 * ?action=reverse&address=0x...           — Reverse resolve address → Basename
 * ?action=smartwallet&address=0x...       — Detect smart wallet + paymaster
 * ?action=aerodrome&limit=20&token=ETH   — Aerodrome pools on Base
 * ?action=moonwell                        — Moonwell lending markets on Base
 * ?action=onramp&amount=100&currency=USD&token=ETH — Fiat onramp quote
 * ?action=health                          — Provider health check
 */
export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action") ?? "health";

  if (action === "health") {
    const status = await baseMcp.checkHealth();
    return NextResponse.json(status);
  }

  if (action === "resolve") {
    const name = req.nextUrl.searchParams.get("name");
    if (!name) {
      return NextResponse.json({ error: "name required" }, { status: 400 });
    }
    const address = await baseMcp.resolveName(name);
    if (!address) {
      return NextResponse.json({ error: "Name not found" }, { status: 404 });
    }
    return NextResponse.json({ address });
  }

  if (action === "reverse") {
    const address = req.nextUrl.searchParams.get("address");
    if (!address) {
      return NextResponse.json({ error: "address required" }, { status: 400 });
    }
    const name = await baseMcp.reverseName(address as Address);
    if (!name) {
      return NextResponse.json({ error: "No Basename found for this address" }, { status: 404 });
    }
    return NextResponse.json({ name });
  }

  if (action === "smartwallet") {
    const address = req.nextUrl.searchParams.get("address");
    if (!address) {
      return NextResponse.json({ error: "address required" }, { status: 400 });
    }
    const info = await baseMcp.detectSmartWallet(address as Address);
    return NextResponse.json(info);
  }

  if (action === "aerodrome") {
    const limit = req.nextUrl.searchParams.get("limit");
    const token = req.nextUrl.searchParams.get("token") ?? undefined;
    const pools = await baseMcp.getAerodromePools({
      limit: limit ? Number(limit) : 20,
      token,
    });
    return NextResponse.json({ pools });
  }

  if (action === "moonwell") {
    const markets = await baseMcp.getMoonwellMarkets();
    return NextResponse.json({ markets });
  }

  if (action === "onramp") {
    const amount = req.nextUrl.searchParams.get("amount");
    const currency = req.nextUrl.searchParams.get("currency");
    const token = req.nextUrl.searchParams.get("token");
    if (!amount || !currency || !token) {
      return NextResponse.json({ error: "amount, currency, and token required" }, { status: 400 });
    }
    const quote = await baseMcp.getOnrampQuote(Number(amount), currency, token);
    if (!quote) {
      return NextResponse.json({ error: "Onramp quote unavailable" }, { status: 404 });
    }
    return NextResponse.json({ quote });
  }

  return NextResponse.json({ error: "Unknown action. Use resolve, reverse, smartwallet, aerodrome, moonwell, onramp, or health" }, { status: 400 });
}

/**
 * POST /api/base — Base MCP write operations.
 *
 * Body: { action: "sponsor", tx: { to, data, value }, userAddress }
 * Returns the paymaster-wrapped unsigned transaction.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action } = body;

    if (action === "sponsor") {
      const { tx, userAddress } = body;
      if (!tx?.to || !tx?.data || !userAddress) {
        return NextResponse.json({ error: "tx (to, data, value) and userAddress required" }, { status: 400 });
      }
      const sponsored = await baseMcp.sponsorTransaction(
        { to: tx.to, data: tx.data, value: tx.value ?? "0", chainId: 8453 },
        userAddress as Address,
      );
      if (!sponsored) {
        return NextResponse.json({ error: "Paymaster sponsorship unavailable" }, { status: 404 });
      }
      return NextResponse.json({ tx: sponsored });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    console.error("[api/base] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Request failed" },
      { status: 500 },
    );
  }
}
