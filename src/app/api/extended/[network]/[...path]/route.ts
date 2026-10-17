import { NextRequest, NextResponse } from "next/server";
import { EXTENDED_HOSTS, extendedUpstreamUrl, forwardableExtendedHeaders, orderForLog, orderPathFor, type ExtendedNetworkName } from "@/lib/integrations/extendedProxy";

/**
 * Relay to Extended's REST API. Extended sends no CORS headers (preflight
 * answers 405, checked 2026-10-16 on mainnet and testnet), so a browser cannot
 * call it directly: every Extended read, order and onboarding call goes
 * through here. Only the request is relayed; nothing is stored or logged.
 * The Stark private key never leaves the browser (orders arrive already
 * signed); the API key and the wallet's onboarding signatures pass through.
 */
export const dynamic = "force-dynamic";
/**
 * Run next to Extended's servers (AWS Tokyo, per its API docs). Extended
 * geoblocks some countries by the caller's IP (HTTP 451), Paris (cdg1)
 * included. Per-function regions need a Vercel Pro plan: on Hobby the
 * project's function region applies (Settings → Functions), so that setting
 * must not be a geoblocked country. The owner confirmed Meridian's users may
 * use Extended.
 */
export const preferredRegion = "hnd1";

/** Which markets are RFQ, per network, re-read every 5 minutes (a market can migrate to RFQ). */
const rfqCache = new Map<string, { at: number; rfq: Set<string> }>();
async function rfqMarkets(network: ExtendedNetworkName): Promise<Set<string> | null> {
  const hit = rfqCache.get(network);
  if (hit && Date.now() - hit.at < 300_000) return hit.rfq;
  try {
    const res = await fetch(`${EXTENDED_HOSTS[network]}/api/v1/info/markets`, { headers: { "user-agent": "meridian-terminal" }, cache: "no-store" });
    if (!res.ok) return hit?.rfq ?? null;
    const rows = ((await res.json()) as { data?: { name?: string; isRfq?: boolean }[] }).data ?? [];
    const rfq = new Set(rows.filter((m) => m.isRfq && m.name).map((m) => m.name as string));
    rfqCache.set(network, { at: Date.now(), rfq });
    return rfq;
  } catch {
    return hit?.rfq ?? null;
  }
}

async function relay(req: NextRequest, ctx: { params: Promise<{ network: string; path: string[] }> }): Promise<NextResponse> {
  const { network, path: requested } = await ctx.params;
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
  // Orders on RFQ markets go to /user/order/rfq (same body and signature).
  const rfq = req.method === "POST" && requested.join("/") === "api/v1/user/order" && (network === "mainnet" || network === "testnet") ? await rfqMarkets(network) : null;
  const path = orderPathFor(requested, req.method, body, (m) => rfq?.has(m));
  const url = extendedUpstreamUrl(network, path, req.nextUrl.search);
  if (!url) return NextResponse.json({ status: "ERROR", error: { message: "Unknown Extended endpoint" } }, { status: 404 });

  try {
    const res = await fetch(url, { method: req.method, headers: forwardableExtendedHeaders(req.headers), body, cache: "no-store" });
    const text = await res.text();
    // Diagnostics: the path and Extended's answer (never headers: they carry the API key and signatures).
    if (!res.ok) console.error("[extended-relay]", req.method, `/${path.join("/")}`, res.status, text.slice(0, 200));
    // A refused order: its fields (never the settlement signature) say what Extended couldn't read.
    if (!res.ok && req.method === "POST" && /^api\/v1\/user\/order(\/rfq)?$/.test(path.join("/"))) console.error("[extended-relay] order fields", orderForLog(body));
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
