import { NextRequest, NextResponse } from "next/server";
import { checkAllProviders, getAllProviderStatus } from "@/lib/mcp/router";
import { checkAaveHealth, getAaveStatus } from "@/lib/mcp/aave";
import { fetchLifiChains, fetchLifiTokens } from "@/lib/mcp/lifi";
import * as baseMcp from "@/lib/mcp/providers/base";

export const revalidate = 60;

/**
 * GET /api/mcp — health and status of the MCP servers Meridian actually uses.
 *
 * Listed: deBridge + LI.FI (swap/bridge routing) and Aave (markets, positions,
 * previews). Base appears only when BASE_MCP_URL is set — there is no public
 * hosted Base MCP. The "portfolio" provider (/api/haiku) is not listed: it is
 * built on LI.FI + Aave, so it would only duplicate their status.
 *
 * ?action=health  — Run live health checks
 * ?action=status  — Return cached status (fast, no network calls)
 * ?action=chains  — Return LI.FI supported chains
 * ?action=tokens&chainId=N — Return LI.FI tokens on a chain
 */
export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action") ?? "status";

  if (action === "health") {
    const [routeStatuses, aaveStatus, baseStatus] = await Promise.all([
      checkAllProviders(),
      checkAaveHealth(),
      baseMcp.configured ? baseMcp.checkHealth() : Promise.resolve(null),
    ]);
    return NextResponse.json({ providers: [...routeStatuses, aaveStatus, ...(baseStatus ? [baseStatus] : [])] });
  }

  if (action === "status") {
    return NextResponse.json({
      providers: [...getAllProviderStatus(), getAaveStatus(), ...(baseMcp.configured ? [baseMcp.getStatus()] : [])],
    });
  }

  if (action === "chains") {
    const chains = (await fetchLifiChains()).map((c) => ({ id: c.id, name: c.name }));
    return NextResponse.json({ chains });
  }

  if (action === "tokens") {
    const chainId = req.nextUrl.searchParams.get("chainId");
    if (!chainId) {
      return NextResponse.json({ error: "chainId required" }, { status: 400 });
    }
    const tokens = await fetchLifiTokens(Number(chainId));
    return NextResponse.json({ tokens });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
