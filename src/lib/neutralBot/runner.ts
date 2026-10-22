/**
 * runner.ts — one tick of the neutral bot: read the market and both legs,
 * decide (engine.ts), send the orders, account for the fills.
 *
 * The venues come in as a `BotVenues` interface (the browser wires
 * hooks/usePerpTrader.ts), so the whole loop is unit-tested with fakes.
 * Openings go through runPerpPair (lib/perpPair.ts): the thinner book first,
 * the second leg at the quantity the first filled, and an immediate unwind
 * when the second fails. A leg left open that the unwind couldn't close stops
 * the bot: it never keeps trading around an exposed position.
 */

import type { MarketQuote, MarketSnapshot, PerpVenueName } from "@/lib/planner/markets";
import type { PairFill } from "@/lib/perpPair";
import { runPerpPair } from "@/lib/perpPair";
import { marginNeededUsd } from "@/lib/integrations/hyperliquidTrade";
import { bestOrientation, decide, recordFills, type BotAction, type BotConfig, type BotStats, type Fill } from "@/lib/neutralBot/engine";

export interface BotVenues {
  order: (venue: PerpVenueName, o: { market: string; isBuy: boolean; sizeUsd?: number; qty?: number; leverage: number; reduceOnly: boolean }) => Promise<PairFill>;
  position: (venue: PerpVenueName, market: string) => Promise<number>;
  freeMargin: (venue: PerpVenueName, market: string) => Promise<number>;
}

export interface TickResult {
  stats: BotStats;
  action: BotAction;
  /** What happened, for the bot's log (one line). */
  message: string;
  /** The tick failed before or while trading (counted by the panel; three in a row stop the bot). */
  error?: string;
}

/** The deepest perp market on `venue` for `base`. */
export function marketOn(snapshot: Pick<MarketSnapshot, "quotes">, venue: PerpVenueName, base: string): MarketQuote | undefined {
  return snapshot.quotes
    .filter((q) => q.kind === "perp" && q.venue === venue && q.base.toUpperCase() === base.toUpperCase())
    .sort((a, b) => b.dayVolumeUsd - a.dayVolumeUsd)[0];
}

const fmt = (n: number) => `$${n.toFixed(2)}`;

export async function runTick(cfg: BotConfig, stats: BotStats, snapshot: Pick<MarketSnapshot, "quotes">, venues: BotVenues, now: number): Promise<TickResult> {
  const [a, b] = cfg.venues;
  const qa = marketOn(snapshot, a, cfg.base);
  const qb = marketOn(snapshot, b, cfg.base);
  if (!qa || !qb) {
    const missing = !qa ? a : b;
    return { stats, action: { kind: "wait", reason: "market missing" }, message: `No ${cfg.base} market on ${missing} right now: waiting.`, error: `${cfg.base} not listed on ${missing}` };
  }
  const quote = (v: PerpVenueName) => (v === a ? qa : qb);
  const [sa, sb] = await Promise.all([venues.position(a, qa.market), venues.position(b, qb.market)]);
  const obs = { now, sizes: { [a]: sa, [b]: sb }, fundingHourly: { [a]: qa.fundingHourly, [b]: qb.fundingHourly }, markUsd: (qa.markUsd + qb.markUsd) / 2 };
  const action = decide(cfg, stats, obs);

  const fills: Fill[] = [];
  const send = async (venue: PerpVenueName, o: { isBuy: boolean; sizeUsd?: number; qty?: number; reduceOnly: boolean }): Promise<PairFill> => {
    const out = await venues.order(venue, { market: quote(venue).market, leverage: cfg.leverage, ...o });
    if (out.ok && out.filledQty && out.filledQty > 0) fills.push({ qty: out.filledQty, px: out.avgPx ?? quote(venue).markUsd, takerFee: quote(venue).takerFee });
    return out;
  };

  // Close both legs at their exact sizes (reduce-only): true when both are flat after.
  const closeBoth = async (): Promise<{ ok: boolean; error?: string }> => {
    const outs = await Promise.all(
      ([[a, sa], [b, sb]] as const).filter(([, s]) => s !== 0).map(([v, s]) => send(v, { isBuy: s < 0, qty: Math.abs(s), reduceOnly: true })),
    );
    const failed = outs.find((o) => !o.ok);
    return failed ? { ok: false, error: failed.error } : { ok: true };
  };

  // Open the pair long on `longVenue`: the thinner book first, the other at the quantity it filled.
  const openPair = async (longVenue: PerpVenueName, shortVenue: PerpVenueName): Promise<{ opened: boolean; message: string; exposed?: boolean }> => {
    const need = marginNeededUsd(cfg.notionalUsd, cfg.leverage);
    const [fl, fs] = await Promise.all([venues.freeMargin(longVenue, quote(longVenue).market), venues.freeMargin(shortVenue, quote(shortVenue).market)]);
    const short = [fl < need ? `${longVenue} has ${fmt(fl)} free` : null, fs < need ? `${shortVenue} has ${fmt(fs)} free` : null].filter(Boolean);
    if (short.length) return { opened: false, message: `Not enough margin: each leg needs ~${fmt(need)} (${short.join(", ")}).`, exposed: false };
    const legs: PerpVenueName[] = [longVenue, shortVenue];
    const first = quote(longVenue).dayVolumeUsd <= quote(shortVenue).dayVolumeUsd ? 0 : 1;
    const run = await runPerpPair([first, 1 - first], {
      open: (i, qty) => send(legs[i], { isBuy: i === 0, sizeUsd: cfg.notionalUsd, qty, reduceOnly: false }),
      close: (i, qty) => send(legs[i], { isBuy: i !== 0, qty, reduceOnly: true }),
    });
    if (run.status === "neutral") return { opened: true, message: `Opened ${run.first.qty} ${cfg.base}: long ${longVenue}, short ${shortVenue}.` };
    if (run.status === "first_failed") return { opened: false, message: `Opening failed, nothing traded: ${run.error}` };
    if (run.status === "unwound") return { opened: false, message: `Second leg failed (${run.error}); the first was closed.` };
    return { opened: false, exposed: true, message: `Exposed: ${run.qty} ${cfg.base} left open on ${legs[run.legIndex]} (${run.error}; close failed: ${run.unwindError}).` };
  };

  try {
    switch (action.kind) {
      case "wait":
        return { stats, action, message: action.reason };
      case "stop":
        return { stats: { ...stats, stopReason: action.reason }, action, message: `Stopped: ${action.reason}.` };
      case "reduce": {
        const out = await send(action.venue, { isBuy: action.isBuy, qty: action.qty, reduceOnly: true });
        const next = recordFills(stats, action, fills, now);
        return out.ok ? { stats: next, action, message: action.reason } : { stats: next, action, message: `${action.reason}: failed (${out.error})`, error: out.error };
      }
      case "close": {
        const out = await closeBoth();
        if (!out.ok) return { stats: recordFills(stats, { kind: "wait", reason: "" }, fills, now), action, message: `Closing failed: ${out.error}`, error: out.error };
        return { stats: recordFills(stats, action, fills, now), action, message: `Closed the pair: ${action.reason}.` };
      }
      case "open": {
        const r = await openPair(action.longVenue, action.shortVenue);
        const next = recordFills(stats, action, fills, now, r.opened ? { longVenue: action.longVenue } : undefined);
        // The exposed leg is the bot's own: "Stop & close" closes it.
        if (r.exposed) return { stats: { ...next, openedAt: next.openedAt ?? now, stopReason: "a leg is exposed" }, action, message: r.message, error: r.message };
        return { stats: next, action, message: r.message, error: r.opened ? undefined : r.message };
      }
      case "rotate": {
        const out = await closeBoth();
        if (!out.ok) return { stats: recordFills(stats, { kind: "wait", reason: "" }, fills, now), action, message: `Rotation: closing failed (${out.error})`, error: out.error };
        const o = bestOrientation(cfg, obs);
        const r = await openPair(o.longVenue, o.shortVenue);
        const next = recordFills(stats, action, fills, now, r.opened ? { longVenue: o.longVenue } : undefined);
        // The exposed leg is the bot's own: "Stop & close" closes it.
        if (r.exposed) return { stats: { ...next, openedAt: next.openedAt ?? now, stopReason: "a leg is exposed" }, action, message: r.message, error: r.message };
        return { stats: next, action, message: r.opened ? `Rotated (${action.reason}). ${r.message}` : `Rotated out; reopening failed: ${r.message}`, error: r.opened ? undefined : r.message };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return { stats: recordFills(stats, { kind: "wait", reason: "" }, fills, now), action, message: `Error: ${msg}`, error: msg };
  }
}
