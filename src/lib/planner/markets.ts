/**
 * markets.ts — the market facts the server needs to validate a plan's legs
 * (price, funding, size step, minimums, fees), in one shape for every venue.
 * Built by /api/yield-context from the venues' own APIs; the planner route
 * uses it to size pairs and compute economics itself.
 */

import { HL_SPOT_TAKER_FEE, TAKER_FEE } from "@/lib/perpVenues";

/** The perp venues the server can price and size. */
export type PerpVenueName = "Hyperliquid" | "Extended" | "TxFlow";

export interface MarketQuote {
  venue: PerpVenueName;
  kind: "perp" | "spot";
  /** Exact market name ("ETH", "xyz:AMD", "AMD_24_5-USD", "UETH"). */
  market: string;
  /** What it tracks ("ETH", "AMD"). */
  base: string;
  markUsd: number;
  /** Funding per hour, positive = longs pay shorts. 0 for spot. */
  fundingHourly: number;
  /** Quantity step of the market, in the base asset. */
  sizeStep: number;
  /** Minimum quantity, in the base asset (0 when the venue sets a USD minimum instead). */
  minQty: number;
  /** Minimum notional in USD (0 when the venue sets a quantity minimum instead). */
  minNotionalUsd: number;
  takerFee: number;
  maxLeverage: number;
  dayVolumeUsd: number;
}

export interface MarketSnapshot {
  quotes: MarketQuote[];
  /** ISO time the quotes were read. */
  fetchedAt: string;
}

export const HL_MIN_NOTIONAL_USD = 10;

export function hlQuote(p: { market: string; base: string; markUsd: number; fundingHourly: number; szDecimals: number; maxLeverage: number; dayVolumeUsd: number; kind?: "perp" | "spot" }): MarketQuote {
  return {
    venue: "Hyperliquid",
    kind: p.kind ?? "perp",
    market: p.market,
    base: p.base,
    markUsd: p.markUsd,
    fundingHourly: p.kind === "spot" ? 0 : p.fundingHourly,
    sizeStep: 10 ** -p.szDecimals,
    minQty: 0,
    minNotionalUsd: HL_MIN_NOTIONAL_USD,
    takerFee: p.kind === "spot" ? HL_SPOT_TAKER_FEE : TAKER_FEE.Hyperliquid,
    maxLeverage: p.maxLeverage,
    dayVolumeUsd: p.dayVolumeUsd,
  };
}

/** TxFlow: quantity on szDecimals, no published minimum beyond the size step. */
export function txflowQuote(p: { market: string; base: string; markUsd: number; fundingHourly: number; szDecimals: number; maxLeverage: number; dayVolumeUsd: number }): MarketQuote {
  return {
    venue: "TxFlow",
    kind: "perp",
    market: p.market,
    base: p.base,
    markUsd: p.markUsd,
    fundingHourly: p.fundingHourly,
    sizeStep: 10 ** -p.szDecimals,
    minQty: 0,
    minNotionalUsd: 0,
    takerFee: TAKER_FEE.TxFlow,
    maxLeverage: p.maxLeverage,
    dayVolumeUsd: p.dayVolumeUsd,
  };
}

export function extendedQuote(p: { market: string; base: string; markUsd: number; fundingHourly: number; sizeStep: number; minQty: number; maxLeverage: number; dayVolumeUsd: number }): MarketQuote {
  return { venue: "Extended", kind: "perp", minNotionalUsd: 0, takerFee: TAKER_FEE.Extended, ...p };
}
