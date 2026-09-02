import { NextResponse } from "next/server";

export const revalidate = 600;

export interface YieldSnapshot {
  protocol: string;
  asset: string;
  chain: string;
  apy: number;
  apyPct7D: number | null;
  apyPct30D: number | null;
}

interface RawPool {
  project?: string;
  chain?: string;
  symbol?: string;
  apyBase?: number;
  apyPct7D?: number;
  apyPct30D?: number;
  tvlUsd?: number;
}

/**
 * Server route backed by DefiLlama's free yields API (no key): the deepest
 * (highest-TVL) Aave v3 USDC pool on Ethereum mainnet, with its real base
 * APY and 7d/30d percentage-point trend. Replaces a permanently-hardcoded
 * "Pendle fixed 9.8% vs Aave variable 6.8%→5.2%" figure that never had a
 * live source — this has no honest free live source for Pendle's fixed
 * rate, so it deliberately shows only what's real rather than keeping a
 * fabricated comparison. Always 200s (null on any upstream failure) so the
 * UI shows an honest "unavailable" rather than erroring.
 */
export async function GET() {
  try {
    const res = await fetch("https://yields.llama.fi/pools", { next: { revalidate: 600 } });
    if (!res.ok) return NextResponse.json<YieldSnapshot | null>(null);
    const body: { data?: RawPool[] } = await res.json();
    const pools = body.data ?? [];

    const candidate = pools
      .filter((p) => p.project === "aave-v3" && p.chain === "Ethereum" && p.symbol === "USDC" && typeof p.apyBase === "number")
      .sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0))[0];

    if (!candidate || typeof candidate.apyBase !== "number") return NextResponse.json<YieldSnapshot | null>(null);

    return NextResponse.json<YieldSnapshot>({
      protocol: "Aave",
      asset: "USDC",
      chain: "Ethereum",
      apy: candidate.apyBase,
      apyPct7D: typeof candidate.apyPct7D === "number" && Number.isFinite(candidate.apyPct7D) ? candidate.apyPct7D : null,
      apyPct30D: typeof candidate.apyPct30D === "number" && Number.isFinite(candidate.apyPct30D) ? candidate.apyPct30D : null,
    });
  } catch {
    return NextResponse.json<YieldSnapshot | null>(null);
  }
}
