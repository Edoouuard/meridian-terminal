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
 * Deployable = tokens in the wallet (stETH/wstETH included). Stablecoins on
 * Hyperliquid (perps account or spot) only back perps: no EVM leg can spend
 * them. Staked HYPE, HLP and vault equity are locked.
 */

import { chainIdFromName } from "@/lib/chains";
import { findToken } from "@/lib/assetMap";
import { producedToken, spentSymbol } from "@/lib/fundingPlanner";
import type { TradeLeg } from "@/lib/tradePlan";
import { HL_WITHDRAW_FEE_USD } from "@/lib/integrations/hyperliquidExchange";

export interface BudgetAsset {
  symbol: string;
  venue: string;
  chain: string;
  usd: number;
}

const DEPLOYABLE_VENUE = /^(wallet|lido)$/i;
const HL_ACCOUNT_VENUE = /^hyperliquid (perps|spot)$/i;
const HL_MARGIN_SYMBOL = /^(USDC|USDT|USDT0|USDH|USDE)$/i;

/** USD the user can put into a new strategy right now. */
export function deployableUsd(assets: BudgetAsset[] | undefined): number {
  return (assets ?? []).filter((a) => DEPLOYABLE_VENUE.test(a.venue.trim()) && a.usd > 0).reduce((s, a) => s + a.usd, 0);
}

/** Stablecoins in the user's Hyperliquid account: margin for perps, nothing else. */
export function hyperliquidMarginOnlyUsd(assets: BudgetAsset[] | undefined): number {
  return (assets ?? []).filter((a) => HL_ACCOUNT_VENUE.test(a.venue.trim()) && HL_MARGIN_SYMBOL.test(a.symbol) && a.usd > 0).reduce((s, a) => s + a.usd, 0);
}

/** Holdings that count in net worth but can't fund a strategy (staking, HLP, vaults). */
export function isLockedVenue(venue: string): boolean {
  return !DEPLOYABLE_VENUE.test(venue.trim()) && !HL_ACCOUNT_VENUE.test(venue.trim());
}

const HL_MARGIN = "HL:MARGIN";

/** Hyperliquid spot tokens a neutral position buys with the account's USDC. */
const HL_SPOT_TOKEN = /\b(UETH|UBTC|USOL)\b/i;

/**
 * Buying UETH / UBTC / USOL on Hyperliquid spot: paid with the USDC already
 * in the Hyperliquid account (the long side of a neutral position there),
 * not with wallet funds and not a perp order.
 */
export function isHlSpotBuyLeg(leg: { side: string; protocol?: string; asset: string }): boolean {
  return /hyperliquid/i.test(leg.protocol ?? "") && /^(buy|swap)$/i.test(leg.side.trim()) && HL_SPOT_TOKEN.test(leg.asset) && !/perp/i.test(leg.asset);
}
const HL_MIN_DEPOSIT_USD = 5;

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
      // Extended / TxFlow margin comes from that venue's account (or a Deposit leg to it, counted as its own spend), never from Hyperliquid or the wallet directly.
      if (/extended|txflow/i.test(leg.protocol)) continue;
      fresh += take(HL_MARGIN, size / Math.max(1, leg.leverage ?? 1));
      continue;
    }
    if (isHlSpotBuyLeg(leg)) {
      fresh += take(HL_MARGIN, size);
      continue;
    }
    const spent = spentSymbol(leg, chainId);
    if (spent) fresh += take(spent, size);
    if (side === "withdraw" && /hyperliquid/i.test(leg.protocol)) {
      // Out of the Hyperliquid account: USDC on Arbitrum, minus Hyperliquid's fee.
      put("USDC", Math.max(0, size - HL_WITHDRAW_FEE_USD));
    } else if (side === "deposit" && /hyperliquid/i.test(leg.protocol)) {
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
  // A withdrawal from the Hyperliquid account is part of the budget (the caller counts what it delivers), not a spend to scale.
  const isHlWithdraw = (l: L) => /^withdraw$/i.test(l.side.trim()) && /hyperliquid/i.test(l.protocol);
  const fresh = freshCapitalUsd(legs.filter((l) => !isHlWithdraw(l)), hlMarginUsd);
  if (!(fresh > 0) || fresh <= budgetUsd * 1.0001) return { legs, scaled: 1 };
  const scaleBy = (k: number) => (l: L): L => {
    if (!(l.sizeUsd && l.sizeUsd > 0) || isHlWithdraw(l)) return l;
    const size = Math.floor(l.sizeUsd * k * 100) / 100;
    // Hyperliquid doesn't credit deposits under $5: keep the minimum rather than plan a lost deposit.
    const isHlDeposit = /^deposit$/i.test(l.side.trim()) && /hyperliquid/i.test(l.protocol);
    return { ...l, sizeUsd: isHlDeposit ? Math.max(HL_MIN_DEPOSIT_USD, size) : size };
  };
  // Fresh capital isn't proportional to the scale when Hyperliquid margin pays part
  // of it (that part is fixed): find the largest scale that fits, by bisection.
  const fits = (k: number) => freshCapitalUsd(legs.map(scaleBy(k)).filter((l) => !isHlWithdraw(l)), hlMarginUsd) <= budgetUsd * 1.0001;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  // 4 decimals: the plain proportional case lands on budget / fresh exactly.
  const k = Math.floor(lo * 1e4) / 1e4;
  const scale = scaleBy(k);
  return { legs: legs.map(scale), scaled: k };
}
