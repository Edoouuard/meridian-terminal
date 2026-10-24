/**
 * funding.ts — funding rates across nine perp venues, in one shape, and the
 * cross-venue pairs they make (the "funding arbitrage" board, arb.sh-style).
 *
 * Three venues are the ones Meridian trades (Hyperliquid, Extended, TxFlow,
 * from lib/perpFeed.ts): their pairs carry fees and can be opened from the
 * terminal. Six more are read-only references, each from its own public API:
 *   - Lighter, Binance, Bybit: Lighter's /api/v1/funding-rates lists all
 *     three, every rate normalised to 8 hours (checked against Hyperliquid's
 *     own hourly rate in the same answer: ARB 0.0001 / 8h = 0.0000125 / h);
 *   - Paradex: /v1/markets/summary?market=ALL, `funding_rate` per
 *     `funding_interval_minutes`;
 *   - dYdX: indexer /v4/perpetualMarkets, `nextFundingRate` per hour;
 *   - Aster: /fapi/v1/premiumIndex `lastFundingRate` per the interval
 *     /fapi/v1/fundingInfo gives (1, 2, 4 or 8 hours; 8 when unlisted).
 * Rates are kept as a % a year, positive = longs pay shorts. Pure parsers,
 * unit-tested; the fetches live in /api/funding-board.
 */

import type { MarketQuote } from "@/lib/planner/markets";
import { marketBase } from "@/lib/perpVenues";

const HOURS_PER_YEAR = 8760;

export type FundingVenue = "Hyperliquid" | "Extended" | "TxFlow" | "Lighter" | "Binance" | "Bybit" | "Paradex" | "dYdX" | "Aster";

/** The venues Meridian signs orders on. */
export const EXECUTABLE_VENUES: readonly FundingVenue[] = ["Hyperliquid", "Extended", "TxFlow"];

export interface FundingQuote {
  venue: FundingVenue;
  /** The venue's own market name. */
  market: string;
  /** What it tracks ("BTC", "AMD"). */
  base: string;
  /** Funding a year, in %; positive = longs pay shorts. */
  annualPct: number;
  /** 24h volume in USD when the venue's feed gives it, else null. */
  dayVolumeUsd: number | null;
  /** Taker fee as a fraction, only for the venues Meridian trades (the others are references). */
  takerFee: number | null;
}

export interface FundingPair {
  base: string;
  long: FundingQuote;
  short: FundingQuote;
  /** What the pair earns a year at today's rates: short's funding − long's, in % of one leg's notional. */
  spreadAprPct: number;
  /** Both legs on venues Meridian trades: it can be opened from the terminal. */
  executable: boolean;
  /** Taker fees to open and close both legs, in % of one leg; null when a leg's fee isn't known. */
  roundTripFeePct: number | null;
  /** Days of the spread that pay the round trip back; null when unknown or the spread earns nothing. */
  breakEvenDays: number | null;
}

const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN);

/** Price-scaled tickers name the same asset: 1000PEPE, kPEPE → PEPE. */
export function normalizeBase(raw: string): string {
  // Lowercase k only (Hyperliquid's kPEPE): an uppercase K starts real tickers (KAITO, KAVA).
  const b = marketBase(raw.trim().replace(/^k(?=[A-Z])/, "")).replace(/^(1000000|1000)(?=[A-Z])/, "");
  return b === "XBT" ? "BTC" : b;
}

/** Meridian's own venues, from the perp snapshot (lib/perpFeed.ts). */
export function quotesFromSnapshot(quotes: MarketQuote[]): FundingQuote[] {
  return quotes
    .filter((q) => q.kind === "perp" && Number.isFinite(q.fundingHourly))
    .map((q) => ({
      venue: q.venue,
      market: q.market,
      base: normalizeBase(q.base),
      annualPct: q.fundingHourly * HOURS_PER_YEAR * 100,
      dayVolumeUsd: Number.isFinite(q.dayVolumeUsd) ? q.dayVolumeUsd : null,
      takerFee: q.takerFee,
    }));
}

const LIGHTER_FEED_VENUES: Record<string, FundingVenue> = { lighter: "Lighter", binance: "Binance", bybit: "Bybit" };

/** Lighter's /api/v1/funding-rates: Lighter, Binance and Bybit (its Hyperliquid rows are skipped: Meridian reads Hyperliquid itself). */
export function parseLighterFeed(json: unknown): FundingQuote[] {
  const rows = (json as { funding_rates?: unknown })?.funding_rates;
  if (!Array.isArray(rows)) return [];
  const out: FundingQuote[] = [];
  for (const r of rows as { exchange?: unknown; symbol?: unknown; rate?: unknown }[]) {
    const venue = LIGHTER_FEED_VENUES[String(r?.exchange ?? "").toLowerCase()];
    const rate = num(r?.rate);
    if (!venue || typeof r.symbol !== "string" || !Number.isFinite(rate)) continue;
    out.push({ venue, market: r.symbol, base: normalizeBase(r.symbol), annualPct: rate * (HOURS_PER_YEAR / 8) * 100, dayVolumeUsd: null, takerFee: null });
  }
  return out;
}

/** Paradex /v1/markets/summary?market=ALL: perps only, rate per its own interval. */
export function parseParadex(json: unknown): FundingQuote[] {
  const rows = (json as { results?: unknown })?.results;
  if (!Array.isArray(rows)) return [];
  const out: FundingQuote[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const symbol = r?.symbol;
    if (typeof symbol !== "string" || !/-PERP$/.test(symbol)) continue;
    const rate = num(r.funding_rate);
    const minutes = num(r.funding_interval_minutes) || 480;
    if (!Number.isFinite(rate)) continue;
    const vol = num(r.volume_24h);
    out.push({
      venue: "Paradex",
      market: symbol,
      base: normalizeBase(symbol.replace(/-USD-PERP$/, "")),
      annualPct: rate * ((HOURS_PER_YEAR * 60) / minutes) * 100,
      dayVolumeUsd: Number.isFinite(vol) ? vol : null,
      takerFee: null,
    });
  }
  return out;
}

/** dYdX indexer /v4/perpetualMarkets: active markets, `nextFundingRate` per hour, `volume24H` in USD. */
export function parseDydx(json: unknown): FundingQuote[] {
  const markets = (json as { markets?: unknown })?.markets;
  if (!markets || typeof markets !== "object") return [];
  const out: FundingQuote[] = [];
  for (const m of Object.values(markets as Record<string, Record<string, unknown>>)) {
    if (m?.status !== "ACTIVE" || typeof m.ticker !== "string") continue;
    const rate = num(m.nextFundingRate);
    if (!Number.isFinite(rate)) continue;
    const vol = num(m.volume24H);
    out.push({ venue: "dYdX", market: m.ticker, base: normalizeBase(m.ticker.replace(/-USD$/, "")), annualPct: rate * HOURS_PER_YEAR * 100, dayVolumeUsd: Number.isFinite(vol) ? vol : null, takerFee: null });
  }
  return out;
}

/** Aster /fapi/v1/premiumIndex (all symbols) + /fapi/v1/fundingInfo (intervals) + /fapi/v1/ticker/24hr (quote volume). USDT-margined only. */
export function parseAster(premium: unknown, fundingInfo: unknown, tickers: unknown): FundingQuote[] {
  if (!Array.isArray(premium)) return [];
  const hours = new Map<string, number>();
  if (Array.isArray(fundingInfo)) for (const f of fundingInfo as { symbol?: unknown; fundingIntervalHours?: unknown }[]) if (typeof f?.symbol === "string" && num(f.fundingIntervalHours) > 0) hours.set(f.symbol, num(f.fundingIntervalHours));
  const volume = new Map<string, number>();
  if (Array.isArray(tickers)) for (const t of tickers as { symbol?: unknown; quoteVolume?: unknown }[]) if (typeof t?.symbol === "string" && Number.isFinite(num(t.quoteVolume))) volume.set(t.symbol, num(t.quoteVolume));
  const out: FundingQuote[] = [];
  for (const p of premium as { symbol?: unknown; lastFundingRate?: unknown }[]) {
    const symbol = p?.symbol;
    if (typeof symbol !== "string" || !/USDT$/.test(symbol)) continue;
    const rate = num(p.lastFundingRate);
    if (!Number.isFinite(rate)) continue;
    out.push({
      venue: "Aster",
      market: symbol,
      base: normalizeBase(symbol.replace(/USDT$/, "")),
      annualPct: rate * (HOURS_PER_YEAR / (hours.get(symbol) ?? 8)) * 100,
      dayVolumeUsd: volume.get(symbol) ?? null,
      takerFee: null,
    });
  }
  return out;
}

/** Below this 24h volume (when a feed gives it) a leg can't open and close at size without paying the book. */
export const MIN_LEG_DAY_VOLUME_USD = 1_000_000;
/** A funding rate beyond ±1,000%/yr is a broken or about-to-delist market, not an opportunity. */
const MAX_SANE_ANNUAL_PCT = 1000;

/**
 * For every asset on two venues or more, the best pair: long where funding
 * costs a long the least, short where it pays a short the most. One market
 * per venue and asset (the most traded). Legs whose feed reports a volume
 * under MIN_LEG_DAY_VOLUME_USD are left out; a feed with no volume is kept
 * and the leg shows "n/a", as long as the other leg reports real volume.
 * Sorted by spread, widest first.
 */
export function buildFundingPairs(quotes: FundingQuote[], opts: { executableOnly?: boolean } = {}): FundingPair[] {
  const best = new Map<string, FundingQuote>();
  for (const q of quotes) {
    if (!q.base || !Number.isFinite(q.annualPct) || Math.abs(q.annualPct) > MAX_SANE_ANNUAL_PCT) continue;
    if (q.dayVolumeUsd !== null && q.dayVolumeUsd < MIN_LEG_DAY_VOLUME_USD) continue;
    if (opts.executableOnly && !EXECUTABLE_VENUES.includes(q.venue)) continue;
    const key = `${q.base}|${q.venue}`;
    const prev = best.get(key);
    if (!prev || (q.dayVolumeUsd ?? 0) > (prev.dayVolumeUsd ?? 0)) best.set(key, q);
  }
  const byBase = new Map<string, FundingQuote[]>();
  for (const q of best.values()) byBase.set(q.base, [...(byBase.get(q.base) ?? []), q]);

  const pairs: FundingPair[] = [];
  for (const [base, qs] of byBase) {
    if (qs.length < 2) continue;
    const long = qs.reduce((a, b) => (b.annualPct < a.annualPct ? b : a));
    const short = qs.filter((q) => q !== long).reduce((a, b) => (b.annualPct > a.annualPct ? b : a));
    const spreadAprPct = short.annualPct - long.annualPct;
    if (!(spreadAprPct > 0)) continue;
    // Two legs whose feeds report no volume could be two empty books: one leg at least must show real volume.
    if (long.dayVolumeUsd === null && short.dayVolumeUsd === null) continue;
    const executable = EXECUTABLE_VENUES.includes(long.venue) && EXECUTABLE_VENUES.includes(short.venue);
    const roundTripFeePct = long.takerFee !== null && short.takerFee !== null ? 2 * (long.takerFee + short.takerFee) * 100 : null;
    const breakEvenDays = roundTripFeePct !== null ? (roundTripFeePct / spreadAprPct) * 365 : null;
    pairs.push({ base, long, short, spreadAprPct, executable, roundTripFeePct, breakEvenDays });
  }
  return pairs.sort((a, b) => b.spreadAprPct - a.spreadAprPct);
}

/** The terminal prompt that opens a pair (handed to the planner through askBus). */
export function pairPrompt(p: FundingPair): string {
  return `Open a beta-neutral pair on ${p.base}: long on ${p.long.venue}, short on ${p.short.venue}, to earn the funding spread.`;
}
