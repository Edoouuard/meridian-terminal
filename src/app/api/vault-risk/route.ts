import { NextRequest, NextResponse } from "next/server";
import { PHILIDOR_PROTOCOL_ID, searchVaults, type VaultRisk } from "@/lib/integrations/philidor";

export const revalidate = 300;

/**
 * Server route wrapping Philidor's free vault-risk API (see
 * src/lib/integrations/philidor.ts). Accepts the same Meridian protocol
 * display names used elsewhere in the app (Aave, Morpho, ...) via
 * `?protocol=Aave,Morpho` and translates them to Philidor's protocol ids so
 * callers never need to know that mapping. `asset` and `limit` pass through.
 * Always 200s with an array (empty on any upstream failure) so the UI never
 * has to special-case a route error.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const protocolNames = searchParams.get("protocol");
  const asset = searchParams.get("asset") ?? undefined;
  const limitParam = searchParams.get("limit");
  const limit = limitParam ? parseInt(limitParam, 10) : undefined;

  const protocolIds = protocolNames
    ?.split(",")
    .map((p) => PHILIDOR_PROTOCOL_ID[p.trim()])
    .filter((id): id is string => !!id)
    .join(",");

  const vaults = await searchVaults({
    protocol: protocolIds || undefined,
    asset,
    limit,
    sortBy: "total_score",
    sortOrder: "desc",
  });

  return NextResponse.json<VaultRisk[]>(vaults ?? []);
}
