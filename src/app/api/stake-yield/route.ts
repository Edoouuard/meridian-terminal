import { NextResponse } from "next/server";

export const revalidate = 600;

export interface StakeYieldEntry {
  protocol: string;
  symbol: string;
  chain: string;
  apy: number;
  tvlUsd: number;
}

interface RawPool {
  project?: string;
  chain?: string;
  symbol?: string;
  apy?: number;
  apyBase?: number;
  tvlUsd?: number;
}

/** DefiLlama project slug -> display name, for the ETH liquid-staking protocols we compare. */
const LIQUID_STAKING_PROJECTS: Record<string, string> = {
  lido: "Lido",
  "rocket-pool": "Rocket Pool",
  "ether.fi-stake": "ether.fi",
  stakewise: "StakeWise",
  "frax-ether": "Frax Ether",
};

/**
 * Server route backed by DefiLlama's free yields API (no key), same source
 * `/api/yield` already uses: the live APY of every tracked ETH liquid-staking
 * pool (Lido, Rocket Pool, ether.fi, ...) on Ethereum mainnet, ranked
 * highest-first. Meridian only has live EXECUTION wired for Lido — this route
 * exists so the UI can be honest when a competitor's live rate is actually
 * better, rather than silently routing every "stake for the best yield"
 * thesis into Lido regardless. Always 200s (empty array on any upstream
 * failure) so the UI degrades to "no live comparison" rather than erroring.
 */
export async function GET() {
  try {
    const res = await fetch("https://yields.llama.fi/pools", { next: { revalidate: 600 } });
    if (!res.ok) return NextResponse.json<StakeYieldEntry[]>([]);
    const body: { data?: RawPool[] } = await res.json();
    const pools = body.data ?? [];

    const byProtocol: Map<string, StakeYieldEntry> = pools
      .filter(
        (p) =>
          p.project !== undefined &&
          p.project in LIQUID_STAKING_PROJECTS &&
          p.chain === "Ethereum" &&
          typeof (p.apyBase ?? p.apy) === "number" &&
          Number.isFinite(p.apyBase ?? p.apy),
      )
      .map((p) => ({
        protocol: LIQUID_STAKING_PROJECTS[p.project as string],
        symbol: p.symbol ?? "ETH",
        chain: "Ethereum",
        apy: (p.apyBase ?? p.apy) as number,
        tvlUsd: p.tvlUsd ?? 0,
      }))
      // One row per protocol: its deepest (highest-TVL) pool, so a protocol
      // with many small wrapped-token pools doesn't crowd out the others.
      .reduce((acc, entry) => {
        const existing = acc.get(entry.protocol);
        if (!existing || entry.tvlUsd > existing.tvlUsd) acc.set(entry.protocol, entry);
        return acc;
      }, new Map<string, StakeYieldEntry>());
    const ranked = Array.from(byProtocol.values()).sort((a, b) => b.apy - a.apy);

    return NextResponse.json<StakeYieldEntry[]>(ranked);
  } catch {
    return NextResponse.json<StakeYieldEntry[]>([]);
  }
}
