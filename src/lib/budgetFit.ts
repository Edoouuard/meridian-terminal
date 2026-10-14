/**
 * budgetFit.ts — keep every strategy inside what the user can actually deploy.
 *
 * The planner is told the free balance, but an LLM doesn't add up its own
 * legs. This walks a strategy's legs in order, the way funds flow through
 * them, and counts the FRESH capital it needs from the wallet:
 *   - a spending leg (supply, swap, stake, bridge, deposit…) first uses what
 *     earlier legs produced (a swap's output, a borrow, a bridge's delivery),
 *     and only the rest is fresh wallet money;
 *   - a perp needs margin (size / leverage): from the Hyperliquid account,
 *     then from Deposit legs, the rest is fresh too.
 * When the fresh total exceeds the deployable balance, every leg is scaled by
 * the same factor, so the strategy keeps its shape (a hedge stays hedged).
 *
 * Deployable = tokens in the wallet plus free Hyperliquid spot balances.
 * Staked HYPE, HLP and vault equity are locked; the Hyperliquid perps
 * account only backs perps.
 */

import { chainIdFromName } from "@/lib/chains";
import { findToken } from "@/lib/assetMap";
import { producedToken, spentSymbol } from "@/lib/fundingPlanner";
import type { TradeLeg } from "@/lib/tradePlan";

export interface BudgetAsset {
  symbol: string;
  venue: string;
  chain: string;
  usd: number;
}

const DEPLOYABLE_VENUE = /^(wallet|hyperliquid spot)$/i;
const HL_PERPS_VENUE = /^hyperliquid perps$/i;

/** USD the user can put into a new strategy right now. */
export function deployableUsd(assets: BudgetAsset[] | undefined): number {
  return (assets ?? []).filter((a) => DEPLOYABLE_VENUE.test(a.venue.trim()) && a.usd > 0).reduce((s, a) => s + a.usd, 0);
}

/** Holdings that count in net worth but can't fund a strategy (staking, HLP, vaults). */
export function isLockedVenue(venue: string): boolean {
  return !DEPLOYABLE_VENUE.test(venue.trim()) && !HL_PERPS_VENUE.test(venue.trim());
}

const HL_MARGIN = "HL:MARGIN";

/** Fresh wallet capital a strategy needs, in USD, given the margin already on Hyperliquid. */
export function freshCapitalUsd(legs: TradeLeg[], hlMarginUsd = 0): number {
  const pool = new Map<string, number>([[HL_MARGIN, hlMarginUsd]]);
  const take = (sym: string, usd: number) => {
    const have = pool.get(sym) ?? 0;
    const used = Math.min(have, usd);
    pool.set(sym, have - used);
    return usd - used;
  };
  const put = (sym: string, usd: number) => pool.set(sym, (pool.get(sym) ?? 0) + usd);

  let fresh = 0;
  for (const leg of legs) {
    const size = leg.sizeUsd ?? 0;
    if (!(size > 0)) continue;
    const side = leg.side.trim().toLowerCase();
    const chainId = chainIdFromName(leg.chain) ?? 0;
    if (side === "long" || side === "short") {
      fresh += take(HL_MARGIN, size / Math.max(1, leg.leverage ?? 1));
      continue;
    }
    const spent = spentSymbol(leg, chainId);
    if (spent) fresh += take(spent, size);
    if (side === "deposit" && /hyperliquid/i.test(leg.protocol)) {
      put(HL_MARGIN, size);
    } else if (side === "bridge") {
      const to = chainIdFromName(leg.toChain) ?? 0;
      put((findToken(leg.asset.trim(), to)?.symbol ?? leg.asset.trim()).toUpperCase(), size);
    } else {
      const out = producedToken(leg, chainId);
      if (out) put(out.symbol, size * out.keep);
    }
  }
  return fresh;
}

/**
 * Scale a strategy's legs so its fresh capital fits `budgetUsd`. Returns the
 * legs unchanged when it already fits, with the factor applied otherwise.
 */
export function fitLegsToBudget<L extends TradeLeg>(legs: L[], budgetUsd: number, hlMarginUsd = 0): { legs: L[]; scaled: number } {
  const fresh = freshCapitalUsd(legs, hlMarginUsd);
  if (!(fresh > 0) || fresh <= budgetUsd * 1.0001) return { legs, scaled: 1 };
  const k = Math.max(0, budgetUsd) / fresh;
  return {
    legs: legs.map((l) => (l.sizeUsd && l.sizeUsd > 0 ? { ...l, sizeUsd: Math.floor(l.sizeUsd * k * 100) / 100 } : l)),
    scaled: k,
  };
}
