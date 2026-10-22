/**
 * engine.ts — the decisions of Meridian's neutral bot, one tick at a time.
 *
 * The bot holds one delta-neutral pair (the same quantity long on one venue
 * and short on another) and works it in one of two modes:
 *   - farm: for points and airdrops. It keeps the open interest up and
 *     rotates the pair (close both legs, reopen) every `rotateMinutes`, which
 *     makes volume on both venues at a known fee cost; each reopening takes
 *     the orientation funding pays.
 *   - carry: for the funding spread. It opens when the spread clears
 *     `minSpreadAprPct`, holds, and closes when the spread falls under
 *     `exitSpreadAprPct` (or flips), then waits for the next opening.
 * It only ever touches the pair it opened: a position on the asset it finds
 * while holding none is the user's, and stops it. Whatever the mode, a pair
 * found unbalanced is fixed before anything else:
 * a lone leg is closed (the next tick reopens both), a leg larger than the
 * other is trimmed to it. Budgets (cycles, fees, volume) stop the bot once
 * reached, after closing the pair.
 *
 * Pure: the runner (components/NeutralBotPanel.tsx) reads the positions and
 * funding, asks `decide`, sends the orders and folds the fills back in with
 * `recordFills`. Unit-tested.
 */

import type { PerpVenueName } from "@/lib/planner/markets";

export type BotMode = "farm" | "carry";

export interface BotConfig {
  base: string;
  /** The two venues the pair spans; which one holds the long is decided by funding at each opening. */
  venues: [PerpVenueName, PerpVenueName];
  /** Notional of each leg at opening, USD. */
  notionalUsd: number;
  leverage: number;
  mode: BotMode;
  /** farm: minutes between two rotations. */
  rotateMinutes: number;
  /** carry: open only above this funding spread (%/yr). */
  minSpreadAprPct: number;
  /** carry: close under this spread (%/yr). */
  exitSpreadAprPct: number;
  /** Stop after this many completed rotations (farm) or round trips (carry). */
  maxCycles: number;
  /** Stop once the fees paid reach this, USD. */
  maxFeesUsd: number;
  /** Stop once this much volume is made, USD (0: no target). */
  volumeTargetUsd: number;
}

/** What the runner reads before each decision. */
export interface BotObservation {
  now: number;
  /** Signed size of the base on each venue (> 0 long, < 0 short), in base units. */
  sizes: Record<string, number>;
  /** Funding per hour on each venue's market (positive: longs pay shorts); missing when unread. */
  fundingHourly: Partial<Record<PerpVenueName, number>>;
  /** Mark price, for tolerances in USD. */
  markUsd: number;
}

export interface BotStats {
  cycles: number;
  volumeUsd: number;
  feesUsd: number;
  /** When the pair held now was opened (ms), or null when flat. */
  openedAt: number | null;
  /** Orientation of the pair held now. */
  longVenue: PerpVenueName | null;
  /** Set once the bot stopped on its own (budget reached, or a failure it can't fix). */
  stopReason: string | null;
}

export const EMPTY_STATS: BotStats = { cycles: 0, volumeUsd: 0, feesUsd: 0, openedAt: null, longVenue: null, stopReason: null };

export type BotAction =
  | { kind: "open"; longVenue: PerpVenueName; shortVenue: PerpVenueName; spreadAprPct: number | null }
  | { kind: "close"; reason: string; thenStop?: string }
  | { kind: "rotate"; reason: string }
  | { kind: "reduce"; venue: PerpVenueName; isBuy: boolean; qty: number; reason: string }
  | { kind: "wait"; reason: string }
  | { kind: "stop"; reason: string };

/** Two legs within this share of each other (or within the dust value) count as the same size. */
export const SIZE_TOLERANCE = 0.02;
/** A position worth less than this is dust: treated as flat. */
export const DUST_USD = 1;

const HOURS_PER_YEAR = 8760;

/** The funding spread a year (%) earned by a pair long on `longVenue`, short on the other; null when either rate is unread. */
export function spreadAprPct(obs: Pick<BotObservation, "fundingHourly">, longVenue: PerpVenueName, shortVenue: PerpVenueName): number | null {
  const l = obs.fundingHourly[longVenue];
  const s = obs.fundingHourly[shortVenue];
  return l === undefined || s === undefined ? null : (s - l) * HOURS_PER_YEAR * 100;
}

/** The orientation funding pays: long where it is lowest. */
export function bestOrientation(cfg: Pick<BotConfig, "venues">, obs: Pick<BotObservation, "fundingHourly">): { longVenue: PerpVenueName; shortVenue: PerpVenueName; spreadAprPct: number | null } {
  const [a, b] = cfg.venues;
  const ab = spreadAprPct(obs, a, b);
  const ba = spreadAprPct(obs, b, a);
  if (ab === null || ba === null) return { longVenue: a, shortVenue: b, spreadAprPct: ab };
  return ab >= ba ? { longVenue: a, shortVenue: b, spreadAprPct: ab } : { longVenue: b, shortVenue: a, spreadAprPct: ba };
}

/** The budget the bot has used up, if any. */
export function budgetReached(cfg: BotConfig, stats: BotStats): string | null {
  if (cfg.maxCycles > 0 && stats.cycles >= cfg.maxCycles) return `${stats.cycles} cycles done (limit ${cfg.maxCycles})`;
  if (cfg.maxFeesUsd > 0 && stats.feesUsd >= cfg.maxFeesUsd) return `fee budget used ($${stats.feesUsd.toFixed(2)} of $${cfg.maxFeesUsd})`;
  if (cfg.volumeTargetUsd > 0 && stats.volumeUsd >= cfg.volumeTargetUsd) return `volume target reached ($${Math.round(stats.volumeUsd).toLocaleString("en-US")})`;
  return null;
}

/** The next thing the bot does. */
export function decide(cfg: BotConfig, stats: BotStats, obs: BotObservation): BotAction {
  if (stats.stopReason) return { kind: "wait", reason: `stopped: ${stats.stopReason}` };
  const [a, b] = cfg.venues;
  const sa = obs.sizes[a] ?? 0;
  const sb = obs.sizes[b] ?? 0;
  const dust = DUST_USD / Math.max(obs.markUsd, 1e-9);
  const flatA = Math.abs(sa) <= dust;
  const flatB = Math.abs(sb) <= dust;
  const budget = budgetReached(cfg, stats);

  // Flat: open (or stop on a spent budget).
  if (flatA && flatB) {
    if (budget) return { kind: "stop", reason: budget };
    const o = bestOrientation(cfg, obs);
    if (cfg.mode === "carry") {
      if (o.spreadAprPct === null) return { kind: "wait", reason: "funding unread on one venue" };
      if (o.spreadAprPct < cfg.minSpreadAprPct) return { kind: "wait", reason: `spread ${o.spreadAprPct.toFixed(1)}%/yr under the ${cfg.minSpreadAprPct}%/yr to open` };
    }
    return { kind: "open", ...o };
  }

  // Positions the bot didn't open (it holds no pair): the user's own trades. Never touch them.
  if (stats.openedAt === null) {
    const where = [!flatA ? a : null, !flatB ? b : null].filter(Boolean).join(" and ");
    return { kind: "stop", reason: `a ${cfg.base} position the bot didn't open is on ${where}: close it or pick another asset` };
  }

  // One leg alone: it carries the price risk the pair was meant to remove. Close it; the next tick reopens both.
  if (flatA !== flatB) {
    const [venue, size] = flatA ? [b, sb] : [a, sa];
    return { kind: "reduce", venue, isBuy: size < 0, qty: Math.abs(size), reason: `only the ${venue} leg is open: closing it before reopening the pair` };
  }

  // Both open on the same side: not a pair (opened by hand?). Never touch what the bot didn't build.
  if (Math.sign(sa) === Math.sign(sb)) return { kind: "stop", reason: `both ${cfg.base} positions are ${sa > 0 ? "long" : "short"}: not a neutral pair, left as is` };

  // Unequal legs: trim the larger to the smaller.
  const qa = Math.abs(sa);
  const qb = Math.abs(sb);
  const excess = Math.abs(qa - qb);
  if (excess > Math.max(Math.min(qa, qb) * SIZE_TOLERANCE, dust)) {
    const [venue, size] = qa > qb ? [a, sa] : [b, sb];
    return { kind: "reduce", venue, isBuy: size < 0, qty: Math.round(excess * 1e10) / 1e10, reason: `legs differ by ${excess.toPrecision(3)} ${cfg.base}: trimming ${venue} to match` };
  }

  // A balanced pair: hold, rotate, or close.
  const longVenue = sa > 0 ? a : b;
  const shortVenue = longVenue === a ? b : a;
  if (budget) return { kind: "close", reason: budget, thenStop: budget };
  const held = spreadAprPct(obs, longVenue, shortVenue);
  if (cfg.mode === "carry") {
    if (held !== null && held < cfg.exitSpreadAprPct) return { kind: "close", reason: `spread down to ${held.toFixed(1)}%/yr (exit under ${cfg.exitSpreadAprPct}%/yr)` };
    return { kind: "wait", reason: held === null ? "holding (funding unread)" : `holding at ${held.toFixed(1)}%/yr` };
  }
  const openedAt = stats.openedAt ?? obs.now;
  const ageMin = (obs.now - openedAt) / 60_000;
  if (ageMin >= cfg.rotateMinutes) return { kind: "rotate", reason: `${Math.floor(ageMin)} min open: rotating for volume` };
  // Funding turned against the held orientation by more than the round trip is worth: rotate early, into the paying side.
  const best = bestOrientation(cfg, obs);
  if (held !== null && best.spreadAprPct !== null && best.longVenue !== longVenue && held < -cfg.minSpreadAprPct) {
    return { kind: "rotate", reason: `funding flipped (${held.toFixed(1)}%/yr held): rotating into the paying side` };
  }
  return { kind: "wait", reason: `holding, next rotation in ${Math.max(0, Math.ceil(cfg.rotateMinutes - ageMin))} min` };
}

export interface Fill {
  qty: number;
  px: number;
  takerFee: number;
}

/** Fold fills into the stats: volume, fees, and the pair's state after the action. */
export function recordFills(stats: BotStats, action: BotAction, fills: Fill[], now: number, opened?: { longVenue: PerpVenueName }): BotStats {
  const volume = fills.reduce((s, f) => s + f.qty * f.px, 0);
  const fees = fills.reduce((s, f) => s + f.qty * f.px * f.takerFee, 0);
  const next: BotStats = { ...stats, volumeUsd: stats.volumeUsd + volume, feesUsd: stats.feesUsd + fees };
  if (action.kind === "open" && opened) return { ...next, openedAt: now, longVenue: opened.longVenue };
  if (action.kind === "rotate" && opened) return { ...next, cycles: stats.cycles + 1, openedAt: now, longVenue: opened.longVenue };
  if (action.kind === "close") return { ...next, cycles: stats.cycles + 1, openedAt: null, longVenue: null, stopReason: action.thenStop ?? stats.stopReason };
  if (action.kind === "rotate") return { ...next, cycles: stats.cycles + 1, openedAt: null, longVenue: null };
  return next;
}

export const DEFAULT_BOT_CONFIG: Omit<BotConfig, "base" | "venues" | "notionalUsd"> = {
  leverage: 3,
  mode: "farm",
  rotateMinutes: 60,
  minSpreadAprPct: 10,
  exitSpreadAprPct: 2,
  maxCycles: 24,
  maxFeesUsd: 5,
  volumeTargetUsd: 0,
};

/** The fees one rotation costs (both legs closed and reopened at taker), for the config preview. */
export function rotationFeeUsd(cfg: Pick<BotConfig, "notionalUsd">, takerFees: [number, number]): number {
  return 2 * cfg.notionalUsd * (takerFees[0] + takerFees[1]);
}
