/**
 * feeds.ts — live, read-only market/news feeds for Meridian.
 *
 * Pure fetch helpers against the public Hyperliquid info API (no auth, no key).
 * Each helper normalizes the raw wire response into a typed shape and returns
 * `null` on ANY failure (network error, timeout, non-2xx, malformed payload) so
 * callers can fall back to the static demo data in `src/lib/data.ts` and the UI
 * never breaks. Nothing in this module throws.
 */

export const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
export const FEED_TIMEOUT_MS = 8000;

/** Minimal POST helper. Resolves to parsed JSON, or `null` on any failure. */
async function postInfo<T>(body: unknown, timeoutMs = FEED_TIMEOUT_MS): Promise<T | null> {
  try {
    const res = await fetch(HYPERLIQUID_INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

/** A live perp market row (one entry per coin in the Hyperliquid universe). */
export interface MarketRow {
  coin: string;
  /** Current mark price in USD. */
  markPx: number;
  /** Price 24h ago in USD. */
  prevDayPx: number;
  /** 24h % change (markPx vs prevDayPx). */
  changePct: number;
  /** 24h notional traded in USD — used as a flow proxy. */
  dayNtlVlm: number;
  /** Hourly funding rate as a decimal fraction (e.g. 0.0001 = 1 bp/hr). */
  funding: number;
  /** Notional open interest in USD. */
  openInterest: number;
}

/** Normalized funding snapshot. */
export interface FundingRate {
  coin: string;
  /** Hourly funding as a decimal fraction. */
  funding: number;
  /** Annualized funding as a percentage. */
  annualizedPct: number;
}

/** Normalized liquidity / "TVL-like" estimate (perps don't expose real TVL). */
export interface TvlEstimate {
  /** Total perp open interest in USD. */
  totalOiUsd: number;
  /** Sum of 24h notional volume in USD across markets. */
  totalDayNtlVlm: number;
}

/** One ranked market for the top-movers / flow list. */
export interface MarketMover {
  coin: string;
  markPx: number;
  changePct: number;
  /** 24h notional traded in USD — the flow proxy. */
  dayNtlVlm: number;
}

/** Highest-change market, for the "fastest growing" card. */
export interface FastestGrower {
  coin: string;
  changePct: number;
  dayNtlVlm: number;
}

/** Normalized top-movers + fastest-growing highlight. */
export interface Highlights {
  movers: MarketMover[];
  fastest: FastestGrower | null;
}

/** Combined payload returned by useLiveFeed. */
export interface LiveFeedData {
  funding: FundingRate[];
  tvl: TvlEstimate | null;
  highlights: Highlights | null;
}

interface RawUniverseEntry {
  name?: string;
}

interface RawAssetCtx {
  funding?: string;
  openInterest?: string;
  markPx?: string;
  prevDayPx?: string;
  dayNtlVlm?: string;
}

interface RawMetaAndAssetCtxs {
  universe?: RawUniverseEntry[];
}

/** Fetch the raw perp market snapshot once and map it to normalized rows. */
async function fetchMarketRows(): Promise<MarketRow[] | null> {
  // metaAndAssetCtxs returns `[meta, ctxs]` where meta.universe[i].name is the
  // coin and ctxs[i] is the matching market context (they share the same index).
  const raw = await postInfo<[RawMetaAndAssetCtxs, RawAssetCtx[]]>({ type: "metaAndAssetCtxs" });
  const meta = raw?.[0] as RawMetaAndAssetCtxs | undefined;
  const ctxs = raw?.[1];
  const universe = meta?.universe ?? [];
  const rows: MarketRow[] = [];
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i]?.name;
    const c = ctxs?.[i];
    if (!name || !c) continue;
    const markPx = num(c.markPx);
    const prevDayPx = num(c.prevDayPx);
    const changePct = prevDayPx > 0 ? ((markPx - prevDayPx) / prevDayPx) * 100 : 0;
    rows.push({
      coin: name,
      markPx,
      prevDayPx,
      changePct,
      dayNtlVlm: num(c.dayNtlVlm),
      funding: num(c.funding),
      openInterest: num(c.openInterest),
    });
  }
  return rows.length > 0 ? rows : null;
}

/**
 * Fetch the funding-rate strip (funding per coin), annualized, sorted by
 * absolute annualized funding. Returns `null` if the feed is unavailable.
 */
export async function fetchFundingRates(): Promise<FundingRate[] | null> {
  const rows = await fetchMarketRows();
  if (!rows) return null;
  const rates = rows
    .filter((r) => r.funding !== 0)
    .map((r) => ({
      coin: r.coin,
      funding: r.funding,
      annualizedPct: r.funding * 24 * 365 * 100,
    }))
    .sort((a, b) => Math.abs(b.annualizedPct) - Math.abs(a.annualizedPct))
    .slice(0, 10);
  return rates.length > 0 ? rates : null;
}

/**
 * Estimate aggregate "TVL-like" liquidity from perp open interest + 24h volume.
 * Returns `null` if the feed is unavailable.
 */
export async function fetchTvlEstimate(): Promise<TvlEstimate | null> {
  const rows = await fetchMarketRows();
  if (!rows) return null;
  return {
    totalOiUsd: rows.reduce((s, r) => s + r.openInterest, 0),
    totalDayNtlVlm: rows.reduce((s, r) => s + r.dayNtlVlm, 0),
  };
}

/**
 * Top movers (by |change|, with dayNtlVlm as flow) + the fastest-growing market
 * (highest change). Returns `null` if the feed is unavailable.
 */
export async function fetchHighlights(): Promise<Highlights | null> {
  const rows = await fetchMarketRows();
  if (!rows) return null;
  const byChange = [...rows].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
  const byGrowth = [...rows].sort((a, b) => b.changePct - a.changePct);
  const fastest = byGrowth[0];
  return {
    movers: byChange.slice(0, 6).map((r) => ({
      coin: r.coin,
      markPx: r.markPx,
      changePct: r.changePct,
      dayNtlVlm: r.dayNtlVlm,
    })),
    fastest: fastest && Number.isFinite(fastest.changePct) && fastest.changePct !== 0 ? fastest : null,
  };
}

/**
 * Fetch every live feed in parallel, each independently null-safe.
 * Used by useLiveFeed. Never throws.
 */
export async function fetchLiveFeeds(): Promise<LiveFeedData> {
  const [funding, tvl, highlights] = await Promise.all([fetchFundingRates(), fetchTvlEstimate(), fetchHighlights()]);
  return { funding: funding ?? [], tvl, highlights };
}
