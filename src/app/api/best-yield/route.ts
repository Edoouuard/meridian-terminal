import { NextResponse } from "next/server";

export const revalidate = 600;

export interface BestYieldEntry {
  protocol: string;
  chain: string;
  symbol: string;
  apy: number;
  tvlUsd: number;
  /** "lending" (a money market, principal-ish) vs "lp" (a liquidity pool — exposed to impermanent loss / IL). Honest risk signal, not a score. */
  kind: "lending" | "lp";
  url?: string;
}

interface RawPool {
  project?: string;
  chain?: string;
  symbol?: string;
  apy?: number;
  apyBase?: number;
  apyReward?: number;
  tvlUsd?: number;
  exposure?: string;
  poolMeta?: string;
  url?: string;
}

/** DefiLlama project slug -> display name, for projects we're willing to surface in a "best yield" search. */
const KNOWN_PROJECTS: Record<string, string> = {
  "aave-v3": "Aave",
  "compound-v3": "Compound",
  morpho: "Morpho",
  "morpho-blue": "Morpho",
  spark: "Spark",
  "sky-lending": "Sky",
  fluid: "Fluid",
  "uniswap-v3": "Uniswap",
  curve: "Curve",
  "curve-dex": "Curve",
};

/** Floors out dust/scam-sized pools — same philosophy as /api/alpha. */
const MIN_TVL_USD = 500_000;

/**
 * Server route backed by DefiLlama's free yields API (no key — same source
 * /api/yield and /api/stake-yield already use): the live-ranked APY for a
 * given asset symbol across every lending market and liquidity pool
 * DefiLlama tracks for one of KNOWN_PROJECTS, highest first. This is the
 * data layer behind a "find the best yield on X" thesis (tradePlan's
 * yieldSearch intent) — the whole point is comparing across protocols
 * Meridian doesn't have execution wired for yet, not just the ones it does,
 * so the UI can honestly say what the live market actually offers before
 * narrowing to what's clickable today.
 *
 * `kind: "lp"` pools (Uniswap/Curve) carry real impermanent-loss risk that
 * `kind: "lending"` pools don't — surfaced as a field, not collapsed into
 * one undifferentiated number.
 *
 * Always 200s with an array (empty on any upstream failure) so the UI shows
 * an honest "no live yield data" rather than erroring.
 */
export async function GET(req: Request) {
  const symbol = new URL(req.url).searchParams.get("symbol")?.trim().toUpperCase();
  if (!symbol) return NextResponse.json<BestYieldEntry[]>([]);

  try {
    const res = await fetch("https://yields.llama.fi/pools", { next: { revalidate: 600 } });
    if (!res.ok) return NextResponse.json<BestYieldEntry[]>([]);
    const body: { data?: RawPool[] } = await res.json();
    const pools = body.data ?? [];

    const matches: Map<string, BestYieldEntry> = pools
      .filter(
        (p) =>
          p.project !== undefined &&
          p.project in KNOWN_PROJECTS &&
          (p.symbol ?? "").toUpperCase() === symbol &&
          typeof (p.apyBase ?? p.apy) === "number" &&
          Number.isFinite(p.apyBase ?? p.apy) &&
          (p.apyBase ?? p.apy ?? 0) > 0 &&
          (p.tvlUsd ?? 0) > MIN_TVL_USD,
      )
      .map((p) => ({
        protocol: KNOWN_PROJECTS[p.project as string],
        chain: p.chain ?? "unknown",
        symbol: p.symbol ?? symbol,
        apy: (p.apyBase ?? p.apy) as number,
        tvlUsd: p.tvlUsd ?? 0,
        kind: (p.exposure === "multi" || /uniswap|curve/i.test(p.project ?? "") ? "lp" : "lending") as "lending" | "lp",
        url: p.url,
      }))
      // One row per protocol+chain: its deepest pool, so a protocol with
      // many near-duplicate pools for the same asset doesn't crowd the list.
      .reduce((acc, entry) => {
        const key = `${entry.protocol}:${entry.chain}`;
        const existing = acc.get(key);
        if (!existing || entry.tvlUsd > existing.tvlUsd) acc.set(key, entry);
        return acc;
      }, new Map<string, BestYieldEntry>());

    const ranked = Array.from(matches.values())
      .sort((a, b) => b.apy - a.apy)
      .slice(0, 15);

    return NextResponse.json<BestYieldEntry[]>(ranked);
  } catch {
    return NextResponse.json<BestYieldEntry[]>([]);
  }
}
