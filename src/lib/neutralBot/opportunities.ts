/**
 * opportunities.ts — which neutral pairs are worth opening now, across the
 * perp venues Meridian trades (Hyperliquid, Extended, TxFlow).
 *
 * For every asset listed on two venues, the pair is oriented the way funding
 * pays it: long where funding costs a long the least, short where it pays a
 * short the most. Each pair then gets the two numbers that decide it:
 *   - carry: the funding spread a year, and how many days of it cover the
 *     taker fees of opening and closing both legs (break-even);
 *   - farming: what a dollar of volume costs (fees, minus the funding the
 *     open position earns while held), for users who trade to earn the
 *     venues' points and airdrops (volume and open interest).
 * A wide spread that pays its fees back within a few days is flagged as a
 * funding arbitrage. Pure and unit-tested; the data comes from
 * /api/perp-markets (lib/perpFeed.ts).
 */

import type { MarketQuote, MarketSnapshot, PerpVenueName } from "@/lib/planner/markets";

const HOURS_PER_YEAR = 8760;

export interface PairLegQuote {
  venue: PerpVenueName;
  market: string;
  fundingHourly: number;
  markUsd: number;
  maxLeverage: number;
  dayVolumeUsd: number;
  takerFee: number;
  /** Smallest order in USD at today's mark (the venue's quantity or notional minimum). */
  minNotionalUsd: number;
}

export interface PairOpportunity {
  base: string;
  long: PairLegQuote;
  short: PairLegQuote;
  /** Funding a year the pair earns (short leg's funding − long leg's), in % of one leg's notional. */
  spreadAprPct: number;
  /** Taker fees to open and close both legs, in % of one leg's notional. */
  roundTripFeePct: number;
  /** Days of the spread that pay the round trip back; null when the spread earns nothing. */
  breakEvenDays: number | null;
  /** The thinner book's 24h volume, USD. */
  minDayVolumeUsd: number;
  /** Highest leverage both markets allow. */
  maxLeverage: number;
  /** The larger of the two legs' minimum order, USD. */
  minNotionalUsd: number;
  /** A funding arbitrage: spread ≥ ARB_MIN_SPREAD_APR_PCT and fees paid back within ARB_MAX_BREAK_EVEN_DAYS. */
  arbitrage: boolean;
}

/** Below this 24h volume on either side, a pair can't open and close at size without paying the book. */
export const MIN_PAIR_DAY_VOLUME_USD = 1_000_000;
export const ARB_MIN_SPREAD_APR_PCT = 15;
export const ARB_MAX_BREAK_EVEN_DAYS = 3;

const legQuote = (q: MarketQuote): PairLegQuote => ({
  venue: q.venue,
  market: q.market,
  fundingHourly: q.fundingHourly,
  markUsd: q.markUsd,
  maxLeverage: q.maxLeverage || 1,
  dayVolumeUsd: q.dayVolumeUsd,
  takerFee: q.takerFee,
  minNotionalUsd: Math.max(q.minQty * q.markUsd, q.minNotionalUsd),
});

/** The pair on `base` between two venues' quotes, oriented by funding. */
export function orientPair(base: string, a: MarketQuote, b: MarketQuote): PairOpportunity {
  const [long, short] = a.fundingHourly <= b.fundingHourly ? [legQuote(a), legQuote(b)] : [legQuote(b), legQuote(a)];
  const spreadAprPct = (short.fundingHourly - long.fundingHourly) * HOURS_PER_YEAR * 100;
  const roundTripFeePct = 2 * (long.takerFee + short.takerFee) * 100;
  const dailySpread = spreadAprPct / 365;
  const breakEvenDays = dailySpread > 0 ? roundTripFeePct / dailySpread : null;
  return {
    base,
    long,
    short,
    spreadAprPct,
    roundTripFeePct,
    breakEvenDays,
    minDayVolumeUsd: Math.min(long.dayVolumeUsd, short.dayVolumeUsd),
    maxLeverage: Math.min(long.maxLeverage, short.maxLeverage),
    minNotionalUsd: Math.max(long.minNotionalUsd, short.minNotionalUsd),
    arbitrage: spreadAprPct >= ARB_MIN_SPREAD_APR_PCT && breakEvenDays !== null && breakEvenDays <= ARB_MAX_BREAK_EVEN_DAYS,
  };
}

/** The deepest perp market per venue and asset. */
function bookByVenue(quotes: MarketQuote[], venues: PerpVenueName[]): Map<string, Map<PerpVenueName, MarketQuote>> {
  const out = new Map<string, Map<PerpVenueName, MarketQuote>>();
  for (const q of quotes) {
    if (q.kind !== "perp" || !venues.includes(q.venue) || !(q.markUsd > 0)) continue;
    const base = q.base.toUpperCase();
    const row = out.get(base) ?? new Map<PerpVenueName, MarketQuote>();
    const held = row.get(q.venue);
    if (!held || q.dayVolumeUsd > held.dayVolumeUsd) row.set(q.venue, q);
    out.set(base, row);
  }
  return out;
}

export interface ScanOptions {
  /** Venues the user can trade on (default: all three). */
  venues?: PerpVenueName[];
  minDayVolumeUsd?: number;
}

/** Every liquid two-venue pair, one per asset and venue couple. */
export function scanPairs(snapshot: Pick<MarketSnapshot, "quotes"> | undefined, opts: ScanOptions = {}): PairOpportunity[] {
  if (!snapshot) return [];
  const venues = opts.venues ?? ["Hyperliquid", "Extended", "TxFlow"];
  const minVol = opts.minDayVolumeUsd ?? MIN_PAIR_DAY_VOLUME_USD;
  const out: PairOpportunity[] = [];
  for (const [base, row] of bookByVenue(snapshot.quotes, venues)) {
    const listed = [...row.values()];
    for (let i = 0; i < listed.length; i++) {
      for (let j = i + 1; j < listed.length; j++) {
        const p = orientPair(base, listed[i], listed[j]);
        if (p.minDayVolumeUsd >= minVol) out.push(p);
      }
    }
  }
  return out;
}

/**
 * What a dollar of volume costs a farmer, in basis points: the round trip's
 * fees spread over the volume it makes (four fills of one leg's notional),
 * minus the funding the open pair earns while held between two rotations.
 */
export function farmCostBpsPerVolume(p: PairOpportunity, holdHours: number): number {
  const volumePct = 4 * 100; // open + close of both legs, in % of one leg's notional
  const carryPct = (p.spreadAprPct / HOURS_PER_YEAR) * holdHours;
  return ((p.roundTripFeePct - carryPct) / volumePct) * 10_000;
}

/** Best for carry first: widest spread among those that pay their fees back within a week. */
export function rankForCarry(pairs: PairOpportunity[]): PairOpportunity[] {
  return pairs.filter((p) => p.breakEvenDays !== null && p.breakEvenDays <= 7).sort((a, b) => b.spreadAprPct - a.spreadAprPct);
}

/**
 * Best for farming volume and open interest first: cheapest volume (cheaper
 * venues, funding that pays while held), then the deeper book.
 */
export function rankForFarming(pairs: PairOpportunity[], holdHours = 24): PairOpportunity[] {
  return [...pairs].sort((a, b) => farmCostBpsPerVolume(a, holdHours) - farmCostBpsPerVolume(b, holdHours) || b.minDayVolumeUsd - a.minDayVolumeUsd);
}

/** One line for the planner's data: the pair, its spread, fees and break-even. */
export function describePair(p: PairOpportunity): string {
  const be = p.breakEvenDays === null ? "never pays back" : `fees back in ${p.breakEvenDays < 1 ? "<1" : p.breakEvenDays.toFixed(1)} days`;
  return `${p.base}: long ${p.long.venue} (${p.long.market}), short ${p.short.venue} (${p.short.market}) · spread ${p.spreadAprPct >= 0 ? "+" : ""}${p.spreadAprPct.toFixed(1)}%/yr · round trip ${p.roundTripFeePct.toFixed(3)}% · ${be}${p.arbitrage ? " · funding arbitrage" : ""}`;
}
