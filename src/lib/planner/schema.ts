/**
 * schema.ts — the planner's output contract and the server checks that make
 * it hold whatever the model writes (pipeline step 2 and 3 of STRATEGIST.md):
 *   - a plan that answers the request ("requested") is kept apart from one
 *     that changes a hard constraint ("alternative", with the change named);
 *   - "blocked" plans say what blocks them; venue plans are sized and priced
 *     here from the market quotes (lib/planner/economics.ts);
 *   - the recommendation is chosen here, among executable requested plans,
 *     with the ranking keys of the product policy.
 */

import type { LLMLeg, LLMStrategy } from "@/lib/strategyIntegrity";
import { belowMinimum } from "@/lib/strategyIntegrity";
import type { ExplicitPerpOrder } from "@/lib/explicitOrder";
import { marketBase } from "@/lib/perpVenues";
import { EXECUTION_POLICY, SIZING_POLICY } from "@/lib/planner/policy";
import type { MarketSnapshot } from "@/lib/planner/markets";
import { computeVenueEconomics, findQuote, isVenuePlan, type Economics, type VenueBalances } from "@/lib/planner/economics";
import { sizePerpLegs } from "@/lib/planner/sizing";

export type { Economics } from "@/lib/planner/economics";

export type Objective = "explicit_order" | "farming" | "neutral_carry" | "yield" | "hedge" | "directional" | "move";

/** Where a number comes from (doctrine section 3). */
export interface Figure {
  label: string;
  value: string;
  kind: "observed" | "calculated" | "assumption";
  /** Observed: the data it comes from. Calculated: the formula. Assumption: the policy or choice. */
  source: string;
}

/** How a two-leg position is sent (product execution policy, per plan). */
export interface PairExecution {
  /** Leg indexes in the order they are sent. */
  sequence: number[];
  orderType: string;
  maxSlippagePct: Record<number, number>;
  maxUnhedgedSeconds: number;
  secondLegSizing: string;
  onPartialFill: string;
  requiresUserApproval: readonly string[];
}

export interface PlannerFields {
  kind?: "requested" | "alternative";
  /** For an alternative: each hard constraint it changes ("venue: Extended → Hyperliquid"). */
  changes?: string[];
  /** Preparation status. What happens after sending (filled, partially filled) is tracked separately. */
  status?: "executable" | "blocked";
  blockers?: string[];
  economics?: Economics;
  figures?: Figure[];
  /** Two legs that must both fill for the position to be neutral. */
  pair?: { legs: [number, number]; sizing: "equal_base_quantity" };
  execution?: PairExecution;
}

export type PlannerStrategy = LLMStrategy & PlannerFields;

export interface ConformanceContext {
  /** The order the user typed, when there is one. */
  order: ExplicitPerpOrder | null;
  /** Perp venues the user named ("entre Extended et Hyperliquid"). */
  namedVenues: ("Hyperliquid" | "Extended")[];
  /** Extended account as the server knows it; undefined balance = unknown. */
  extended?: { connected: boolean; network?: string; availableUsd?: number };
  /** Market quotes for venue plans; without them venue plans can't be sized here. */
  markets?: MarketSnapshot;
  /** Free amounts per venue (null = unknown). */
  balances?: VenueBalances;
  /** Share of the free margin perp legs use (lib/planner/sizing.ts); undefined = the model's sizes stand (the user gave a dollar size). */
  sizeShare?: number;
  now?: number;
}

/** Perp venues named in the request. */
export function namedVenues(thesis: string): ("Hyperliquid" | "Extended")[] {
  const out: ("Hyperliquid" | "Extended")[] = [];
  if (/\b(hyperliquid|hl)\b/i.test(thesis)) out.push("Hyperliquid");
  if (/\b(extended|x10)\b/i.test(thesis)) out.push("Extended");
  return out;
}

const isPerp = (l: LLMLeg) => /^(long|short)$/i.test(l.side.trim());
const venueOf = (l: LLMLeg) => (/extended/i.test(l.protocol) ? "Extended" : /hyperliquid/i.test(l.protocol) ? "Hyperliquid" : l.protocol);

/** How a strategy departs from the user's hard constraints (empty = it answers the request). */
export function deviations(s: LLMStrategy, ctx: ConformanceContext): string[] {
  const out: string[] = [];
  const legs = s.legs ?? [];
  const venues = new Set(legs.map(venueOf));
  const o = ctx.order;
  // An order names one venue for one trade (checked below); otherwise every venue named must be used.
  if (!o) {
    for (const v of ctx.namedVenues) {
      if (!venues.has(v)) out.push(`venue: ${v} not used (you named it)`);
    }
  }
  if (o) {
    const leg = legs.find((l) => isPerp(l) && l.side.toLowerCase() === o.side.toLowerCase() && marketBase(l.asset) === marketBase(o.asset));
    if (!leg) {
      out.push(`order: no ${o.side.toLowerCase()} ${o.asset}`);
    } else {
      const venue = o.venue ?? (ctx.namedVenues.length === 1 ? ctx.namedVenues[0] : undefined);
      if (venue && venueOf(leg) !== venue) out.push(`venue: ${venue} → ${venueOf(leg)}`);
      if (o.leverage && leg.leverage !== o.leverage) out.push(`leverage: ${o.leverage}x → ${leg.leverage ?? 1}x`);
      if (o.stopLossPct && leg.stopLossPct !== o.stopLossPct) out.push(`stop-loss: ${o.stopLossPct}% → ${leg.stopLossPct ? `${leg.stopLossPct}%` : "none"}`);
      if (o.takeProfitPct && leg.takeProfitPct !== o.takeProfitPct) out.push(`take-profit: ${o.takeProfitPct}% → ${leg.takeProfitPct ? `${leg.takeProfitPct}%` : "none"}`);
      if (o.sizeUsd && Math.abs((leg.sizeUsd ?? 0) - o.sizeUsd) > o.sizeUsd * 0.01) out.push(`size: $${o.sizeUsd} → $${leg.sizeUsd ?? 0}`);
    }
  }
  return out;
}

const isExtDeposit = (l: LLMLeg) => /extended/i.test(l.protocol) && /^(deposit|fund)$/i.test(l.side.trim());

/** Why the Extended legs can't run now, from the account state (empty = they can, or there are none). A deposit leg in the plan counts toward the margin. */
export function extendedBlockers(s: LLMStrategy, ext: ConformanceContext["extended"], walletUsd?: number): string[] {
  const legs = (s.legs ?? []).filter((l) => isPerp(l) && venueOf(l) === "Extended");
  const depositLegs = (s.legs ?? []).filter(isExtDeposit);
  if (legs.length === 0 && depositLegs.length === 0) return [];
  if (!ext?.connected) return ["Extended account not connected (Tools → Extended, three wallet signatures)."];
  if (ext.network && ext.network !== "mainnet") return [`Extended is connected on ${ext.network} only; real orders need the mainnet account.`];
  if (ext.availableUsd === undefined) return ["Extended balance unknown right now (status unknown): these legs aren't treated as executable."];
  const planned = depositLegs.reduce((a, l) => a + (l.sizeUsd ?? 0), 0);
  const deposits = walletUsd === undefined ? planned : Math.min(planned, walletUsd);
  if (planned > 0 && deposits < planned) return [`The deposit to Extended needs $${Math.ceil(planned)} of USDC on Arbitrum; the wallet holds about $${Math.floor(walletUsd ?? 0)}.`];
  const needed = legs.reduce((a, l) => a + ((l.sizeUsd ?? 0) / Math.max(1, l.leverage ?? 1)) * (1 + SIZING_POLICY.marginBufferPct / 100), 0);
  if (legs.length > 0 && (ext.availableUsd + deposits < needed || ext.availableUsd + deposits <= SIZING_POLICY.feeReserveUsd)) {
    return [
      `Extended has $${Math.floor(ext.availableUsd)} free (observed)${deposits > 0 ? ` plus a $${Math.floor(deposits)} deposit` : ""}; these legs need ~$${Math.ceil(needed)} of margin. Add a deposit from Arbitrum USDC.`,
    ];
  }
  return [];
}

const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * Economics the model gave for a plan the server can't price itself (spot
 * DeFi): keep its inputs, recompute the return with the one formula, null
 * with a reason when an input is missing or invalid.
 */
export function recomputeEconomics(e: Partial<Economics> | undefined, defaultHoldingDays: number): Economics | undefined {
  if (!e) return undefined;
  const capital = finite(e.capitalCommittedUsd) ?? null;
  const holdingDays = finite(e.holdingDays) && (e.holdingDays as number) > 0 ? (e.holdingDays as number) : defaultHoldingDays;
  const carry = finite(e.annualizedGrossCarryUsd) ?? null;
  const cost = finite(e.entryExitCostUsd) ?? null;
  const out: Economics = {
    capitalCommittedUsd: capital,
    volumeUsd: finite(e.volumeUsd) ?? null,
    annualizedGrossCarryUsd: carry,
    entryExitCostUsd: cost,
    holdingDays,
    annualizedReturnOnCapitalPct: null,
  };
  if (capital === null || !(capital > 0)) out.returnUnavailableReason = "capital committed unknown or zero";
  else if (carry === null) out.returnUnavailableReason = "no carry or yield given";
  else out.annualizedReturnOnCapitalPct = Math.round((100 * (carry - (cost ?? 0) * (365 / holdingDays)) / capital) * 100) / 100;
  return out;
}

export const HOLDING_DAYS: Record<Objective, number> = {
  explicit_order: SIZING_POLICY.defaultHoldingDays.directional,
  directional: SIZING_POLICY.defaultHoldingDays.directional,
  farming: SIZING_POLICY.defaultHoldingDays.farming,
  neutral_carry: SIZING_POLICY.defaultHoldingDays.carry,
  hedge: SIZING_POLICY.defaultHoldingDays.hedge,
  yield: SIZING_POLICY.defaultHoldingDays.yield,
  move: SIZING_POLICY.defaultHoldingDays.yield,
};

/** The two legs of a neutral position: a long exposure and a short on the same asset. */
export function findPair(s: LLMStrategy): PlannerFields["pair"] {
  const legs = s.legs ?? [];
  const shortIdx = legs.findIndex((l) => l.side.toLowerCase() === "short");
  if (shortIdx < 0) return undefined;
  const base = marketBase(legs[shortIdx].asset);
  const longIdx = legs.findIndex(
    (l, i) => i !== shortIdx && /^(long|buy)$/i.test(l.side.trim()) && (marketBase(l.asset) === base || marketBase(l.asset) === `U${base}`),
  );
  return longIdx < 0 ? undefined : { legs: [longIdx, shortIdx] as [number, number], sizing: "equal_base_quantity" };
}

/** Put the pair's harder fill (lower 24h volume) first, per the execution policy. */
function sequencePair(s: PlannerStrategy, markets: MarketSnapshot | undefined): PlannerStrategy {
  const pair = findPair(s);
  if (!pair || !markets) return s;
  const [a, b] = pair.legs;
  const qa = findQuote(s.legs[a], markets.quotes);
  const qb = findQuote(s.legs[b], markets.quotes);
  if (!qa || !qb) return s;
  const first = qa.dayVolumeUsd <= qb.dayVolumeUsd ? a : b;
  const second = first === a ? b : a;
  if (first < second) return s;
  const legs = s.legs.slice();
  [legs[first], legs[second]] = [legs[second], legs[first]];
  return { ...s, legs };
}

function executionFor(s: PlannerStrategy, pair: [number, number]): PairExecution {
  const [x, y] = pair[0] < pair[1] ? pair : [pair[1], pair[0]];
  const slip = (i: number) => EXECUTION_POLICY.maxSlippagePct[venueOf(s.legs[i]) === "Extended" ? "Extended" : "Hyperliquid"];
  return {
    sequence: [x, y],
    orderType: EXECUTION_POLICY.orderType,
    maxSlippagePct: { [x]: slip(x), [y]: slip(y) },
    maxUnhedgedSeconds: EXECUTION_POLICY.maxUnhedgedSeconds,
    secondLegSizing: EXECUTION_POLICY.secondLegSizing,
    onPartialFill: EXECUTION_POLICY.onPartialFill,
    requiresUserApproval: EXECUTION_POLICY.requiresUserApproval,
  };
}

/** Server-side figures for a venue plan: observed quotes, calculated sizes, assumptions. */
function venueFigures(e: Economics): Figure[] {
  const out: Figure[] = [];
  for (const l of e.legs ?? []) {
    out.push({ label: `${l.market} price (${l.venue})`, value: `$${l.referencePriceUsd.toLocaleString("en-US", { maximumFractionDigits: 4 })}`, kind: "observed", source: `${l.venue} market data at ${e.asOf}` });
    if (l.marketFundingAnnualPct !== 0) {
      out.push({ label: `${l.market} funding (${l.venue})`, value: `${l.marketFundingAnnualPct >= 0 ? "+" : ""}${l.marketFundingAnnualPct.toFixed(2)}%/yr, ${l.side} ${l.legCarryAnnualPct >= 0 ? "earns" : "pays"} it`, kind: "observed", source: `${l.venue} hourly rate × 8,760` });
    }
    if (l.baseQuantity !== null) out.push({ label: `${l.market} quantity`, value: `${l.baseQuantity}`, kind: "calculated", source: "size ÷ price, rounded down to a step valid on the market(s)" });
  }
  out.push({ label: "Holding period", value: `${e.holdingDays} days`, kind: "assumption", source: "product policy default unless you gave one" });
  out.push({ label: "Margin buffer", value: `${SIZING_POLICY.marginBufferPct}%`, kind: "assumption", source: "product policy" });
  return out;
}

/** Ranking keys per objective (policy.ts RANKING_POLICY), lower is better. */
function rankKey(objective: Objective | undefined, s: PlannerStrategy): number[] {
  const e = s.economics;
  const n = (x: number | null | undefined, missing: number) => (x === null || x === undefined ? missing : x);
  if (objective === "farming") {
    const cpv = e?.entryExitCostUsd != null && e.volumeUsd ? e.entryExitCostUsd / e.volumeUsd : Infinity;
    const netOverHolding = e?.annualizedGrossCarryUsd != null ? (e.annualizedGrossCarryUsd * (e.holdingDays / 365)) - n(e.entryExitCostUsd, 0) : -Infinity;
    return [cpv, n(e?.capitalToAddUsd, Infinity), n(e?.capitalCommittedUsd, Infinity), -netOverHolding];
  }
  if (objective === "yield" || objective === "neutral_carry") return [-n(e?.annualizedReturnOnCapitalPct, -Infinity), n(e?.capitalToAddUsd, Infinity)];
  return [];
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export interface ConformanceResult {
  strategies: PlannerStrategy[];
  /** Index of the recommended plan — always a requested one; undefined when none answers the request. */
  recommended?: number;
  /** What the checks changed, for the logs. */
  notes: string[];
}

/**
 * Make the model's answer hold the contract. Requested plans come first,
 * executable ones ranked by the objective's keys, then blocked ones;
 * executable alternatives follow, each naming what it changes; at most
 * three plans; the recommendation never falls on an alternative.
 */
export function enforceConformance(raw: LLMStrategy[], objective: Objective | undefined, ctx: ConformanceContext): ConformanceResult {
  const notes: string[] = [];
  const out: PlannerStrategy[] = [];
  const holding = HOLDING_DAYS[objective ?? "yield"];
  for (const s0 of raw as PlannerStrategy[]) {
    let s: PlannerStrategy = { ...s0, legs: (s0.legs ?? []).slice() };
    const dev = deviations(s, ctx);
    const llmChanges = Array.isArray(s.changes) ? s.changes.filter((c) => typeof c === "string" && c.trim()) : [];
    if (dev.length > 0) {
      if (s.kind !== "alternative") notes.push(`"${s.name}" reclassified as an alternative: ${dev.join("; ")}`);
      s.kind = "alternative";
      s.changes = [...new Set([...dev, ...llmChanges])];
    } else {
      s.kind = "requested";
      s.changes = undefined;
    }

    s = sequencePair(s, ctx.markets);
    const pair = findPair(s);
    s.pair = pair;
    s.execution = pair ? executionFor(s, pair.legs) : undefined;

    // Venue plans: the server sizes the perp legs from the free margin, and their return lives in the economics, not in an APY.
    if (isVenuePlan(s)) {
      if (ctx.sizeShare !== undefined && ctx.balances) s = sizePerpLegs(s, pair?.legs, ctx.balances, ctx.sizeShare);
      s.apy = undefined;
    }
    const blockers = [...extendedBlockers(s, ctx.extended, ctx.balances?.walletDeployableUsd)];
    if (isVenuePlan(s) && ctx.markets && ctx.balances) {
      const v = computeVenueEconomics(s, pair?.legs, ctx.markets, ctx.balances, holding, ctx.now);
      s.economics = v.economics;
      s.figures = venueFigures(v.economics);
      blockers.push(...v.blockers);
    } else if (isVenuePlan(s)) {
      blockers.push("Market data unavailable right now: this plan can't be sized or priced.");
      s.economics = undefined;
    } else {
      s.economics = recomputeEconomics(s.economics, holding);
    }
    // Venue plans are checked against each market's own minimum above; other steps against the $5 floor.
    const tooSmall = isVenuePlan(s) ? null : belowMinimum(s);
    if (tooSmall) blockers.push(tooSmall);
    const own = Array.isArray(s.blockers) ? s.blockers.filter((b) => typeof b === "string" && b.trim()) : [];
    const all = [...new Set([...blockers, ...own])];
    s.blockers = all.length ? all : undefined;
    s.status = s.blockers ? "blocked" : "executable";

    // An alternative is only worth showing if it runs now.
    if (s.kind === "alternative" && s.status === "blocked") {
      notes.push(`"${s.name}" dropped: a blocked alternative`);
      continue;
    }
    out.push(s);
  }

  const requested = out.filter((s) => s.kind === "requested");
  const alternatives = out.filter((s) => s.kind === "alternative");
  const runnable = requested.filter((s) => s.status === "executable").sort((a, b) => compareKeys(rankKey(objective, a), rankKey(objective, b)));
  const blocked = requested.filter((s) => s.status === "blocked");
  const ordered = [...runnable, ...blocked, ...alternatives].slice(0, 3);
  const recommended = ordered.findIndex((s) => s.kind === "requested");
  return { strategies: ordered, recommended: recommended >= 0 ? recommended : undefined, notes };
}
