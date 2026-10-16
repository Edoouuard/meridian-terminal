/**
 * economics.ts — the server computes every venue plan's numbers itself, leg
 * by leg, from the market quotes (lib/planner/markets.ts): quantity valid on
 * the market(s), notional at the reference price, funding carry from that
 * leg's side, fees, margin. The model only proposes structure and explains.
 */

import type { LLMLeg, LLMStrategy } from "@/lib/strategyIntegrity";
import { marketBase } from "@/lib/perpVenues";
import type { MarketQuote, MarketSnapshot } from "@/lib/planner/markets";
import { DATA_POLICY, SIZING_POLICY } from "@/lib/planner/policy";
import { HL_WITHDRAW_FEE_USD } from "@/lib/integrations/hyperliquidExchange";

const HOURS_PER_YEAR = 24 * 365;

export interface LegEconomics {
  legIndex: number;
  venue: "Hyperliquid" | "Extended";
  market: string;
  side: "long" | "short";
  /** null when the plan has no size (blocked on an unknown amount). */
  baseQuantity: number | null;
  referencePriceUsd: number;
  notionalUsd: number | null;
  /** The market's funding, annualized, in %: positive = longs pay shorts. */
  marketFundingAnnualPct: number;
  /** Carry for this leg's side, in % per year: + earned, − paid. */
  legCarryAnnualPct: number;
  annualizedCarryUsd: number | null;
  /** Money this leg locks on its venue (margin for a perp, the purchase for spot). */
  capitalUsd: number | null;
  takerFee: number;
}

export interface Economics {
  /** User capital allocated to the plan, counted once (deposits and transfers are funding moves, not capital). */
  capitalCommittedUsd: number | null;
  /** Of which already on the venues that use it. */
  capitalAvailableUsd?: number | null;
  /** Still to bring to those venues (null = a balance is unknown). */
  capitalToAddUsd?: number | null;
  transferFeesUsd?: number | null;
  /** Traded notional for one open + one close of every leg. */
  volumeUsd?: number | null;
  /** Σ legs' carry at today's rates: a projection, not a promise. */
  annualizedGrossCarryUsd?: number | null;
  entryExitCostUsd?: number | null;
  holdingDays: number;
  /** 100 × (carry − cost × 365 / holdingDays) / capital; null with a reason when it can't be computed. */
  annualizedReturnOnCapitalPct: number | null;
  returnUnavailableReason?: string;
  legs?: LegEconomics[];
  /** When the quotes were read, and whether they are older than the price policy allows (then indicative only). */
  asOf?: string;
  dataStatus?: "ok" | "stale";
}

const isPerp = (l: LLMLeg) => /^(long|short)$/i.test(l.side.trim());
const isHlSpotBuy = (l: LLMLeg) => /hyperliquid/i.test(l.protocol) && /^(buy|swap)$/i.test(l.side.trim()) && /\b(UETH|UBTC|USOL)\b/i.test(l.asset);
const venueOf = (l: LLMLeg): "Hyperliquid" | "Extended" | null => (/extended/i.test(l.protocol) ? "Extended" : /hyperliquid/i.test(l.protocol) ? "Hyperliquid" : null);

/** Does this plan trade on Hyperliquid or Extended (the venues the server can price)? */
export function isVenuePlan(s: LLMStrategy): boolean {
  return (s.legs ?? []).some((l) => (isPerp(l) && venueOf(l) !== null) || isHlSpotBuy(l));
}

export function findQuote(leg: LLMLeg, quotes: MarketQuote[]): MarketQuote | undefined {
  const venue = venueOf(leg);
  if (!venue) return undefined;
  if (isHlSpotBuy(leg)) {
    const token = leg.asset.match(/\b(UETH|UBTC|USOL)\b/i)![1].toUpperCase();
    return quotes.find((q) => q.venue === "Hyperliquid" && q.kind === "spot" && q.market === token);
  }
  const name = leg.asset.trim().replace(/\s*-?PERP$/i, "");
  const perps = quotes.filter((q) => q.venue === venue && q.kind === "perp");
  return perps.find((q) => q.market === name) ?? perps.filter((q) => q.base === marketBase(leg.asset)).sort((a, b) => b.dayVolumeUsd - a.dayVolumeUsd)[0];
}

function decimals(x: number): number {
  const s = x.toString();
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  return s.includes(".") ? s.split(".")[1].length : 0;
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** The smallest quantity step valid on every market: the least common multiple of their steps. */
export function commonStep(steps: number[]): number {
  const d = Math.max(...steps.map(decimals));
  const ints = steps.map((s) => Math.round(s * 10 ** d));
  const lcm = ints.reduce((a, b) => (a * b) / gcd(a, b));
  return lcm / 10 ** d;
}

export function roundDownTo(q: number, step: number): number {
  const d = decimals(step);
  return Number((Math.floor(q / step + 1e-9) * step).toFixed(d));
}

export interface VenueBalances {
  /** Free margin on Hyperliquid; null = unknown. */
  hyperliquidFreeUsd: number | null;
  /** Free USDC on Extended; null = unknown, undefined = not connected (0). */
  extendedFreeUsd: number | null;
  /** Free wallet balance that Deposit legs can move to Hyperliquid. */
  walletDeployableUsd: number;
}

export interface VenueEconomicsResult {
  economics: Economics;
  /** Why the plan can't execute as sized (minimums, missing market data, missing capital). */
  blockers: string[];
}

/**
 * Legs, quantities and economics of a plan trading on Hyperliquid / Extended.
 * A neutral pair (a long exposure and a short on the same asset) gets one
 * base quantity valid on both markets; other legs round to their own market.
 */
export function computeVenueEconomics(
  s: LLMStrategy,
  pair: [number, number] | undefined,
  snapshot: MarketSnapshot,
  balances: VenueBalances,
  holdingDays: number,
  now: number = Date.now(),
): VenueEconomicsResult {
  const blockers: string[] = [];
  const legs = s.legs ?? [];
  const priced = legs.map((l, i) => ({ l, i, q: isPerp(l) || isHlSpotBuy(l) ? findQuote(l, snapshot.quotes) : undefined })).filter((x) => venueOf(x.l) && (isPerp(x.l) || isHlSpotBuy(x.l)));
  for (const p of priced) if (!p.q) blockers.push(`No live market data for ${p.l.asset} on ${venueOf(p.l)}: it can't be sized or priced now.`);

  // Base quantity per leg.
  const qty = new Map<number, number | null>();
  const pairLegs = pair ? priced.filter((p) => pair.includes(p.i)) : [];
  if (pairLegs.length === 2 && pairLegs.every((p) => p.q)) {
    const sizes = pairLegs.map((p) => p.l.sizeUsd);
    if (sizes.some((x) => !(x && x > 0))) {
      pairLegs.forEach((p) => qty.set(p.i, null));
    } else {
      const raw = Math.min(...pairLegs.map((p) => (p.l.sizeUsd as number) / p.q!.markUsd));
      const q = roundDownTo(raw, commonStep(pairLegs.map((p) => p.q!.sizeStep)));
      pairLegs.forEach((p) => qty.set(p.i, q));
    }
  }
  for (const p of priced) {
    if (qty.has(p.i) || !p.q) continue;
    qty.set(p.i, p.l.sizeUsd && p.l.sizeUsd > 0 ? roundDownTo(p.l.sizeUsd / p.q.markUsd, p.q.sizeStep) : null);
  }

  const legEcon: LegEconomics[] = [];
  for (const p of priced) {
    if (!p.q) continue;
    const q = qty.get(p.i) ?? null;
    const side: "long" | "short" = /short/i.test(p.l.side) ? "short" : "long";
    const notional = q === null ? null : q * p.q.markUsd;
    const marketFundingAnnualPct = p.q.fundingHourly * HOURS_PER_YEAR * 100;
    const legCarryAnnualPct = p.q.kind === "spot" ? 0 : side === "short" ? marketFundingAnnualPct : -marketFundingAnnualPct;
    const lev = Math.max(1, p.l.leverage ?? 1);
    const capital = notional === null ? null : p.q.kind === "spot" ? notional : (notional / lev) * (1 + SIZING_POLICY.marginBufferPct / 100);
    if (q === null) {
      blockers.push(`${p.l.asset} on ${p.q.venue}: no size (the free amount to size it from is unknown or empty).`);
    } else {
      if (q <= 0 || q < p.q.minQty || (notional ?? 0) < p.q.minNotionalUsd) {
        blockers.push(
          `${p.l.asset} on ${p.q.venue}: ${q} ${p.q.base} (~$${(notional ?? 0).toFixed(2)}) is under the market minimum (${p.q.minQty ? `${p.q.minQty} ${p.q.base}` : `$${p.q.minNotionalUsd}`}).`,
        );
      }
    }
    legEcon.push({
      legIndex: p.i,
      venue: p.q.venue,
      market: p.q.market,
      side,
      baseQuantity: q,
      referencePriceUsd: p.q.markUsd,
      notionalUsd: notional,
      marketFundingAnnualPct,
      legCarryAnnualPct,
      annualizedCarryUsd: notional === null ? null : (notional * legCarryAnnualPct) / 100,
      capitalUsd: capital,
      takerFee: p.q.takerFee,
    });
  }

  const sum = (xs: (number | null)[]) => (xs.some((x) => x === null) ? null : xs.reduce<number>((a, b) => a + (b as number), 0));
  const capitalByVenue = (v: "Hyperliquid" | "Extended") => sum(legEcon.filter((l) => l.venue === v).map((l) => l.capitalUsd));
  const hlCapital = capitalByVenue("Hyperliquid") ?? null;
  const extCapital = capitalByVenue("Extended") ?? null;
  const capitalCommitted = sum([hlCapital, extCapital]);

  // What is already on each venue (plus what the plan's own Deposit legs bring to Hyperliquid, from the wallet).
  const deposits = legs.filter((l) => /^deposit$/i.test(l.side.trim()) && /hyperliquid/i.test(l.protocol)).reduce((a, l) => a + (l.sizeUsd ?? 0), 0);
  const hlAvail = balances.hyperliquidFreeUsd === null ? null : balances.hyperliquidFreeUsd + Math.min(deposits, balances.walletDeployableUsd);
  const hasHl = legEcon.some((l) => l.venue === "Hyperliquid");
  const hasExt = legEcon.some((l) => l.venue === "Extended");
  const toAdd = (need: number | null, have: number | null, used: boolean) => (!used ? 0 : need === null || have === null ? null : Math.max(0, need - have));
  const hlToAdd = toAdd(hlCapital, hlAvail, hasHl);
  const extToAdd = toAdd(extCapital, balances.extendedFreeUsd, hasExt);
  const capitalToAdd = sum([hlToAdd, extToAdd]);
  const capitalAvailable = capitalCommitted === null || capitalToAdd === null ? null : capitalCommitted - capitalToAdd;
  if (hasHl && hlToAdd !== null && hlToAdd > 0.5) blockers.push(`Hyperliquid needs ~$${Math.ceil(hlToAdd)} more free margin than the account and the plan's deposits provide.`);
  if (hasHl && hlToAdd === null && hlCapital !== null) blockers.push("Hyperliquid free margin unknown right now: the plan isn't treated as executable.");

  const withdrawals = legs.filter((l) => /^withdraw$/i.test(l.side.trim()) && /hyperliquid/i.test(l.protocol)).length;
  const hasBridge = legs.some((l) => /^bridge$/i.test(l.side.trim()));
  const transferFees = hasBridge ? null : withdrawals * HL_WITHDRAW_FEE_USD;

  const volume = sum(legEcon.map((l) => (l.notionalUsd === null ? null : l.notionalUsd * 2)));
  const carry = sum(legEcon.map((l) => l.annualizedCarryUsd));
  const cost = sum(legEcon.map((l) => (l.notionalUsd === null ? null : l.notionalUsd * l.takerFee * 2)));

  let ret: number | null = null;
  let reason: string | undefined;
  if (capitalCommitted === null || !(capitalCommitted > 0)) reason = "capital committed unknown or zero";
  else if (!(holdingDays > 0)) reason = "holding period must be positive";
  else if (carry === null || cost === null) reason = "a leg has no size";
  else ret = Math.round((100 * (carry - cost * (365 / holdingDays)) / capitalCommitted) * 100) / 100;

  const ageSeconds = (now - Date.parse(snapshot.fetchedAt)) / 1000;
  const r2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);
  return {
    blockers,
    economics: {
      capitalCommittedUsd: r2(capitalCommitted),
      capitalAvailableUsd: r2(capitalAvailable),
      capitalToAddUsd: r2(capitalToAdd),
      transferFeesUsd: transferFees,
      volumeUsd: r2(volume),
      annualizedGrossCarryUsd: r2(carry),
      entryExitCostUsd: cost === null ? null : Math.round(cost * 10000) / 10000,
      holdingDays,
      annualizedReturnOnCapitalPct: ret,
      returnUnavailableReason: reason,
      legs: legEcon,
      asOf: snapshot.fetchedAt,
      dataStatus: Number.isFinite(ageSeconds) && ageSeconds > DATA_POLICY.marketPrice.maxAgeSeconds ? "stale" : "ok",
    },
  };
}
