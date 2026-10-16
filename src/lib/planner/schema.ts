/**
 * schema.ts — the planner's output contract and the server checks that make
 * it hold whatever the model writes:
 *   - a plan that answers the request ("requested") is kept apart from one
 *     that changes a hard constraint ("alternative", with the change named);
 *   - "blocked" plans say what blocks them; Extended feasibility comes from
 *     the account state the server knows, not from the model;
 *   - economics are recomputed from their inputs (one formula, one meaning);
 *   - the recommendation is chosen here, among requested plans only.
 */

import type { LLMLeg, LLMStrategy } from "@/lib/strategyIntegrity";
import type { ExplicitPerpOrder } from "@/lib/explicitOrder";
import { marketBase } from "@/lib/perpVenues";
import { SIZING_POLICY } from "@/lib/planner/policy";

export type Objective = "explicit_order" | "farming" | "neutral_carry" | "yield" | "hedge" | "directional" | "move";

/** Where a number comes from (doctrine section 4). */
export interface Figure {
  label: string;
  value: string;
  kind: "observed" | "calculated" | "assumption";
  /** Observed: the data line it comes from. Calculated: the formula. Assumption: the policy or choice. */
  source: string;
}

export interface Economics {
  capitalCommittedUsd: number;
  notionalPerLegUsd?: number;
  /** Traded notional for one open + close of every leg (farming). */
  volumeUsd?: number;
  /** Funding / yield per year at today's rates (a projection, not a promise). */
  annualizedGrossCarryUsd?: number;
  /** Fees to open and close every leg once. */
  entryExitCostUsd?: number;
  holdingDays: number;
  /** Calculated here: (carry − cost × 365 / holdingDays) / capital. */
  annualizedReturnOnCapitalPct?: number;
}

export interface PlannerFields {
  kind?: "requested" | "alternative";
  /** For an alternative: each hard constraint it changes ("venue: Extended → Hyperliquid"). */
  changes?: string[];
  status?: "executable" | "blocked";
  blockers?: string[];
  economics?: Economics;
  figures?: Figure[];
  /** Two legs that must both fill for the position to be neutral. */
  pair?: { legs: [number, number]; sizing: "equal_base_quantity" };
}

export type PlannerStrategy = LLMStrategy & PlannerFields;

export interface ConformanceContext {
  /** The order the user typed, when there is one. */
  order: ExplicitPerpOrder | null;
  /** Perp venues the user named ("entre Extended et Hyperliquid"). */
  namedVenues: ("Hyperliquid" | "Extended")[];
  /** Extended account as the server knows it; undefined balance = unknown. */
  extended?: { connected: boolean; network?: string; availableUsd?: number };
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

/** Why the Extended legs can't run now, from the account state (empty = they can, or there are none). */
export function extendedBlockers(s: LLMStrategy, ext: ConformanceContext["extended"]): string[] {
  const legs = (s.legs ?? []).filter((l) => isPerp(l) && venueOf(l) === "Extended");
  if (legs.length === 0) return [];
  const needed = legs.reduce((a, l) => a + ((l.sizeUsd ?? 0) / Math.max(1, l.leverage ?? 1)) * (1 + SIZING_POLICY.marginBufferPct / 100), 0);
  if (!ext?.connected) return ["Extended account not connected (Tools → Extended, three wallet signatures), then a USDC deposit on extended.exchange."];
  if (ext.network && ext.network !== "mainnet") return [`Extended is connected on ${ext.network} only; real orders need the mainnet account.`];
  if (ext.availableUsd === undefined) return ["Extended balance unknown right now: it couldn't be read, so these legs aren't treated as executable."];
  if (ext.availableUsd < needed) {
    return [`Extended has $${Math.floor(ext.availableUsd)} free; these legs need ~$${Math.ceil(needed)} of margin. Deposit on extended.exchange.`];
  }
  return [];
}

const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** One formula for the return on committed capital; null inputs leave it undefined. */
export function recomputeEconomics(e: Partial<Economics> | undefined, defaultHoldingDays: number): Economics | undefined {
  if (!e) return undefined;
  const capital = finite(e.capitalCommittedUsd);
  if (!capital || capital <= 0) return undefined;
  const holdingDays = finite(e.holdingDays) && (e.holdingDays as number) > 0 ? (e.holdingDays as number) : defaultHoldingDays;
  const carry = finite(e.annualizedGrossCarryUsd);
  const cost = finite(e.entryExitCostUsd);
  const out: Economics = {
    capitalCommittedUsd: capital,
    notionalPerLegUsd: finite(e.notionalPerLegUsd),
    volumeUsd: finite(e.volumeUsd),
    annualizedGrossCarryUsd: carry,
    entryExitCostUsd: cost,
    holdingDays,
  };
  if (carry !== undefined) {
    const net = carry - (cost ?? 0) * (365 / holdingDays);
    out.annualizedReturnOnCapitalPct = Math.round((net / capital) * 10000) / 100;
  }
  return out;
}

const HOLDING: Record<Objective, number> = {
  explicit_order: SIZING_POLICY.defaultHoldingDays.directional,
  directional: SIZING_POLICY.defaultHoldingDays.directional,
  farming: SIZING_POLICY.defaultHoldingDays.farming,
  neutral_carry: SIZING_POLICY.defaultHoldingDays.carry,
  hedge: SIZING_POLICY.defaultHoldingDays.hedge,
  yield: SIZING_POLICY.defaultHoldingDays.yield,
  move: SIZING_POLICY.defaultHoldingDays.yield,
};

/** The two legs of a neutral position: a long exposure and a short on the same asset. */
function findPair(s: LLMStrategy): PlannerFields["pair"] {
  const legs = s.legs ?? [];
  const shortIdx = legs.findIndex((l) => l.side.toLowerCase() === "short");
  if (shortIdx < 0) return undefined;
  const base = marketBase(legs[shortIdx].asset);
  const longIdx = legs.findIndex(
    (l, i) => i !== shortIdx && /^(long|buy)$/i.test(l.side.trim()) && (marketBase(l.asset) === base || marketBase(l.asset) === `U${base}`),
  );
  return longIdx < 0 ? undefined : { legs: [longIdx, shortIdx] as [number, number], sizing: "equal_base_quantity" };
}

/** Order within the requested plans, by what the objective optimizes. */
function rankKey(objective: Objective | undefined, s: PlannerStrategy): number[] {
  const e = s.economics;
  if (objective === "farming") {
    const costPerVolume = e?.entryExitCostUsd !== undefined && e.volumeUsd ? e.entryExitCostUsd / e.volumeUsd : Infinity;
    return [costPerVolume, e?.capitalCommittedUsd ?? Infinity];
  }
  if (objective === "yield" || objective === "neutral_carry") return [-(e?.annualizedReturnOnCapitalPct ?? -Infinity)];
  return [];
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0 && Number.isFinite(d)) return d;
    if (a[i] !== b[i]) return a[i] === Infinity || b[i] === -Infinity ? 1 : -1;
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
 * executable ones ranked by the objective; alternatives follow, each naming
 * what it changes; at most three plans; the recommendation never falls on an
 * alternative.
 */
export function enforceConformance(raw: LLMStrategy[], objective: Objective | undefined, ctx: ConformanceContext): ConformanceResult {
  const notes: string[] = [];
  const out: PlannerStrategy[] = [];
  for (const s0 of raw as PlannerStrategy[]) {
    const s: PlannerStrategy = { ...s0 };
    const dev = deviations(s, ctx);
    const llmChanges = Array.isArray(s.changes) ? s.changes.filter((c) => typeof c === "string" && c.trim()) : [];
    if (dev.length > 0) {
      if (s.kind !== "alternative") notes.push(`"${s.name}" reclassified as an alternative: ${dev.join("; ")}`);
      s.kind = "alternative";
      s.changes = [...new Set([...dev, ...llmChanges])];
    } else {
      s.kind = s.kind === "alternative" && llmChanges.length > 0 ? "alternative" : "requested";
      s.changes = s.kind === "alternative" ? llmChanges : undefined;
    }
    if (s.kind === "alternative" && !s.changes?.length) {
      notes.push(`"${s.name}" dropped: an alternative that doesn't say what it changes`);
      continue;
    }
    const blockers = [...extendedBlockers(s, ctx.extended), ...(Array.isArray(s.blockers) ? s.blockers.filter((b) => typeof b === "string" && b.trim()) : [])];
    s.blockers = blockers.length ? [...new Set(blockers)] : undefined;
    s.status = s.blockers ? "blocked" : "executable";
    s.economics = recomputeEconomics(s.economics, HOLDING[objective ?? "yield"]);
    s.pair = findPair(s);
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
