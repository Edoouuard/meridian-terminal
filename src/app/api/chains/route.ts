import { NextResponse } from "next/server";

export const revalidate = 300;

/**
 * Target chains Meridian tracks -> their DefiLlama display name.
 * Hyperliquid is omitted from DefiLlama chain TVL in most datasets; if absent it
 * is simply not returned (callers fall back to the static registry).
 */
const TARGET_CHAINS: { id: string; name: string; ll: string }[] = [
  { id: "ethereum", name: "Ethereum", ll: "Ethereum" },
  { id: "base", name: "Base", ll: "Base" },
  { id: "arbitrum", name: "Arbitrum", ll: "Arbitrum" },
  { id: "optimism", name: "Optimism", ll: "Optimism" },
  { id: "polygon", name: "Polygon", ll: "Polygon" },
  { id: "avalanche", name: "Avalanche", ll: "Avalanche" },
  { id: "solana", name: "Solana", ll: "Solana" },
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
    return TARGET_CHAINS.map((c) => ({ id: c.id, name: c.name, topProtocols: [], live: false }));
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
        chainId: meta?.chainId,
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