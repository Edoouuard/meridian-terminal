/**
 * extendedRelay.ts — the relay to Extended's REST API, shared by the
 * browser's route (/api/extended/…) and the server bot's
 * (/api/extended-srv/…): RFQ orders routed to /user/order/rfq, only
 * Meridian's endpoints forwarded, Extended's refusals logged without
 * secrets. Server only.
 */
import { NextRequest, NextResponse } from "next/server";
import { EXTENDED_HOSTS, extendedUpstreamUrl, forwardableExtendedHeaders, orderForLog, orderPathFor, type ExtendedNetworkName } from "@/lib/integrations/extendedProxy";

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

export async function relayExtended(req: NextRequest, network: string, requested: string[]): Promise<NextResponse> {
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

