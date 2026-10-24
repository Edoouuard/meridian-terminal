/**
 * fundingArb.ts — funding-rate arbitrage across the perp venues Meridian
 * trades (Hyperliquid, Extended, TxFlow).
 *
 * The trade: the same quantity long on one venue and short on another.
 * Price moves cancel between the legs; what is left is
 *   funding received on the short − funding paid on the long
 *   ± the change in the price gap between the two venues
 *   − taker fees on four fills (open and close both legs).
 * A long receives funding when the rate is negative, a short when it is
 * positive (rates here: positive = longs pay shorts).
 *
 * The rate a venue shows right now is one hour's figure: it mean-reverts,
 * and some venues sit on a floor or cap (Hyperliquid's 0.00125%/h base
 * rate = 10.95%/yr, Extended's 0.0013%/h cap = 11.39%/yr). So a pair is
 * judged on the realised average of the last 7 days, read from each
 * venue's funding history, and the projection says which rate it used.
 * Pure functions, unit-tested; the fetches live in /api/funding-arb.
 */

import type { MarketQuote, PerpVenueName } from "@/lib/planner/markets";

const HOURS_PER_YEAR = 8760;
const DAY_MS = 86_400_000;

/** A leg must trade at least this much a day to open and close at size without paying the book. */
export const MIN_LEG_DAY_VOLUME_USD = 1_000_000;
/** Beyond ±1,000%/yr a rate is a broken or delisting market, not an opportunity. */
const MAX_SANE_ANNUAL_PCT = 1000;
/** Days of history the 7-day average needs to count (a younger market has no track record). */
export const MIN_HISTORY_DAYS = 5;
/** Days the projection holds the pair. */
export const HOLD_DAYS = 30;
/** USD per leg the projection is shown for. */
export const PER_LEG_USD = 10_000;

export interface FundingLeg {
  venue: PerpVenueName;
  market: string;
  base: string;
  markUsd: number;
  /** Funding now, % a year; positive = longs pay shorts. */
  ratePct: number;
  /** Average funding over the last 7 days, % a year; null when the venue gives no history. */
  rate7dPct: number | null;
  takerFee: number;
  dayVolumeUsd: number;
}

export interface FundingArb {
  base: string;
  long: FundingLeg;
  short: FundingLeg;
  /** What the long leg earns a year at today's rate (negative = it pays). */
  longEarnsPct: number;
  /** What the short leg earns a year at today's rate (negative = it pays). */
  shortEarnsPct: number;
  /** Short's funding − long's, now, % a year of one leg's notional. */
  spreadNowPct: number;
  /** The same over the last 7 days; null when a leg has no history. */
  spread7dPct: number | null;
  /** Which spread the projection uses. */
  basis: "7d" | "now";
  /** Taker fees on four fills, % of one leg's notional. */
  roundTripFeePct: number;
  /** (short mark − long mark) / long mark, %: positive means you gain it if the venues' prices converge. */
  priceGapPct: number;
  /** Net after HOLD_DAYS at the basis spread, % of one leg's notional. */
  netHoldPct: number;
  /** Days of the basis spread that pay back the fees; null when it earns nothing. */
  breakEvenDays: number | null;
}

/** One leg per venue and base (the most traded market), perps with real volume and a sane rate. */
export function legsFromSnapshot(quotes: MarketQuote[]): FundingLeg[] {
  const best = new Map<string, FundingLeg>();
  for (const q of quotes) {
    if (q.kind !== "perp" || !Number.isFinite(q.fundingHourly) || !(q.markUsd > 0)) continue;
    if (!(q.dayVolumeUsd >= MIN_LEG_DAY_VOLUME_USD)) continue;
    const ratePct = q.fundingHourly * HOURS_PER_YEAR * 100;
    if (Math.abs(ratePct) > MAX_SANE_ANNUAL_PCT) continue;
    const base = q.base.toUpperCase();
    const key = `${base}|${q.venue}`;
    const prev = best.get(key);
    if (prev && prev.dayVolumeUsd >= q.dayVolumeUsd) continue;
    best.set(key, { venue: q.venue, market: q.market, base, markUsd: q.markUsd, ratePct, rate7dPct: null, takerFee: q.takerFee, dayVolumeUsd: q.dayVolumeUsd });
  }
  return [...best.values()];
}

/** For each base on two venues or more, every long/short orientation whose spread is positive now. */
export function candidatePairs(legs: FundingLeg[]): { long: FundingLeg; short: FundingLeg }[] {
  const byBase = new Map<string, FundingLeg[]>();
  for (const l of legs) byBase.set(l.base, [...(byBase.get(l.base) ?? []), l]);
  const out: { long: FundingLeg; short: FundingLeg; spread: number }[] = [];
  for (const ls of byBase.values()) {
    for (const long of ls) for (const short of ls) if (long !== short && short.ratePct > long.ratePct) out.push({ long, short, spread: short.ratePct - long.ratePct });
  }
  return out.sort((a, b) => b.spread - a.spread).map(({ long, short }) => ({ long, short }));
}

export interface RatePoint {
  /** ms since epoch. */
  t: number;
  /** Funding per hour (fraction). */
  hourly: number;
}

/** Hyperliquid POST /info {type: "fundingHistory"}: [{coin, fundingRate, premium, time}], hourly. */
export function parseHlFundingHistory(json: unknown): RatePoint[] {
  if (!Array.isArray(json)) return [];
  return (json as { fundingRate?: unknown; time?: unknown }[])
    .map((r) => ({ t: Number(r?.time), hourly: Number(r?.fundingRate) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.hourly));
}

/** Extended GET /api/v1/info/{market}/funding: {data: [{m, f, T}]}, hourly. */
export function parseExtendedFundingHistory(json: unknown): RatePoint[] {
  const rows = (json as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return [];
  return (rows as { f?: unknown; T?: unknown }[])
    .map((r) => ({ t: Number(r?.T), hourly: Number(r?.f) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.hourly));
}

/** Average hourly funding since `fromMs`, as % a year; null when the history covers under MIN_HISTORY_DAYS. */
export function averageAnnualPct(points: RatePoint[], fromMs: number, nowMs: number): number | null {
  const pts = points.filter((p) => p.t >= fromMs && p.t <= nowMs);
  if (pts.length === 0) return null;
  const span = (Math.max(...pts.map((p) => p.t)) - Math.min(...pts.map((p) => p.t))) / DAY_MS;
  if (span < MIN_HISTORY_DAYS) return null;
  const mean = pts.reduce((s, p) => s + p.hourly, 0) / pts.length;
  return mean * HOURS_PER_YEAR * 100;
}

/** The economics of one pair. */
export function evaluatePair(long: FundingLeg, short: FundingLeg): FundingArb {
  const spreadNowPct = short.ratePct - long.ratePct;
  const spread7dPct = long.rate7dPct !== null && short.rate7dPct !== null ? short.rate7dPct - long.rate7dPct : null;
  const basis = spread7dPct !== null ? "7d" : "now";
  const spread = spread7dPct ?? spreadNowPct;
  const roundTripFeePct = 2 * (long.takerFee + short.takerFee) * 100;
  return {
    base: long.base,
    long,
    short,
    longEarnsPct: -long.ratePct,
    shortEarnsPct: short.ratePct,
    spreadNowPct,
    spread7dPct,
    basis,
    roundTripFeePct,
    priceGapPct: ((short.markUsd - long.markUsd) / long.markUsd) * 100,
    netHoldPct: (spread * HOLD_DAYS) / 365 - roundTripFeePct,
    breakEvenDays: spread > 0 ? (roundTripFeePct / spread) * 365 : null,
  };
}

/**
 * The pairs worth showing: positive over the last 7 days as well as now
 * (a spread that only exists this hour is a spike, not a carry), ranked by
 * the net after HOLD_DAYS. Pairs with no history (TxFlow) come after the
 * ones with a track record. One pair per asset: its best orientation.
 */
export function rankFundingArbs(arbs: FundingArb[]): FundingArb[] {
  return arbs
    .filter((a) => a.spreadNowPct > 0 && (a.spread7dPct === null || a.spread7dPct > 0) && a.netHoldPct > 0)
    .sort((a, b) => (a.basis === b.basis ? b.netHoldPct - a.netHoldPct : a.basis === "7d" ? -1 : 1))
    .filter((a, i, all) => all.findIndex((b) => b.base === a.base) === i);
}

/** The terminal prompt that opens a pair. */
export function fundingArbPrompt(a: FundingArb): string {
  return `Open a delta-neutral funding pair on ${a.base}: long ${a.long.market} on ${a.long.venue}, short ${a.short.market} on ${a.short.venue}, same quantity on both legs, to earn the funding spread (${(a.spread7dPct ?? a.spreadNowPct).toFixed(1)}%/yr ${a.basis === "7d" ? "over the last 7 days" : "now"}).`;
}
