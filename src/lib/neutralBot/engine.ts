/**
 * engine.ts — the decisions of Meridian's neutral bot, one tick at a time.
 *
 * The bot holds one delta-neutral pair (the same quantity long on one venue
 * and short on another) and works it in one of two modes:
 *   - farm: for points and airdrops. It keeps the open interest up and
 *     cycles the pair on a randomized schedule: each pair is held for a time
 *     drawn between `holdMinMinutes` and `holdMaxMinutes`, then closed; the
 *     next opens after a pause drawn between `gapMinMinutes` and
 *     `gapMaxMinutes` (no pause: it rotates straight away), at a size varied
 *     by up to `sizeJitterPct`. Every opening takes the orientation funding
 *     pays. Random times and sizes keep the activity from looking scripted.
 *   - carry: for the funding spread. It opens when the spread clears
 *     `minSpreadAprPct`, holds, and closes when the spread falls under
 *     `exitSpreadAprPct` (or flips), then waits for the next opening.
 * It only ever touches the pair it opened: a position on the asset it finds
 * while holding none is the user's, and stops it. Whatever the mode, a pair
 * found unbalanced is fixed before anything else: a lone leg is closed (the
 * next tick reopens both), a leg larger than the other is trimmed to it.
 * Budgets (cycles, fees, volume) stop the bot once reached, after closing
 * the pair.
 *
 * Pure: the schedule's random draws come in as an argument (`planNext`), and
 * the runner (lib/neutralBot/runner.ts) reads the venues, asks `decide`,
 * sends the orders and folds the fills back in with `recordFills`.
 * Unit-tested.
 */

import type { PerpVenueName } from "@/lib/planner/markets";

export type BotMode = "farm" | "carry";

export interface BotConfig {
  base: string;
  /** The two venues the pair spans; which one holds the long is decided by funding at each opening. */
  venues: [PerpVenueName, PerpVenueName];
  /** Notional of each leg at opening, USD (varied by `sizeJitterPct` at each opening in farm mode). */
  notionalUsd: number;
  leverage: number;
  mode: BotMode;
  /** farm: each pair is held for a random time in this range, minutes. */
  holdMinMinutes: number;
  holdMaxMinutes: number;
  /** farm: pause between closing one pair and opening the next, random in this range, minutes (0 and 0: rotate at once). */
  gapMinMinutes: number;
  gapMaxMinutes: number;
  /** farm: each opening's size is the base size ± up to this share (%), never under the markets' minimum. */
  sizeJitterPct: number;
  /** carry: open only above this funding spread (%/yr). */
  minSpreadAprPct: number;
  /** carry: close under this spread (%/yr). */
  exitSpreadAprPct: number;
  /** Stop after this many completed cycles (a pair opened and closed). */
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

/** One leg of the pair the bot holds, as it filled. */
export interface HeldLeg {
  venue: PerpVenueName;
  side: "long" | "short";
  qty: number;
  entryPx: number;
}

export interface BotStats {
  cycles: number;
  volumeUsd: number;
  feesUsd: number;
  /** Funding the held pairs earned (+) or paid (−), estimated from the spread while held, USD. */
  fundingUsd: number;
  /** When the pair held now was opened (ms), or null when flat. */
  openedAt: number | null;
  /** Orientation of the pair held now. */
  longVenue: PerpVenueName | null;
  /** The legs held now, from their fills (entry price for the open PnL). */
  legs: HeldLeg[];
  /** farm: when the held pair is due to close (ms). */
  closeAt: number | null;
  /** farm: no new pair before this time (ms), after a scheduled close. */
  reopenAt: number | null;
  /** Cumulative volume and fees after each trade, for the chart (capped). */
  history: { t: number; volumeUsd: number; feesUsd: number }[];
  /** When the bot was first started on these totals. */
  startedAt: number | null;
  /** The last tick that read the venues (ms): funding accrues from it. */
  lastTickAt: number | null;
  /** Set once the bot stopped on its own (budget reached, or a failure it can't fix). */
  stopReason: string | null;
}

export const EMPTY_STATS: BotStats = {
  cycles: 0,
  volumeUsd: 0,
  feesUsd: 0,
  fundingUsd: 0,
  openedAt: null,
  longVenue: null,
  legs: [],
  closeAt: null,
  reopenAt: null,
  history: [],
  startedAt: null,
  lastTickAt: null,
  stopReason: null,
};

export type BotAction =
  | { kind: "open"; longVenue: PerpVenueName; shortVenue: PerpVenueName; spreadAprPct: number | null }
  | { kind: "close"; reason: string; thenStop?: string; scheduled?: boolean }
  | { kind: "rotate"; reason: string }
  | { kind: "reduce"; venue: PerpVenueName; isBuy: boolean; qty: number; reason: string }
  | { kind: "wait"; reason: string }
  | { kind: "stop"; reason: string };

/** Two legs within this share of each other (or within the dust value) count as the same size. */
export const SIZE_TOLERANCE = 0.02;
/** A position worth less than this is dust: treated as flat. */
export const DUST_USD = 1;
/** Points kept for the chart. */
export const HISTORY_POINTS = 500;

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

const clock = (t: number) => new Date(t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
const minutesUntil = (t: number, now: number) => Math.max(0, Math.ceil((t - now) / 60_000));

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

  // Flat: open (or stop on a spent budget, or wait for the scheduled time).
  if (flatA && flatB) {
    if (budget) return { kind: "stop", reason: budget };
    if (cfg.mode === "farm" && stats.reopenAt && obs.now < stats.reopenAt) {
      return { kind: "wait", reason: `next pair opens at ${clock(stats.reopenAt)} (in ${minutesUntil(stats.reopenAt, obs.now)} min)` };
    }
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

  // Both open on the same side: not a pair. Never touch what the bot didn't build.
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
  const closeAt = stats.closeAt ?? (stats.openedAt + cfg.holdMaxMinutes * 60_000);
  const pause = cfg.gapMaxMinutes > 0;
  if (obs.now >= closeAt) {
    const reason = `held ${Math.floor((obs.now - stats.openedAt) / 60_000)} min`;
    return pause ? { kind: "close", reason, scheduled: true } : { kind: "rotate", reason };
  }
  // Funding turned against the held orientation by more than the round trip is worth: rotate early, into the paying side.
  const best = bestOrientation(cfg, obs);
  if (held !== null && best.spreadAprPct !== null && best.longVenue !== longVenue && held < -cfg.minSpreadAprPct) {
    return { kind: "rotate", reason: `funding flipped (${held.toFixed(1)}%/yr held): rotating into the paying side` };
  }
  return { kind: "wait", reason: `holding, ${pause ? "closes" : "rotates"} at ${clock(closeAt)} (in ${minutesUntil(closeAt, obs.now)} min)` };
}

/** A number drawn uniformly in [min, max] from `rand` ∈ [0, 1). */
const between = (min: number, max: number, rand: number) => min + Math.max(0, max - min) * rand;

/** The schedule after a pair opens or closes, in farm mode: when to close it (random hold), when the next may open (random pause). */
export function planNext(cfg: BotConfig, now: number, rand: () => number = Math.random): { closeAt: number; reopenAt: number } {
  return {
    closeAt: now + between(cfg.holdMinMinutes, cfg.holdMaxMinutes, rand()) * 60_000,
    reopenAt: now + between(cfg.gapMinMinutes, cfg.gapMaxMinutes, rand()) * 60_000,
  };
}

/** The size of the next opening: base ± jitter in farm mode, never under `minNotionalUsd`. */
export function openingSize(cfg: BotConfig, minNotionalUsd: number, rand: () => number = Math.random): number {
  const jitter = cfg.mode === "farm" ? Math.min(50, Math.max(0, cfg.sizeJitterPct)) / 100 : 0;
  const size = cfg.notionalUsd * (1 + (rand() * 2 - 1) * jitter);
  return Math.floor(Math.max(size, minNotionalUsd) * 100) / 100;
}

export interface Fill {
  venue: PerpVenueName;
  isBuy: boolean;
  qty: number;
  px: number;
  takerFee: number;
}

/** Fold fills into the stats: volume, fees, the pair's state and schedule after the action. */
export function recordFills(
  stats: BotStats,
  action: BotAction,
  fills: Fill[],
  now: number,
  opened?: { longVenue: PerpVenueName; legs: HeldLeg[]; closeAt: number | null },
  reopenAt?: number | null,
): BotStats {
  const volume = fills.reduce((s, f) => s + f.qty * f.px, 0);
  const fees = fills.reduce((s, f) => s + f.qty * f.px * f.takerFee, 0);
  const totals = { volumeUsd: stats.volumeUsd + volume, feesUsd: stats.feesUsd + fees };
  const history = fills.length ? [...stats.history, { t: now, ...totals }].slice(-HISTORY_POINTS) : stats.history;
  const next: BotStats = { ...stats, ...totals, history };
  const flat = { openedAt: null, longVenue: null, legs: [], closeAt: null };
  if (action.kind === "open" && opened) return { ...next, openedAt: now, longVenue: opened.longVenue, legs: opened.legs, closeAt: opened.closeAt, reopenAt: null };
  if (action.kind === "rotate" && opened) return { ...next, cycles: stats.cycles + 1, openedAt: now, longVenue: opened.longVenue, legs: opened.legs, closeAt: opened.closeAt, reopenAt: null };
  if (action.kind === "close") return { ...next, ...flat, cycles: stats.cycles + 1, reopenAt: reopenAt ?? null, stopReason: action.thenStop ?? stats.stopReason };
  if (action.kind === "rotate") return { ...next, ...flat, cycles: stats.cycles + 1 };
  if (action.kind === "reduce") return { ...next, legs: stats.legs.map((l) => (l.venue === action.venue ? { ...l, qty: Math.max(0, l.qty - fills.reduce((s, f) => s + f.qty, 0)) } : l)).filter((l) => l.qty > 0) };
  return next;
}

/** Funding a held pair earns between two ticks, from the spread at the earlier one (estimate). */
export function accrueFunding(stats: BotStats, spreadPct: number | null, notionalUsd: number, fromMs: number, toMs: number): BotStats {
  if (stats.openedAt === null || spreadPct === null || !(toMs > fromMs)) return stats;
  const hours = (toMs - Math.max(fromMs, stats.openedAt)) / 3_600_000;
  if (!(hours > 0)) return stats;
  return { ...stats, fundingUsd: stats.fundingUsd + (notionalUsd * spreadPct) / 100 / HOURS_PER_YEAR * hours };
}

/** Open PnL of the held legs at `mark` (each venue's own mark), USD: what the hedge nets after price moves. */
export function openPnlUsd(legs: HeldLeg[], marks: Partial<Record<PerpVenueName, number>>): number | null {
  if (legs.length === 0) return null;
  let pnl = 0;
  for (const l of legs) {
    const m = marks[l.venue];
    if (!m) return null;
    pnl += (l.side === "long" ? m - l.entryPx : l.entryPx - m) * l.qty;
  }
  return pnl;
}

export const DEFAULT_BOT_CONFIG: Omit<BotConfig, "base" | "venues" | "notionalUsd"> = {
  leverage: 3,
  mode: "farm",
  holdMinMinutes: 45,
  holdMaxMinutes: 120,
  gapMinMinutes: 2,
  gapMaxMinutes: 20,
  sizeJitterPct: 15,
  minSpreadAprPct: 10,
  exitSpreadAprPct: 2,
  maxCycles: 24,
  maxFeesUsd: 5,
  volumeTargetUsd: 0,
};

/** A config saved before random schedules (one `rotateMinutes`) or missing newer fields, made whole. */
export function migrateConfig(saved: Partial<BotConfig> & { rotateMinutes?: number }, fallback: BotConfig): BotConfig {
  const legacy = saved.rotateMinutes;
  const cfg = { ...fallback, ...saved } as BotConfig & { rotateMinutes?: number };
  if (legacy && saved.holdMinMinutes === undefined) {
    cfg.holdMinMinutes = legacy;
    cfg.holdMaxMinutes = legacy;
    cfg.gapMinMinutes = 0;
    cfg.gapMaxMinutes = 0;
  }
  delete cfg.rotateMinutes;
  return cfg;
}

/** The fees one cycle costs (both legs opened and closed at taker), for the config preview. */
export function rotationFeeUsd(cfg: Pick<BotConfig, "notionalUsd">, takerFees: [number, number]): number {
  return 2 * cfg.notionalUsd * (takerFees[0] + takerFees[1]);
}
