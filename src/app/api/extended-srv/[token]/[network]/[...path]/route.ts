import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { relayExtended } from "@/lib/integrations/extendedRelay";
import { serverRelayToken } from "@/lib/server/relayToken";

/**
 * The Extended relay for Meridian's own server (the neutral bot running
 * 24/7): the same relay as /api/extended, reachable without the beta cookie
 * a server call can't carry, behind a token only the server knows (derived
 * from BOT_ENCRYPTION_KEY).
 */
export const dynamic = "force-dynamic";
export const preferredRegion = "hnd1";

async function relay(req: NextRequest, ctx: { params: Promise<{ token: string; network: string; path: string[] }> }) {
  const { token, network, path } = await ctx.params;
  const expected = serverRelayToken();
  if (!expected || token !== expected) return NextResponse.json({ status: "ERROR", error: { message: "Not found" } }, { status: 404 });
  return relayExtended(req, network, path);
}

export const GET = relay;
export const POST = relay;
export const PATCH = relay;
export const DELETE = relay;
