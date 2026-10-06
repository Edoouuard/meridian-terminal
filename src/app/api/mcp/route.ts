import { NextRequest, NextResponse } from "next/server";
import { checkAllProviders, getAllProviderStatus } from "@/lib/mcp/router";
import * as lifi from "@/lib/mcp/providers/lifi";
import * as haiku from "@/lib/mcp/providers/haiku";
import * as baseMcp from "@/lib/mcp/providers/base";

export const revalidate = 60;

/**
 * GET /api/mcp — MCP provider health and status (all 4 providers).
 *
 * ?action=health  — Run live health checks on all providers (Haiku, deBridge, LI.FI, Base)
 * ?action=status  — Return cached status (fast, no network calls)
 * ?action=chains  — Return LI.FI supported chains
 * ?action=tokens&chainId=N — Return LI.FI tokens on a chain
 */
export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action") ?? "status";

  if (action === "health") {
    const [routeStatuses, haikuStatus, baseStatus] = await Promise.all([
      checkAllProviders(),
      haiku.checkHealth(),
      baseMcp.checkHealth(),
    ]);
    return NextResponse.json({ providers: [...routeStatuses, haikuStatus, baseStatus] });
  }

  if (action === "status") {
    const routeStatuses = getAllProviderStatus();
    return NextResponse.json({
      providers: [...routeStatuses, haiku.getStatus(), baseMcp.getStatus()],
    });
  }

  if (action === "chains") {
    const chains = await lifi.getSupportedChains();
    return NextResponse.json({ chains });
  }

  if (action === "tokens") {
    const chainId = req.nextUrl.searchParams.get("chainId");
    if (!chainId) {
      return NextResponse.json({ error: "chainId required" }, { status: 400 });
    }
    const tokens = await lifi.getTokens(Number(chainId));
    return NextResponse.json({ tokens });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
