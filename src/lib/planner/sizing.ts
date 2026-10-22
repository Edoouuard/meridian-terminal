/**
 * sizing.ts — how much of the user's capital a venue plan uses, decided by
 * the server rather than the model:
 *   - the share comes from the user ("100% of my available capital", "half",
 *     "tout mon capital") or, when they gave none, from a question asked
 *     before any plan is built;
 *   - perp legs on Hyperliquid / Extended / TxFlow are then sized from each venue's
 *     free margin × that share × the leg's leverage, the two legs of a pair
 *     to the smaller of the two, so the plan never trades a token amount
 *     while the margin for ten times more sits idle.
 */

import type { LLMLeg, LLMStrategy } from "@/lib/strategyIntegrity";
import { parseAmount } from "@/lib/tradePlan";
import { SIZING_POLICY } from "@/lib/planner/policy";
import type { VenueBalances } from "@/lib/planner/economics";
import type { PlannerClarify } from "@/lib/planner/clarify";
import type { MarketQuote, PerpVenueName } from "@/lib/planner/markets";
import { findQuote } from "@/lib/planner/economics";

const CAPITAL_WORDS = "capital|balance|solde|margin|marge|funds|fonds|money|argent|available|disponible|libre|free";

/** The share of the available capital the user asked for (0-1), or undefined when they didn't say. */
export function capitalShare(text: string): number | undefined {
  const pct = text.match(new RegExp(`(\\d{1,3}(?:[.,]\\d+)?)\\s*%\\s*(?:of|de|du|des)?\\s*(?:my|mon|ma|mes|the|le|la|les|l')?\\s*(?:${CAPITAL_WORDS})`, "i"));
  if (pct) {
    const v = Number(pct[1].replace(",", ".")) / 100;
    if (v > 0 && v <= 1) return v;
  }
  if (new RegExp(`\\b(all|every|tout|toute|tous|totalit[ée]|entire|whole|full|max(?:imum)?)(?![a-z])[^.]{0,30}\\b(${CAPITAL_WORDS})`, "i").test(text)) return 1;
  if (new RegExp(`\\b(half|moiti[ée])(?![a-z])[^.]{0,30}\\b(${CAPITAL_WORDS})`, "i").test(text)) return 0.5;
  return undefined;
}

/**
 * Does the request open perp positions (where the size question matters)?
 * Naming a venue isn't enough: "put $10 into Hyperliquid's vault" is a
 * deposit, not a trade.
 */
export function isPerpRequest(text: string): boolean {
  const trade = /\b(long|short|levier|leverage|lev|\d+\s*x|x\s*\d+|neutral|neutre|perps?|funding|volume|farm\w*)\b/i.test(text);
  if (trade) return true;
  const venue = /\b(hyperliquid|extended|txflow)\b/i.test(text);
  const notATrade = /\b(hlp|vault|stake|staking|deposit|d[ée]pos\w*|withdraw|retir\w*|lend|supply)\b/i.test(text);
  return venue && !notATrade;
}

export interface SizeQuestionInput {
  thesis: string;
  /** The question the user just answered: this one is never asked twice (their answer stands, or the policy's share). */
  answeredQuestion?: string;
  hyperliquidFreeUsd?: number | null;
  extendedFreeUsd?: number | null;
  txflowFreeUsd?: number | null;
}

/**
 * The question to ask before building a perp plan the user gave no size for:
 * how much of the free capital to use. Null when the request has a size (in
 * dollars or as a share), isn't a perp trade, or no venue balance is known.
 */
export function sizeQuestion(i: SizeQuestionInput): { understanding: string; clarify: PlannerClarify } | null {
  if (i.answeredQuestion && /capital/i.test(i.answeredQuestion)) return null;
  if (!isPerpRequest(i.thesis)) return null;
  if (parseAmount(i.thesis) !== undefined || capitalShare(i.thesis) !== undefined) return null;
  const known = [
    typeof i.hyperliquidFreeUsd === "number" ? { venue: "Hyperliquid", usd: i.hyperliquidFreeUsd } : null,
    typeof i.extendedFreeUsd === "number" && i.extendedFreeUsd > 0 ? { venue: "Extended", usd: i.extendedFreeUsd } : null,
    typeof i.txflowFreeUsd === "number" && i.txflowFreeUsd > 0 ? { venue: "TxFlow", usd: i.txflowFreeUsd } : null,
  ].filter((x): x is { venue: string; usd: number } => x !== null);
  if (known.length === 0) return null;
  const fmt = (x: number) => `$${x.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  const balances = known.map((k) => `${k.venue} ${fmt(k.usd)}`).join(", ");
  return {
    understanding: `Before sizing: free margin ${balances}.`,
    clarify: {
      question: "How much of your available capital should this use?",
      why: `Free margin ${balances}. Every market has a minimum size (Extended per quantity, Hyperliquid $10): a small share can fall under it.`,
      options: ["100% of my available capital", "50% of my available capital", "25% of my available capital"],
    },
  };
}

const isPerp = (l: LLMLeg) => /^(long|short)$/i.test(l.side.trim());
const venueOf = (l: LLMLeg): PerpVenueName | null =>
  /extended/i.test(l.protocol) ? "Extended" : /hyperliquid/i.test(l.protocol) ? "Hyperliquid" : /txflow/i.test(l.protocol) ? "TxFlow" : null;
const isDepositTo = (venue: string) => (l: LLMLeg) => /^(deposit|fund)$/i.test(l.side.trim()) && new RegExp(venue, "i").test(l.protocol);

/**
 * Perp legs sized from the venues' free margin: notional = (free + the plan's
 * deposits to that venue − the fee reserve) × share ÷ (1 + margin buffer) ×
 * leverage, split between the venue's perp legs; a neutral pair takes the
 * smaller of its two legs on both. Plans with other priced legs (a
 * Hyperliquid spot buy) or an unknown balance keep the model's sizes, and
 * the economics then say what is missing.
 */
export function sizePerpLegs(s: LLMStrategy, pair: [number, number] | undefined, balances: VenueBalances, share: number): LLMStrategy {
  const legs = s.legs ?? [];
  const perps = legs.map((l, i) => ({ l, i, v: venueOf(l) })).filter((x) => isPerp(x.l) && x.v);
  if (perps.length === 0) return s;
  if (legs.some((l) => /^(buy|swap)$/i.test(l.side.trim()) && venueOf(l) === "Hyperliquid")) return s;
  const free: Record<PerpVenueName, number | null> = {
    Hyperliquid: balances.hyperliquidFreeUsd === null ? null : balances.hyperliquidFreeUsd + legs.filter(isDepositTo("hyperliquid")).reduce((a, l) => a + (l.sizeUsd ?? 0), 0),
    Extended: balances.extendedFreeUsd === null ? null : balances.extendedFreeUsd + legs.filter(isDepositTo("extended")).reduce((a, l) => a + (l.sizeUsd ?? 0), 0),
    TxFlow: balances.txflowFreeUsd === undefined || balances.txflowFreeUsd === null ? null : balances.txflowFreeUsd + legs.filter(isDepositTo("txflow")).reduce((a, l) => a + (l.sizeUsd ?? 0), 0),
  };
  if (perps.some((p) => free[p.v!] === null)) return s;
  const avail = (v: PerpVenueName) => Math.max(0, (free[v] as number) - SIZING_POLICY.feeReserveUsd);
  const toNotional = (margin: number, l: LLMLeg) => (margin / (1 + SIZING_POLICY.marginBufferPct / 100)) * Math.max(1, l.leverage ?? 1);
  const count = (v: PerpVenueName) => perps.filter((p) => p.v === v).length;
  const sized = new Map<number, number>();
  for (const p of perps) sized.set(p.i, toNotional((avail(p.v!) * share) / count(p.v!), p.l));
  const pa = pair && perps.find((p) => p.i === pair[0]);
  const pb = pair && perps.find((p) => p.i === pair[1]);
  if (pa && pb && pa.v !== pb.v) {
    // A pair spends the share of the capital on both venues together, half per leg, as far as each venue's margin goes:
    // 25% of $92 + $24 is $14.50 a leg, not 25% of the smaller venue on both.
    const margin = Math.min(((avail(pa.v!) + avail(pb.v!)) * share) / 2, avail(pa.v!) / count(pa.v!), avail(pb.v!) / count(pb.v!));
    const both = Math.min(toNotional(margin, pa.l), toNotional(margin, pb.l));
    sized.set(pa.i, both);
    sized.set(pb.i, both);
  } else if (pair && sized.has(pair[0]) && sized.has(pair[1])) {
    const both = Math.min(sized.get(pair[0])!, sized.get(pair[1])!);
    sized.set(pair[0], both);
    sized.set(pair[1], both);
  }
  return { ...s, legs: legs.map((l, i) => (sized.has(i) ? { ...l, sizeUsd: Math.floor(sized.get(i)! * 100) / 100 } : l)) };
}

/** The most leverage the server picks on its own to bring a pair over its markets' minimums. */
export const MAX_AUTO_LEVERAGE = 5;

/**
 * A pair sized under one of its markets' minimum order (Extended counts in
 * quantity, Hyperliquid $10), when the user named no leverage: the same
 * margin at a higher leverage, the lowest that clears both minimums, up to
 * MAX_AUTO_LEVERAGE and what both markets allow. Unchanged when the margin
 * can't clear them even then; the economics then say how much is missing.
 */
export function fitPairToMinimums(s: LLMStrategy, pair: [number, number] | undefined, quotes: MarketQuote[]): { strategy: LLMStrategy; raisedTo?: number } {
  const legs = s.legs ?? [];
  if (!pair) return { strategy: s };
  const [a, b] = pair.map((i) => legs[i]);
  if (!a || !b || !(a.sizeUsd && a.sizeUsd > 0) || !(b.sizeUsd && b.sizeUsd > 0)) return { strategy: s };
  const qa = findQuote(a, quotes);
  const qb = findQuote(b, quotes);
  if (!qa || !qb) return { strategy: s };
  // 2% over the minimum: the quantity rounds down to the coarser size step.
  const minNotional = Math.max(qa.minQty * qa.markUsd, qa.minNotionalUsd, qb.minQty * qb.markUsd, qb.minNotionalUsd) * 1.02;
  const size = Math.min(a.sizeUsd, b.sizeUsd);
  if (size >= minNotional) return { strategy: s };
  const lev = Math.max(1, a.leverage ?? 1, b.leverage ?? 1);
  const cap = Math.min(MAX_AUTO_LEVERAGE, qa.maxLeverage || 1, qb.maxLeverage || 1);
  const target = Math.ceil((lev * minNotional) / size);
  if (target > cap || target <= lev) return { strategy: s };
  const note = ` Leverage raised to ${target}x by Meridian: at ${lev}x this margin is under the market minimum.`;
  const scaled = (l: LLMLeg) => ({ ...l, leverage: target, sizeUsd: Math.floor(((size * target) / lev) * 100) / 100, note: `${l.note ?? ""}${note}`.trim() });
  return { strategy: { ...s, legs: legs.map((l, i) => (i === pair[0] || i === pair[1] ? scaled(l) : l)) }, raisedTo: target };
}

/** Did the user name a leverage ("3x", "levier 5", "leverage of 2")? */
export function mentionsLeverage(text: string): boolean {
  return /(?:levier|leverage|\blev)\s*(?:de|of|x|à|:)?\s*x?\s*\d/i.test(text) || /\b\d+(?:[.,]\d+)?\s*x\b/i.test(text) || /\bx\s*\d+(?:[.,]\d+)?\b/i.test(text);
}

/**
 * Is the request about farming a venue's points or airdrop? Users say it as
 * "maximize volume and OI", "boost my volume", "farm points", "airdrop":
 * trading volume and open interest are what perp venues reward, so the goal
 * is the most volume and open interest per dollar of cost, kept neutral.
 */
export function isFarmingIntent(text: string): boolean {
  return (
    /\b(airdrops?|points?|farm\w*|grind\w*|season)\b/i.test(text) ||
    /\b(maximi[sz]e|maximi[sz]er|boost\w*|increase|augment\w*|pump|generate|g[ée]n[ée]rer|faire|make|more|plus de|max)\b[^.]{0,40}\b(volume|oi|open interest|open-interest)\b/i.test(text) ||
    /\b(volume|oi|open interest)\b[^.]{0,25}\b(farm\w*|max\w*|boost\w*)\b/i.test(text)
  );
}

/** Below this, a deposit is lost on the venues' bridges (Hyperliquid, Extended and TxFlow all take $5 minimum). */
const MIN_VENUE_DEPOSIT_USD = 5;

/**
 * A pair the server built, on a venue with next to no margin while the wallet
 * holds stablecoins: a Deposit leg to that venue first (USDC on Arbitrum; the
 * client adds the bridge when the funds are elsewhere), as much as balances
 * the two venues, within what the wallet holds. The sizing then counts it.
 */
export function addPairDeposits(s: LLMStrategy, balances: VenueBalances): LLMStrategy {
  const legs = s.legs ?? [];
  const perps = legs.filter(isPerp).map((l) => ({ l, v: venueOf(l) })).filter((x): x is { l: LLMLeg; v: PerpVenueName } => !!x.v);
  if (perps.length !== 2 || perps[0].v === perps[1].v) return s;
  const free = (v: PerpVenueName) => (v === "Hyperliquid" ? balances.hyperliquidFreeUsd : v === "Extended" ? balances.extendedFreeUsd : (balances.txflowFreeUsd ?? null));
  let wallet = Math.floor(balances.walletDeployableUsd * 100) / 100;
  const deposits: LLMLeg[] = [];
  const [a, b] = perps.map((p) => p.v);
  for (const [v, other] of [[a, b], [b, a]] as const) {
    const fv = free(v);
    if (fv === null || fv >= MIN_VENUE_DEPOSIT_USD || legs.some(isDepositTo(v))) continue;
    const amount = Math.floor(Math.min(wallet, Math.max(MIN_VENUE_DEPOSIT_USD, (free(other) ?? 0) - fv)) * 100) / 100;
    if (amount < MIN_VENUE_DEPOSIT_USD) continue;
    wallet -= amount;
    deposits.push({ side: "Deposit", asset: "USDC", protocol: v, chain: "Arbitrum", sizeUsd: amount, note: `Moves $${amount.toFixed(2)} USDC from the wallet to ${v} for the margin of the ${v} leg.` } as LLMLeg);
  }
  return deposits.length ? { ...s, legs: [...deposits, ...legs] } : s;
}
