/**
 * GET /api/arb-scan?size=1000 — price gaps between tokens on-chain (their
 * deepest DEX pool on Ethereum, Arbitrum, Base, Optimism, from DexScreener)
 * and the same asset's perp on Hyperliquid, Extended and TxFlow, net of
 * the round trip's estimated costs at `size` USD (lib/arb/scan.ts). Public
 * data only, cached briefly at the edge.
 */
import { NextResponse } from "next/server";
import { fetchPerpSnapshot } from "@/lib/perpFeed";
import { TRACKED_TOKENS_BY_CHAIN } from "@/lib/onchain";
import { DEXSCREENER_CHAIN, dexPricesFrom, perpBaseOf, scanArb, type DexPrice } from "@/lib/arb/scan";

export const dynamic = "force-dynamic";

/** The tokens worth pricing on each chain: those with a perp base. */
function scanTokens() {
  return Object.keys(DEXSCREENER_CHAIN).flatMap((id) =>
    (TRACKED_TOKENS_BY_CHAIN[Number(id)] ?? []).filter((t) => perpBaseOf(t.symbol)).map((t) => ({ chainId: Number(id), symbol: t.symbol, address: t.address, decimals: t.decimals })),
  );
}

async function dexPrices(): Promise<DexPrice[]> {
  const tokens = scanTokens();
  const byChain = new Map<number, typeof tokens>();
  for (const t of tokens) byChain.set(t.chainId, [...(byChain.get(t.chainId) ?? []), t]);
  const answers = await Promise.all(
    [...byChain.entries()].map(async ([chainId, ts]) => {
      // One request per chain, up to 30 tokens.
      const url = `https://api.dexscreener.com/tokens/v1/${DEXSCREENER_CHAIN[chainId]}/${ts.slice(0, 30).map((t) => t.address).join(",")}`;
      const res = await fetch(url, { next: { revalidate: 20 } }).catch(() => null);
      return res?.ok ? dexPricesFrom(await res.json().catch(() => null), ts) : [];
    }),
  );
  return answers.flat();
}

export async function GET(req: Request) {
  const size = Math.min(1_000_000, Math.max(10, Number(new URL(req.url).searchParams.get("size")) || 1000));
  const [dex, snapshot] = await Promise.all([dexPrices(), fetchPerpSnapshot()]);
  const opportunities = scanArb(dex, snapshot.quotes, { sizeUsd: size });
  return NextResponse.json(
    { fetchedAt: new Date().toISOString(), sizeUsd: size, dexCount: dex.length, opportunities },
    { headers: { "cache-control": "public, s-maxage=15, stale-while-revalidate=30" } },
  );
}
