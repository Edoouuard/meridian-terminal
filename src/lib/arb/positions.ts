/**
 * positions.ts — the hedged arbitrage trades the user opened from the
 * scanner (components/ArbView), kept per wallet in this browser: what was
 * bought or sold on-chain, the perp leg against it, and the gap at entry, so
 * the view can follow the gap and close both legs when it has converged.
 */

import type { PerpVenueName } from "@/lib/planner/markets";
import type { ArbDirection } from "@/lib/arb/scan";

export interface ArbPosition {
  id: string;
  base: string;
  chainId: number;
  /** The on-chain token (WETH, ARB…). */
  symbol: string;
  address: string;
  decimals: number;
  direction: ArbDirection;
  /** Tokens bought (or sold) on-chain, and the perp quantity against them. */
  qty: number;
  venue: PerpVenueName;
  market: string;
  entryDexPx: number;
  entryPerpPx: number;
  openedAt: number;
  swapTx?: string;
}

const key = (address: string) => `meridian:arb:${address.toLowerCase()}`;

export function loadArbPositions(address: string | undefined): ArbPosition[] {
  if (!address) return [];
  try {
    const raw = JSON.parse(localStorage.getItem(key(address)) ?? "[]") as unknown;
    return Array.isArray(raw) ? (raw as ArbPosition[]) : [];
  } catch {
    return [];
  }
}

export function saveArbPositions(address: string, positions: ArbPosition[]) {
  try {
    localStorage.setItem(key(address), JSON.stringify(positions));
  } catch {
    /* storage blocked: positions stay on the venues, only this list is lost */
  }
}

/** The gap at entry, % ((perp − DEX) / DEX). */
export const entryGapPct = (p: Pick<ArbPosition, "entryDexPx" | "entryPerpPx">) => (p.entryPerpPx / p.entryDexPx - 1) * 100;

/**
 * What the two legs have made so far at these prices, USD (fees aside): the
 * on-chain leg's move plus the perp leg's, which is the gap's change times
 * the quantity.
 */
export function arbPnlUsd(p: ArbPosition, dexPx: number, perpPx: number): number {
  const long = p.direction === "buy-onchain-short-perp";
  const chain = (dexPx - p.entryDexPx) * p.qty * (long ? 1 : -1);
  const perp = (perpPx - p.entryPerpPx) * p.qty * (long ? -1 : 1);
  return chain + perp;
}
