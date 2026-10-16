/**
 * perpVenues.ts — what the planner needs to compare perp venues: Extended's
 * markets (crypto and RWA: stocks, indices, commodities) and the funding of
 * the same market on Hyperliquid and Extended, side by side.
 *
 * Funding convention everywhere: a POSITIVE rate means longs pay shorts, so
 * a short EARNS it and a long PAYS it. Both venues settle funding hourly.
 */

/** Taker fee per side (Hyperliquid base tier; Extended `DEFAULT_TAKER_FEE`), as a fraction of notional. */
export const TAKER_FEE = { Hyperliquid: 0.00045, Extended: 0.0005 } as const;

const HOURS_PER_YEAR = 24 * 365;

export interface ExtendedMarketRow {
  /** Exact market name to trade ("ETH-USD", "AMD_24_5-USD"). */
  name: string;
  /** What it tracks ("ETH", "AMD"). */
  base: string;
  category: "Crypto" | "RWA" | string;
  mark: number;
  fundingHourly: number;
  maxLeverage: number;
  dayVolumeUsd: number;
}

/**
 * The asset a market name tracks, the same on both venues: "AMD_24_5-USD" →
 * "AMD", "SPX500m-USD" → "SPX500", "xyz:TSLA" → "TSLA", "ETH PERP" → "ETH".
 */
export function marketBase(name: string): string {
  const base = name
    .trim()
    .toUpperCase()
    .replace(/\s*-?PERP(ETUAL)?$/, "")
    .replace(/^[A-Z0-9]+:/, "")
    .replace(/-USD$/, "")
    .replace(/_\d+_\d+$/, "")
    .replace(/(?<=\d)M$/, "");
  return BASE_ALIASES[base] ?? base;
}

/** Extended's commodity / index tickers → the names Hyperliquid's HIP-3 markets use. */
const BASE_ALIASES: Record<string, string> = { XAU: "GOLD", XAG: "SILVER", WTI: "CL", XBR: "BRENTOIL", SPX500: "SP500" };

interface RawExtendedMarket {
  name?: string;
  category?: string;
  active?: boolean;
  status?: string;
  marketStats?: { markPrice?: string; fundingRate?: string; dailyVolume?: string };
  tradingConfig?: { maxLeverage?: string };
}

export function parseExtendedMarketRows(raw: RawExtendedMarket[] | undefined): ExtendedMarketRow[] {
  const n = (v: unknown) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  return (raw ?? [])
    .filter((m) => m.name && m.active !== false && (m.status ?? "ACTIVE") === "ACTIVE" && n(m.marketStats?.markPrice) > 0)
    .map((m) => ({
      name: m.name!,
      base: marketBase(m.name!),
      category: m.category ?? "Crypto",
      mark: n(m.marketStats?.markPrice),
      fundingHourly: n(m.marketStats?.fundingRate),
      maxLeverage: n(m.tradingConfig?.maxLeverage) || 1,
      dayVolumeUsd: n(m.marketStats?.dailyVolume),
    }))
    .sort((a, b) => b.dayVolumeUsd - a.dayVolumeUsd);
}

const apr = (hourly: number) => hourly * HOURS_PER_YEAR * 100;
const signed = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`;
const fmtVol = (v: number) => (v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}k`);

/** Extended's markets for the planner: the most traded crypto and RWA ones, exact names. */
export function extendedSummary(rows: ExtendedMarketRow[], limits = { crypto: 25, rwa: 40 }): string {
  if (rows.length === 0) return "";
  const line = (m: ExtendedMarketRow) =>
    `- ${m.name} (${m.base}) | $${m.mark.toLocaleString("en-US", { maximumFractionDigits: 4 })} | funding ${signed(apr(m.fundingHourly))}/yr | ${m.maxLeverage}x | ${fmtVol(m.dayVolumeUsd)} 24h`;
  const crypto = rows.filter((m) => m.category === "Crypto").slice(0, limits.crypto);
  const rwa = rows.filter((m) => m.category !== "Crypto").slice(0, limits.rwa);
  return [
    "\n\n### Extended perps (StarkEx, USDC margin) — exact market name (tracks) | price | funding | max leverage | 24h volume",
    `Funding: positive = longs pay shorts (a short earns it). Taker fee ${(TAKER_FEE.Extended * 100).toFixed(3)}% per side. Executable only from a funded Extended account (see EXTENDED ACCOUNT in the portfolio).`,
    "Crypto:",
    ...crypto.map(line),
    "Stocks, indices, commodities (RWA):",
    ...rwa.map(line),
  ].join("\n");
}

export interface VenueFunding {
  base: string;
  /** Hyperliquid market name ("ETH", "xyz:TSLA"). */
  hl: string;
  hlAprPct: number;
  /** Extended market name ("ETH-USD"). */
  extended: string;
  extendedAprPct: number;
}

/**
 * The same asset on both venues, with each funding annualized and the pair a
 * delta-neutral cross-venue position would take: long where funding is
 * lower, short where it is higher, earning the difference on the notional.
 */
export function crossVenueFunding(
  hl: { coin: string; hourlyRate: number }[],
  extended: ExtendedMarketRow[],
): (VenueFunding & { spreadPct: number; longOn: "Hyperliquid" | "Extended"; shortOn: "Hyperliquid" | "Extended" })[] {
  const ext = new Map<string, ExtendedMarketRow>();
  for (const m of extended) if (!ext.has(m.base)) ext.set(m.base, m);
  const out = [];
  for (const h of hl) {
    const base = marketBase(h.coin);
    const e = ext.get(base);
    if (!e) continue;
    const hlAprPct = apr(h.hourlyRate);
    const extendedAprPct = apr(e.fundingHourly);
    const shortOnHl = hlAprPct >= extendedAprPct;
    out.push({
      base,
      hl: h.coin,
      hlAprPct,
      extended: e.name,
      extendedAprPct,
      spreadPct: Math.abs(hlAprPct - extendedAprPct),
      longOn: shortOnHl ? ("Extended" as const) : ("Hyperliquid" as const),
      shortOn: shortOnHl ? ("Hyperliquid" as const) : ("Extended" as const),
    });
  }
  return out;
}

/** The cross-venue table for the planner, the markets both venues trade most first. */
export function crossVenueSummary(rows: ReturnType<typeof crossVenueFunding>, limit = 20): string {
  if (rows.length === 0) return "";
  const roundTripFeesPct = 2 * (TAKER_FEE.Hyperliquid + TAKER_FEE.Extended) * 100;
  return [
    "\n\n### Same market on Hyperliquid and Extended — funding per venue (annualized) and the delta-neutral pair",
    `A cross-venue pair is long on one venue and short the same base quantity on the other: it targets no price exposure once both legs fill (basis between the two markets remains), earns (or pays, if negative) the funding difference, and trades on BOTH venues: one open + close of notional N per leg is 4N of volume in total, 2N on each venue. Opening and closing both legs costs ${roundTripFeesPct.toFixed(2)}% of N in taker fees (observed fee rates).`,
    "base | Hyperliquid market: funding | Extended market: funding | pair: long on → short on | funding difference earned by the pair (annualized, on N)",
    ...rows.slice(0, limit).map(
      (r) => `- ${r.base} | ${r.hl}: ${signed(r.hlAprPct)} | ${r.extended}: ${signed(r.extendedAprPct)} | long ${r.longOn} → short ${r.shortOn} | ${signed(r.spreadPct, 2)}/yr`,
    ),
  ].join("\n");
}
