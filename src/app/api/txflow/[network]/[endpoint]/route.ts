import { NextRequest, NextResponse } from "next/server";
import { TXFLOW, TXFLOW_API_VERSION_HEADER } from "@/lib/integrations/txflowExchange";

/**
 * Relay to TxFlow's API (POST /info and POST /exchange only). Writes arrive
 * already signed in the browser (agent key or wallet): the relay forwards the
 * body as is and stores nothing. Keeps reads and writes on one same-origin
 * path, whatever TxFlow's CORS policy for third-party sites.
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ network: string; endpoint: string }> }): Promise<NextResponse> {
  const { network, endpoint } = await ctx.params;
  if ((network !== "mainnet" && network !== "testnet") || (endpoint !== "info" && endpoint !== "exchange")) {
    return NextResponse.json({ success: false, status: "err", message: "Unknown TxFlow endpoint" }, { status: 404 });
  }
  const body = await req.text();
  if (body.length > 64_000) return NextResponse.json({ success: false, status: "err", message: "Request too large" }, { status: 413 });
  try {
    const res = await fetch(`${TXFLOW[network].host}/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-version": TXFLOW_API_VERSION_HEADER, "user-agent": "meridian-terminal" },
      body,
      cache: "no-store",
    });
    const text = await res.text();
    // Diagnostics: the action type and TxFlow's answer, never the signature.
    if (!res.ok || (endpoint === "exchange" && /"status"\s*:\s*"err"/.test(text))) {
      let type = "?";
      try {
        type = String((JSON.parse(body) as { action?: { type?: string }; type?: string }).action?.type ?? (JSON.parse(body) as { type?: string }).type);
      } catch {
        /* not JSON */
      }
      console.error("[txflow-relay]", endpoint, type, res.status, text.slice(0, 200));
    }
    return new NextResponse(text, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
  } catch (err) {
    return NextResponse.json({ success: false, status: "err", message: `TxFlow unreachable: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 });
  }
}
