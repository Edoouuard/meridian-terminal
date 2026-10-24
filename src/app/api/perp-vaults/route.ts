/**
 * GET /api/perp-vaults — perp DEX vaults (HLP, Extended, Lighter LLP,
 * Paradex GigaVault, Jupiter JLP, GMX GLVs, Gains gUSDC, dYdX MegaVault),
 * each read from the protocol's own API and ranked by APR
 * (lib/markets/vaults.ts). A protocol that doesn't answer is left out.
 * Cached a few minutes; feeds the "Perp vaults" list in Yields.
 */
import { NextResponse } from "next/server";
import { EXTENDED_HOSTS } from "@/lib/integrations/extendedProxy";
import {
  HLP_ADDRESS,
  LIGHTER_LLP_QUERY_INDEX,
  PARADEX_GIGAVAULT_ADDRESS,
  parseExtendedVault,
  parseGainsUsdc,
  parseGmxGlvs,
  parseHlp,
  parseJlp,
  parseLighterLlp,
  parseMegavault,
  parseParadexVault,
  rankVaults,
} from "@/lib/markets/vaults";

export const dynamic = "force-dynamic";

const TIMEOUT = 8000;

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT), next: { revalidate: 300 } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export async function GET() {
  const [hlp, extended, lighter, paradex, jlp, gmxApy, gmxInfo, gainsArb, gainsBase, megavault] = await Promise.all([
    getJson("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "vaultDetails", vaultAddress: HLP_ADDRESS }) }),
    getJson(`${EXTENDED_HOSTS.mainnet}/api/v1/vault/public/summary`),
    getJson(`https://mainnet.zklighter.elliot.ai/api/v1/publicPoolsMetadata?index=${LIGHTER_LLP_QUERY_INDEX}&limit=1`),
    getJson(`https://api.prod.paradex.trade/v1/vaults/summary?address=${PARADEX_GIGAVAULT_ADDRESS}`),
    getJson("https://perps-api.jup.ag/v1/jlp-info"),
    getJson("https://arbitrum-api.gmxinfra.io/apy?period=30d"),
    getJson("https://arbitrum-api.gmxinfra.io/glvs/info"),
    getJson("https://backend-global.gains.trade/api/apr?chainId=42161"),
    getJson("https://backend-global.gains.trade/api/apr?chainId=8453"),
    getJson("https://indexer.dydx.trade/v4/vault/v1/megavault/historicalPnl?resolution=day"),
  ]);
  const vaults = rankVaults([
    parseHlp(hlp),
    parseExtendedVault(extended),
    parseLighterLlp(lighter),
    parseParadexVault(paradex),
    parseJlp(jlp),
    ...parseGmxGlvs(gmxApy, gmxInfo, "Arbitrum"),
    parseGainsUsdc(gainsArb, "Arbitrum"),
    parseGainsUsdc(gainsBase, "Base"),
    parseMegavault(megavault),
  ]);
  return NextResponse.json({ fetchedAt: new Date().toISOString(), vaults }, { headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=600" } });
}
