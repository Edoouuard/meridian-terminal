import { NextResponse } from "next/server";
import { ACTIVE_CHAIN_IDS, CHAIN_LABEL } from "@/lib/onchain";
import { LLAMA_CHAIN_ID } from "@/lib/protocols/registry";
import { FEATURES } from "@/lib/features";

export const revalidate = 300;

/**
 * The chains Meridian executes on (lib/onchain.ts ACTIVE_CHAIN_IDS), each with
 * its DefiLlama display name (HyperEVM is "Hyperliquid L1" there), plus
 * Solana when its panel is on. The chain id is fixed here, never read back
 * from DefiLlama, so the Chains tab can join each row to Meridian's coverage.
 */
const LLAMA_NAME: Record<number, string> = Object.fromEntries(Object.entries(LLAMA_CHAIN_ID).map(([name, id]) => [id, name]));
const TARGET_CHAINS: { id: string; name: string; ll: string; chainId?: number }[] = [
  ...ACTIVE_CHAIN_IDS.map((chainId) => ({ id: String(chainId), name: CHAIN_LABEL[chainId] ?? String(chainId), ll: LLAMA_NAME[chainId] ?? CHAIN_LABEL[chainId] ?? "", chainId })),
  ...(FEATURES.solana ? [{ id: "solana", name: "Solana", ll: "Solana" }] : []),
];

/** Exclude centralized exchanges / wrapped-token placeholders from "biggest protocols". */
const EXCLUDE_PROTOCOL = /CEX|Binance|Coinbase|OKX|Kraken|Bitfinex|Bybit|KuCoin|Crypto\.com|Gemini|Wrapped|WETH|WBTC| Staked ETH/i;

export interface LiveProtocol {
  name: string;
  tvlUsd: number;
  category: string;
}

export interface LiveChainOverview {
  id: string;
  name: string;
  chainId?: number;
  tvlUsd?: number;
  topProtocols: LiveProtocol[];
  live: boolean;
}

/**
 * Last successful snapshot, kept in module scope — same pattern as
 * /api/prices and /api/alpha. A warm instance serves its last real snapshot
 * on a transient DefiLlama failure instead of dropping straight to the
 * name-only static fallback, which has no TVL data at all.
 */
let lastGood: { chains: LiveChainOverview[]; fetchedAt: number } | null = null;
const MAX_STALE_MS = 30 * 60_000;

/**
 * Server route backed by DefiLlama's free API (no key): returns, for each
 * tracked chain, its real total TVL + its ~5 biggest protocols by TVL, so the
 * terminal shows live chain/protocol/pool coverage with zero manual data.
 * Falls back to the last good snapshot (if still fresh enough), then to the
 * static registry (protocol names only, `live: false`) if DefiLlama fails and
 * there's no usable cache, so the endpoint never 500s.
 */
export async function GET() {
  const staticFallback = () => {
    // Build a name-only fallback from the static registry (kept dependency-free).
    return TARGET_CHAINS.map((c) => ({ id: c.id, name: c.name, chainId: c.chainId, topProtocols: [], live: false }));
  };

  const fallback = (reason: string) => {
    const usable = lastGood && Date.now() - lastGood.fetchedAt <= MAX_STALE_MS;
    console.error(
      `[api/chains] ${reason}` +
        (usable
          ? ` — serving cached snapshot from ${Math.round((Date.now() - lastGood!.fetchedAt) / 1000)}s ago`
          : " — no usable cached snapshot, falling back to static registry"),
    );
    return NextResponse.json(usable ? lastGood!.chains : staticFallback());
  };

  try {
    const [chainsRes, protocolsRes] = await Promise.all([
      fetch("https://api.llama.fi/chains", { next: { revalidate: 300 }, signal: AbortSignal.timeout(8000) }),
      fetch("https://api.llama.fi/protocols", { next: { revalidate: 300 }, signal: AbortSignal.timeout(8000) }),
    ]);
    if (!chainsRes.ok || !protocolsRes.ok) {
      return fallback(`DefiLlama responded ${chainsRes.status}/${protocolsRes.status}`);
    }

    const chainsData: { name: string; chainId?: number; tvl?: number }[] = await chainsRes.json();
    const protocolsData: { name: string; category?: string; chain?: string; chains?: string[]; tvl?: number; chainTvls?: Record<string, number> }[] =
      await protocolsRes.json();

    // Chain TVL + chainId by display name.
    const chainMeta = new Map<string, { chainId?: number; tvl?: number }>();
    for (const c of chainsData) chainMeta.set(c.name, { chainId: c.chainId, tvl: c.tvl });

    // Per-chain protocol TVL: prefer the per-chain tvl, else the total.
    const tvlFor = (p: (typeof protocolsData)[number], chain: string) => {
      const per = p.chainTvls?.[chain];
      return typeof per === "number" ? per : p.chain === chain ? p.tvl ?? 0 : p.chains?.includes(chain) ? p.tvl ?? 0 : 0;
    };

    const chains = TARGET_CHAINS.map((c) => {
      const meta = chainMeta.get(c.ll);
      const top = protocolsData
        .filter((p) => p.chains?.includes(c.ll) || p.chain === c.ll)
        .map((p) => ({ name: p.name, tvlUsd: Math.round(tvlFor(p, c.ll)), category: p.category ?? "other" }))
        .filter((p) => !EXCLUDE_PROTOCOL.test(p.name))
        .filter((p) => p.tvlUsd > 0)
        .sort((a, b) => b.tvlUsd - a.tvlUsd)
        .slice(0, 5);
      return {
        id: c.id,
        name: c.name,
        chainId: c.chainId ?? meta?.chainId,
        tvlUsd: meta?.tvl ? Math.round(meta.tvl) : undefined,
        topProtocols: top,
        live: true,
      } as LiveChainOverview;
    });

    lastGood = { chains, fetchedAt: Date.now() };
    return NextResponse.json(chains);
  } catch (err) {
    return fallback(`DefiLlama fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}