import type { NextRequest } from "next/server";
import { relayExtended } from "@/lib/integrations/extendedRelay";

/**
 * Relay to Extended's REST API. Extended sends no CORS headers (preflight
 * answers 405, checked 2026-10-16 on mainnet and testnet), so a browser cannot
 * call it directly: every Extended read, order and onboarding call goes
 * through here. Only the request is relayed; nothing is stored or logged.
 * Orders arrive already signed (the Stark key stays in the browser, or on
 * Meridian's server for a bot the user runs there: /api/extended-srv); the
 * API key and the wallet's onboarding signatures pass through.
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

async function relay(req: NextRequest, ctx: { params: Promise<{ network: string; path: string[] }> }) {
  const { network, path } = await ctx.params;
  return relayExtended(req, network, path);
}

export const GET = relay;
export const POST = relay;
export const PATCH = relay;
export const DELETE = relay;
