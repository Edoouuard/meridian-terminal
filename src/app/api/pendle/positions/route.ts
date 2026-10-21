import { NextRequest, NextResponse } from "next/server";
import { isAddress, type Address } from "viem";
import { fetchPendlePositions } from "@/lib/integrations/pendlePositions";

/**
 * GET /api/pendle/positions?address=0x… → the wallet's Pendle PT / YT / LP
 * positions with USD value and maturity (lib/integrations/pendlePositions.ts).
 * Always 200: { positions, status } so the portfolio shows what it can.
 */
export async function GET(req: NextRequest) {
  const address = new URL(req.url).searchParams.get("address") ?? "";
  if (!isAddress(address)) return NextResponse.json({ error: "address required" }, { status: 400 });
  try {
    return NextResponse.json({ status: "ok", positions: await fetchPendlePositions(address as Address) });
  } catch (err) {
    console.error("[pendle-positions]", err instanceof Error ? err.message : err);
    return NextResponse.json({ status: "unavailable", positions: [] });
  }
}
