/**
 * integrations/pendle.ts — Pendle fixed yield (buy PT, hold to maturity).
 *
 * Buying a Principal Token locks in the market's implied APY: the PT trades
 * at a discount and redeems 1:1 for the underlying at expiry. Market data
 * and the swap transaction come from Pendle's hosted API; the transaction
 * always targets Pendle's RouterV4, which Meridian verifies against its own
 * allowlist below before anything can be signed (same bar as LI.FI/deBridge
 * quotes, see mcp/routerAllowlist.ts).
 *
 * Pure parsing lives here (unit-tested); the fetches run server-side via
 * /api/pendle.
 */

import type { Address } from "viem";
import { MIN_VAULT_TVL_USD } from "@/lib/vaultPolicy";

const PENDLE_API = process.env.PENDLE_API_URL || "https://api-v2.pendle.finance/core";

/**
 * Pendle RouterV4 — one deterministic deployment address. Code checked
 * on-chain on Ethereum, Arbitrum and Base (e2e/onchain.audit.test.ts).
 */
export const PENDLE_ROUTER_V4: Address = "0x888888888889758F76e7103c6CbF23ABbF58F946";

/** Chains Meridian buys PT on. */
export const PENDLE_CHAINS = [1, 42161, 8453] as const;

export function isTrustedPendleRouter(chainId: number, address: string): boolean {
  return (PENDLE_CHAINS as readonly number[]).includes(chainId) && address.toLowerCase() === PENDLE_ROUTER_V4.toLowerCase();
}

/**
 * Major stablecoins (or their native savings wrappers) whose Pendle markets
 * are offered even when Pendle hasn't flagged them prime. Exact market names,
 * case-insensitive — exotic RWA/points stables never pass.
 */
export const MAJOR_STABLE_MARKETS = ["USDC", "USDT", "DAI", "sDAI", "USDS", "sUSDS", "USDe", "sUSDe", "GHO", "PYUSD"] as const;

export function isMajorStableMarket(name: string): boolean {
  const n = name.trim().toLowerCase();
  return MAJOR_STABLE_MARKETS.some((s) => s.toLowerCase() === n);
}

/** Markets closer than this to expiry aren't offered: too little time to earn the fixed rate. */
export const MIN_DAYS_TO_EXPIRY = 14;

export interface PendleMarket {
  chainId: number;
  name: string;
  address: Address;
  pt: Address;
  expiry: string;
  /** Fixed APY locked in by buying PT now (percent). */
  impliedApyPct: number;
  liquidityUsd: number;
  /** Pendle's own curated flag. */
  isPrime: boolean;
  /** Underlying is a major stablecoin (MAJOR_STABLE_MARKETS). Every parsed market is prime, major-stable, or both. */
  majorStable: boolean;
  categories: string[];
}

interface RawMarket {
  name?: string;
  address?: string;
  expiry?: string;
  pt?: string;
  isPrime?: boolean;
  categoryIds?: string[];
  details?: { liquidity?: number; impliedApy?: number };
}

/** "42161-0xabc…" → "0xabc…" (Pendle prefixes token ids with the chain). */
function stripChain(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const i = id.indexOf("-");
  return i >= 0 ? id.slice(i + 1) : id;
}

/**
 * Parse Pendle's /markets/active payload, keeping only markets a user can
 * sensibly lock into now: Pendle "prime" (its own curated list) or a major
 * stablecoin market (MAJOR_STABLE_MARKETS) — the rest are mostly exotic
 * RWA/points stables — with at least MIN_VAULT_TVL_USD of
 * liquidity and more than MIN_DAYS_TO_EXPIRY days left. Sorted by implied APY.
 * This is the only gate: the chat, the picker and /api/pendle all see this list.
 */
export function parsePendleMarkets(chainId: number, body: unknown, now: Date = new Date()): PendleMarket[] {
  const list = (body as { markets?: unknown } | null)?.markets;
  const raw: RawMarket[] = Array.isArray(list) ? list : [];
  const minExpiry = now.getTime() + MIN_DAYS_TO_EXPIRY * 86_400_000;
  return raw
    .map((m): PendleMarket | null => {
      const pt = stripChain(m.pt);
      const expiry = m.expiry ? Date.parse(m.expiry) : NaN;
      const apy = m.details?.impliedApy;
      const liquidity = m.details?.liquidity;
      if (!m.name || !m.address || !pt || !Number.isFinite(expiry) || typeof apy !== "number" || typeof liquidity !== "number") return null;
      const majorStable = isMajorStableMarket(m.name);
      if ((m.isPrime !== true && !majorStable) || expiry < minExpiry || liquidity < MIN_VAULT_TVL_USD || !(apy > 0)) return null;
      return {
        chainId,
        name: m.name,
        address: m.address as Address,
        pt: pt as Address,
        expiry: new Date(expiry).toISOString(),
        impliedApyPct: apy * 100,
        liquidityUsd: liquidity,
        isPrime: m.isPrime === true,
        majorStable,
        categories: m.categoryIds ?? [],
      };
    })
    .filter((m): m is PendleMarket => m !== null)
    .sort((a, b) => b.impliedApyPct - a.impliedApyPct);
}

/** Bare market name from a leg asset: "PT-sUSDe" / "PT sUSDe" / "sUSDe PT" → "sUSDe". */
export function marketNameFromAsset(asset: string): string {
  return asset.trim().replace(/^PT[-\s]+/i, "").replace(/\s+PT$/i, "").trim();
}

/** Whether a market's underlying is ETH-denominated (bought with WETH rather than USDC). */
export function isEthMarket(m: Pick<PendleMarket, "name" | "categories">): boolean {
  return m.categories.includes("eth") || /eth/i.test(m.name);
}

/**
 * Pick the market for a leg among those parsePendleMarkets kept (prime or major stable):
 * an exact name match first (the plan named one), else the highest fixed APY
 * of the right kind (stables for a USD leg, ETH for an ETH leg). None of the
 * kind → undefined, and the leg says so rather than reaching for another market.
 */
export function pickPendleMarket(markets: PendleMarket[], asset: string): PendleMarket | undefined {
  const name = marketNameFromAsset(asset).toLowerCase();
  const exact = markets.find((m) => m.name.toLowerCase() === name);
  if (exact) return exact;
  const wantEth = /eth/i.test(name);
  const ofKind = markets.filter((m) => (wantEth ? isEthMarket(m) : (m.categories.includes("stables") || m.majorStable) && !isEthMarket(m)));
  return ofKind[0]; // already sorted by fixed APY
}

export interface PendleBuyQuote {
  tx: { to: Address; data: `0x${string}`; value?: string };
  /** PT received (base units), when the API reports it. */
  ptOut?: string;
  priceImpact?: number;
}

/** Parse Pendle's /sdk/{chain}/convert response into the router call to sign. */
export function parsePendleConvert(body: unknown): PendleBuyQuote | null {
  const route = (body as { routes?: Record<string, unknown>[] } | null)?.routes?.[0];
  const tx = route?.tx as { to?: string; data?: string; value?: string } | undefined;
  if (!tx?.to || !tx.data || !/^0x[0-9a-fA-F]*$/.test(tx.data)) return null;
  const outputs = route?.outputs as { amount?: string }[] | undefined;
  const data = route?.data as { priceImpact?: number } | undefined;
  return {
    tx: { to: tx.to as Address, data: tx.data as `0x${string}`, value: tx.value && tx.value !== "0" ? tx.value : undefined },
    ptOut: outputs?.[0]?.amount,
    priceImpact: typeof data?.priceImpact === "number" ? data.priceImpact : undefined,
  };
}

export async function fetchPendleMarkets(chainId: number): Promise<PendleMarket[]> {
  try {
    const res = await fetch(`${PENDLE_API}/v1/${chainId}/markets/active`, { next: { revalidate: 300 } });
    if (!res.ok) return [];
    return parsePendleMarkets(chainId, await res.json());
  } catch {
    return [];
  }
}

export async function fetchPendleBuyQuote(input: {
  chainId: number;
  pt: Address;
  tokenIn: Address;
  amountIn: string;
  receiver: Address;
  slippage?: number;
}): Promise<PendleBuyQuote | null> {
  const qs = new URLSearchParams({
    receiver: input.receiver,
    slippage: String(input.slippage ?? 0.005),
    enableAggregator: "true",
    tokensIn: input.tokenIn,
    amountsIn: input.amountIn,
    tokensOut: input.pt,
  });
  try {
    const res = await fetch(`${PENDLE_API}/v2/sdk/${input.chainId}/convert?${qs}`, { cache: "no-store" });
    if (!res.ok) return null;
    return parsePendleConvert(await res.json());
  } catch {
    return null;
  }
}
