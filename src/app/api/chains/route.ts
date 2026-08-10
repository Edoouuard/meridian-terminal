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
 * Server route backed by DefiLlama's free API (no key): returns, for each
 * tracked chain, its real total TVL + its ~5 biggest protocols by TVL, so the
 * terminal shows live chain/protocol/pool coverage with zero manual data.
 * Falls back to the static registry (protocol names only) if DefiLlama fails,
 * so the endpoint never 500s.
 */
export async function GET() {
  const staticFallback = () => {
    // Build a name-only fallback from the static registry (kept dependency-free).
    return TARGET_CHAINS.map((c) => ({ id: c.id, name: c.name, topProtocols: [], live: false }));
  };

  try {
    const [chainsRes, protocolsRes] = await Promise.all([
      fetch("https://api.llama.fi/chains", { next: { revalidate: 300 } }),
      fetch("https://api.llama.fi/protocols", { next: { revalidate: 300 } }),
    ]);
    if (!chainsRes.ok || !protocolsRes.ok) return NextResponse.json(staticFallback());

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

    return NextResponse.json(
      TARGET_CHAINS.map((c) => {
        const meta = chainMeta.get(c.ll);
        const top = protocolsData
          .filter((p) => p.chains?.includes(c.ll) || p.chain === c.ll)
          .map((p) => ({ name: p.name, tvlUsd: Math.round(tvlFor(p, c.ll)), category: p.category ?? "other" }))
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
      }),
    );
  } catch {
    return NextResponse.json(staticFallback());
  }
}