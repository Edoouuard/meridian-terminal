import { NextRequest, NextResponse } from "next/server";
import { extendedUpstreamUrl, forwardableExtendedHeaders } from "@/lib/integrations/extendedProxy";

/**
 * Relay to Extended's REST API. Extended sends no CORS headers (preflight
 * answers 405, checked 2026-10-16 on mainnet and testnet), so a browser cannot
 * call it directly: every Extended read, order and onboarding call goes
 * through here. Only the request is relayed; nothing is stored or logged.
 * The Stark private key never leaves the browser (orders arrive already
 * signed); the API key and the wallet's onboarding signatures pass through.
 */
export const dynamic = "force-dynamic";

async function relay(req: NextRequest, ctx: { params: Promise<{ network: string; path: string[] }> }): Promise<NextResponse> {
  const { network, path } = await ctx.params;
  const url = extendedUpstreamUrl(network, path, req.nextUrl.search);
  if (!url) return NextResponse.json({ status: "ERROR", error: { message: "Unknown Extended endpoint" } }, { status: 404 });

  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
  try {
    const res = await fetch(url, { method: req.method, headers: forwardableExtendedHeaders(req.headers), body, cache: "no-store" });
    const text = await res.text();
    // 451 = Extended refuses this server's location for legal reasons (geo-restriction), with an empty body.
    if (res.status === 451) {
      return NextResponse.json(
        { status: "ERROR", error: { message: "Extended refuses connections from Meridian's server location (HTTP 451, legal restriction). Extended can't be used from Meridian for now." } },
        { status: 451 },
      );
    }
    return new NextResponse(text, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
  } catch (err) {
    return NextResponse.json(
      { status: "ERROR", error: { message: `Extended unreachable: ${err instanceof Error ? err.message : String(err)}` } },
      { status: 502 },
    );
  }
}

export const GET = relay;
export const POST = relay;
export const PATCH = relay;
export const DELETE = relay;
