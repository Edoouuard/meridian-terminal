/**
 * scan.ts — price gaps between a token on-chain (its deepest DEX pool on
 * Ethereum, Arbitrum, Base or Optimism) and the same asset's perp on
 * Hyperliquid, Extended and TxFlow, net of what trading the gap costs.
 *
 * The trade a gap calls for is a hedged convergence: buy where it is cheap
 * and sell where it is dear, the same quantity, then unwind both when the
 * gap closes.
 *   - perp above the DEX: buy the token on-chain, short the perp;
 *   - perp below the DEX: sell the token on-chain (it must be in the
 *     wallet), long the perp.
 * The gross profit is the gap itself (if it closes); the costs are the
 * round trip on both sides: DEX fees and price impact in and out, gas in and
 * out, the perp's taker fee in and out. A perp can trade above or below
 * spot for a while (its basis follows funding), so the funding the perp leg
 * collects or pays while waiting is reported beside it.
 *
 * Pure: prices come in, ranked opportunities come out. DEX prices here are
 * pool mid prices (DexScreener) and the costs are estimates; the exact
 * on-chain price for a size comes from a router quote before trading
 * (components/ArbView).
 */

import type { MarketQuote, PerpVenueName } from "@/lib/planner/markets";

export interface DexPrice {
  chainId: number;
  /** The token's symbol on that chain (WETH, cbBTC, ARB). */
  symbol: string;
  address: string;
  decimals: number;
  /** What it tracks on the perp venues (ETH, BTC, ARB). */
  base: string;
  priceUsd: number;
  /** The deepest pool's liquidity, USD. */
  liquidityUsd: number;
  dex: string;
}

export type ArbDirection = "buy-onchain-short-perp" | "sell-onchain-long-perp";

export interface ArbOpportunity {
  base: string;
  dex: DexPrice;
  venue: PerpVenueName;
  market: string;
  perpPx: number;
  /** (perp − DEX) / DEX, %. */
  gapPct: number;
  direction: ArbDirection;
  /** Round-trip costs at `sizeUsd`, % of the size: DEX fee + impact, gas, perp taker, in and out. */
  costPct: number;
  /** |gap| − costs, %: what the trade keeps if the gap closes. */
  netPct: number;
  netUsd: number;
  /** Funding the perp leg earns (+) or pays (−) a day while held, % of the size. */
  fundingPctPerDay: number;
  sizeUsd: number;
}

/** Perp bases a token stands for on-chain (wrapped and bridged forms). */
const BASE_OF: Record<string, string> = { WETH: "ETH", WBTC: "BTC", CBBTC: "BTC", TBTC: "BTC" };
/** Tokens worth scanning: majors and governance tokens listed as perps. Stables and LSTs track their own prices. */
const SKIP = /^(USDC|USDT|USDT0|USDBC|DAI|USDS|USDE|SUSDE|GHO|CRVUSD|FRAX|STETH|WSTETH|WEETH|RETH|CBETH|RSETH|WRSETH|EZETH)$/i;

export function perpBaseOf(symbol: string): string | null {
  const s = symbol.toUpperCase();
  if (SKIP.test(s)) return null;
  return BASE_OF[s] ?? s;
}

/** DEX swap fee assumed for the round trip's estimate, % per swap (a router finds 0.05% pools for majors). */
export const DEX_FEE_PCT = 0.05;
/** Gas per swap, USD, by chain. */
export const GAS_USD: Record<number, number> = { 1: 4, 42161: 0.05, 8453: 0.03, 10: 0.03 };

/** Price impact of a swap of `sizeUsd` into a pool with `liquidityUsd` (both sides), % — constant-product estimate. */
export function impactPct(sizeUsd: number, liquidityUsd: number): number {
  if (!(liquidityUsd > 0)) return 100;
  const side = liquidityUsd / 2;
  return (sizeUsd / (side + sizeUsd)) * 100;
}

export function scanArb(
  dex: DexPrice[],
  perps: MarketQuote[],
  opts: { sizeUsd: number; minLiquidityUsd?: number; minPerpVolumeUsd?: number },
): ArbOpportunity[] {
  const minLiq = opts.minLiquidityUsd ?? 250_000;
  const minVol = opts.minPerpVolumeUsd ?? 1_000_000;
  const out: ArbOpportunity[] = [];
  for (const d of dex) {
    if (!(d.priceUsd > 0) || d.liquidityUsd < minLiq) continue;
    for (const q of perps) {
      if (q.kind !== "perp" || q.base.toUpperCase() !== d.base || !(q.markUsd > 0) || q.dayVolumeUsd < minVol) continue;
      const gapPct = (q.markUsd / d.priceUsd - 1) * 100;
      const direction: ArbDirection = gapPct >= 0 ? "buy-onchain-short-perp" : "sell-onchain-long-perp";
      const gas = ((GAS_USD[d.chainId] ?? 1) * 2 * 100) / opts.sizeUsd;
      const costPct = 2 * (DEX_FEE_PCT + impactPct(opts.sizeUsd, d.liquidityUsd)) + gas + 2 * q.takerFee * 100;
      const netPct = Math.abs(gapPct) - costPct;
      // Funding: positive = longs pay shorts. The short earns it, the long pays it.
      const perDay = q.fundingHourly * 24 * 100;
      out.push({
        base: d.base,
        dex: d,
        venue: q.venue,
        market: q.market,
        perpPx: q.markUsd,
        gapPct,
        direction,
        costPct,
        netPct,
        netUsd: (netPct / 100) * opts.sizeUsd,
        fundingPctPerDay: direction === "buy-onchain-short-perp" ? perDay : -perDay,
        sizeUsd: opts.sizeUsd,
      });
    }
  }
  return out.sort((a, b) => b.netPct - a.netPct);
}

/** DexScreener chain slugs for the chains Meridian signs swaps on. */
export const DEXSCREENER_CHAIN: Record<number, string> = { 1: "ethereum", 42161: "arbitrum", 8453: "base", 10: "optimism" };

interface DexScreenerPair {
  chainId?: string;
  dexId?: string;
  baseToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
}

/**
 * The deepest pool per token from a DexScreener /tokens/v1 answer, where the
 * token is the pool's base (its priceUsd is then the token's price).
 */
export function dexPricesFrom(pairs: unknown, tokens: { chainId: number; symbol: string; address: string; decimals: number }[]): DexPrice[] {
  if (!Array.isArray(pairs)) return [];
  const out: DexPrice[] = [];
  for (const t of tokens) {
    const base = perpBaseOf(t.symbol);
    if (!base) continue;
    const slug = DEXSCREENER_CHAIN[t.chainId];
    const best = (pairs as DexScreenerPair[])
      .filter((p) => p.chainId === slug && p.baseToken?.address?.toLowerCase() === t.address.toLowerCase() && Number(p.priceUsd) > 0)
      .sort((x, y) => (y.liquidity?.usd ?? 0) - (x.liquidity?.usd ?? 0))[0];
    if (!best) continue;
    out.push({ chainId: t.chainId, symbol: t.symbol, address: t.address, decimals: t.decimals, base, priceUsd: Number(best.priceUsd), liquidityUsd: best.liquidity?.usd ?? 0, dex: best.dexId ?? "dex" });
  }
  return out;
}

/** The executable price of a swap quote, USD per token: USD in over tokens out (buy), or USD out over tokens in (sell). */
export function executablePrice(usdAmount: number, tokenAmountBase: bigint, decimals: number): number | null {
  const tokens = Number(tokenAmountBase) / 10 ** decimals;
  return tokens > 0 ? usdAmount / tokens : null;
}
