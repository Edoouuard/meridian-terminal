/**
 * GET /api/perp-vaults — the vaults perp exchanges run themselves (HLP,
 * Extended Vault, Paradex GigaVault), each read from the exchange's public
 * API and ranked by its APR (lib/markets/vaults.ts). A vault whose API
 * doesn't answer is listed without numbers. Cached a few minutes.
 */
import { NextResponse } from "next/server";
import { EXTENDED_HOSTS } from "@/lib/integrations/extendedProxy";
import { emptyVault, HLP_ADDRESS, PARADEX_GIGAVAULT_ADDRESS, parseExtendedVault, parseHlp, parseParadexVault, rankVaults, type PerpVault } from "@/lib/markets/vaults";

export const dynamic = "force-dynamic";

const TIMEOUT = 8000;

async function read<T>(id: PerpVault["id"], go: () => Promise<Response>, parse: (json: unknown) => T): Promise<T | PerpVault> {
  try {
    const res = await go();
    return res.ok ? parse(await res.json()) : emptyVault(id);
  } catch {
    return emptyVault(id);
  }
}

export async function GET() {
  const opts = { signal: AbortSignal.timeout(TIMEOUT), next: { revalidate: 300 } } as const;
  const vaults = await Promise.all([
    read("hlp", () => fetch("https://api.hyperliquid.xyz/info", { ...opts, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "vaultDetails", vaultAddress: HLP_ADDRESS }) }), parseHlp),
    read("extended", () => fetch(`${EXTENDED_HOSTS.mainnet}/api/v1/vault/public/summary`, opts), parseExtendedVault),
    read("paradex", () => fetch(`https://api.prod.paradex.trade/v1/vaults/summary?address=${PARADEX_GIGAVAULT_ADDRESS}`, opts), parseParadexVault),
  ]);
  return NextResponse.json({ fetchedAt: new Date().toISOString(), vaults: rankVaults(vaults as PerpVault[]) }, { headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=600" } });
}
