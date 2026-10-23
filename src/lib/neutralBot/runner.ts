/**
 * runner.ts — one tick of the neutral bot: read the market and both legs,
 * decide (engine.ts), send the orders, account for the fills, and report
 * what the dashboard shows (legs, marks, spread, what it waits for).
 *
 * The venues come in as a `BotVenues` interface (the browser wires
 * hooks/usePerpTrader.ts), and the schedule's random draws as `rand`, so the
 * whole loop is unit-tested with fakes. Openings go through runPerpPair
 * (lib/perpPair.ts): the thinner book first, the second leg at the quantity
 * the first filled, and an immediate unwind when the second fails. A leg left
 * open that the unwind couldn't close stops the bot: it never keeps trading
 * around an exposed position. Missing margin is a wait, not a failure: the
 * bot opens as soon as the deposit lands.
 */

import type { MarketQuote, MarketSnapshot, PerpVenueName } from "@/lib/planner/markets";
import type { PairFill } from "@/lib/perpPair";
import { runPerpPair } from "@/lib/perpPair";
import { marginNeededUsd } from "@/lib/integrations/hyperliquidTrade";
import { maxPerSideUsd } from "@/lib/neutralBot/guide";
import { runMakerLeg } from "@/lib/neutralBot/maker";
import { MAKER_FEE } from "@/lib/perpVenues";
import {
  accrueFunding,
  bestOrientation,
  decide,
  openingSize,
  planNext,
  recordFills,
  spreadAprPct,
  venueStopPct,
  makerVenueOf,
  DUST_USD,
  type BotAction,
  type BotConfig,
  type BotStats,
  type Fill,
  type HeldLeg,
} from "@/lib/neutralBot/engine";

export interface BotVenues {
  /** `stopLossPct`: a reduce-only stop on the venue, that far from the fill, where the venue supports one (Hyperliquid, TxFlow). */
  order: (venue: PerpVenueName, o: { market: string; isBuy: boolean; sizeUsd?: number; qty?: number; leverage: number; reduceOnly: boolean; stopLossPct?: number }) => Promise<PairFill>;
  position: (venue: PerpVenueName, market: string) => Promise<number>;
  freeMargin: (venue: PerpVenueName, market: string) => Promise<number>;
  /** Post-only orders on Hyperliquid, for maker mode (absent: the bot trades at taker). */
  maker?: {
    book: (market: string) => Promise<{ bid: number; ask: number } | null>;
    post: (market: string, o: { isBuy: boolean; qty: number; px: number; reduceOnly: boolean; leverage: number }) => Promise<{ ok: boolean; oid?: number; error?: string }>;
    cancel: (market: string, oid: number) => Promise<void>;
    /** A venue stop-loss on the maker leg once it is open. */
    protect: (market: string, o: { isLong: boolean; qty: number; entry: number; stopLossPct: number }) => Promise<void>;
  };
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

/** maker: how often the post-only order's fills are read, and how far the book may move before it is re-posted. */
export const MAKER_POLL_MS = 2000;
export const MAKER_REPOST_BPS = 3;

/** What the dashboard shows after a tick. */
export interface BotView {
  at: number;
  /** Signed size per venue after the tick's orders (as read before them, adjusted by the fills). */
  sizes: Partial<Record<PerpVenueName, number>>;
  marks: Partial<Record<PerpVenueName, number>>;
  markets: Partial<Record<PerpVenueName, string>>;
  fundingHourly: Partial<Record<PerpVenueName, number>>;
  /** Spread a year the best orientation earns now (%). */
  bestSpreadAprPct: number | null;
  /** Spread a year the held pair earns now (%), when one is held. */
  heldSpreadAprPct: number | null;
  /** The larger of the two markets' minimum order, USD. */
  minNotionalUsd: number;
  takerFees: [number, number];
}

export interface TickResult {
  stats: BotStats;
  action: BotAction;
  /** What happened, for the bot's log (one line). */
  message: string;
  view?: BotView;
  /** Waiting on the user: margin to deposit on a venue (not a failure; the bot opens once it lands). */
  needsMargin?: { venue: PerpVenueName; freeUsd: number; neededUsd: number }[];
  /** The tick failed before or while trading (counted by the host; three in a row pause the bot). */
  error?: string;
}

/** The deepest perp market on `venue` for `base`. */
export function marketOn(snapshot: Pick<MarketSnapshot, "quotes">, venue: PerpVenueName, base: string): MarketQuote | undefined {
  return snapshot.quotes
    .filter((q) => q.kind === "perp" && q.venue === venue && q.base.toUpperCase() === base.toUpperCase())
    .sort((a, b) => b.dayVolumeUsd - a.dayVolumeUsd)[0];
}

const fmt = (n: number) => `$${n.toFixed(2)}`;

/**
 * "Stop & close": close whatever is left of the bot's pair, both legs at their exact sizes, whatever their
 * state (one leg alone, unequal legs, a pair held). Positions the bot didn't open are never touched.
 */
function closeAllAction(cfg: BotConfig, stats: BotStats, obs: { sizes: Partial<Record<PerpVenueName, number>>; markUsd: number }): BotAction {
  const dust = DUST_USD / Math.max(obs.markUsd, 1e-9);
  const open = cfg.venues.filter((v) => Math.abs(obs.sizes[v] ?? 0) > dust);
  if (open.length === 0) return { kind: "stop", reason: "no pair open, nothing to close" };
  if (stats.openedAt === null) return { kind: "stop", reason: `the ${cfg.base} position on ${open.join(" and ")} wasn't opened by the bot: left as is` };
  return { kind: "close", reason: "stopped by you" };
}

/** Close the bot's pair now (see closeAllAction), at market. */
export const closeBotPair = (cfg: BotConfig, stats: BotStats, snapshot: Pick<MarketSnapshot, "quotes">, venues: BotVenues, now: number) =>
  runTick(cfg, { ...stats, stopReason: null }, snapshot, venues, now, Math.random, { closeAll: true });

export async function runTick(
  cfg: BotConfig,
  stats0: BotStats,
  snapshot: Pick<MarketSnapshot, "quotes">,
  venues: BotVenues,
  now: number,
  rand: () => number = Math.random,
  opts: { closeAll?: boolean } = {},
): Promise<TickResult> {
  const [a, b] = cfg.venues;
  const qa = marketOn(snapshot, a, cfg.base);
  const qb = marketOn(snapshot, b, cfg.base);
  if (!qa || !qb) {
    const missing = !qa ? a : b;
    return { stats: stats0, action: { kind: "wait", reason: "market missing" }, message: `No ${cfg.base} market on ${missing} right now: waiting.`, error: `${cfg.base} not listed on ${missing}` };
  }
  const quote = (v: PerpVenueName) => (v === a ? qa : qb);
  const [sa, sb] = await Promise.all([venues.position(a, qa.market), venues.position(b, qb.market)]);
  const fundingHourly = { [a]: qa.fundingHourly, [b]: qb.fundingHourly };
  const obs = { now, sizes: { [a]: sa, [b]: sb }, fundingHourly, markUsd: (qa.markUsd + qb.markUsd) / 2 };
  const minNotionalUsd = Math.max(qa.minQty * qa.markUsd, qa.minNotionalUsd, qb.minQty * qb.markUsd, qb.minNotionalUsd) * 1.02;

  // Funding the held pair earned since the last tick, at the spread now (an estimate between two reads).
  const heldSpread = stats0.longVenue ? spreadAprPct(obs, stats0.longVenue, stats0.longVenue === a ? b : a) : null;
  const heldNotional = stats0.legs.reduce((s, l) => Math.max(s, l.qty * quote(l.venue).markUsd), 0);
  const stats = { ...accrueFunding(stats0, heldSpread, heldNotional, stats0.lastTickAt ?? now, now), lastTickAt: now };

  const action = opts.closeAll ? closeAllAction(cfg, stats, obs) : decide(cfg, stats, obs);
  const sizes: Partial<Record<PerpVenueName, number>> = { [a]: sa, [b]: sb };
  const fills: Fill[] = [];
  const send = async (venue: PerpVenueName, o: { isBuy: boolean; sizeUsd?: number; qty?: number; reduceOnly: boolean; stopLossPct?: number }): Promise<PairFill> => {
    const out = await venues.order(venue, { market: quote(venue).market, leverage: cfg.leverage, ...o });
    if (out.ok && out.filledQty && out.filledQty > 0) {
      fills.push({ venue, isBuy: o.isBuy, qty: out.filledQty, px: out.avgPx ?? quote(venue).markUsd, takerFee: quote(venue).takerFee });
      sizes[venue] = (sizes[venue] ?? 0) + (o.isBuy ? out.filledQty : -out.filledQty);
    }
    return out;
  };
  const makerVenue = makerVenueOf(cfg);
  // "Stop & close" closes at market: a post-only close could wait a minute or fill in part.
  const useMaker = !!(makerVenue && venues.maker) && !opts.closeAll;
  const sleep = venues.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = venues.clock ?? Date.now;
  /** One maker leg on the maker venue, hedged at taker on the other; fills recorded like the taker path's. */
  const makerRun = async (o: { isBuy: boolean; qty: number; reduceOnly: boolean }) => {
    const mv = makerVenue as PerpVenueName;
    const hv = mv === a ? b : a;
    const mq = quote(mv);
    const hq = quote(hv);
    const m = venues.maker!;
    const r = await runMakerLeg(
      {
        book: () => m.book(mq.market),
        post: (p) => m.post(mq.market, { ...p, leverage: cfg.leverage }),
        cancel: (oid) => m.cancel(mq.market, oid),
        makerPosition: () => venues.position(mv, mq.market),
        makerTaker: (p) => send(mv, p),
        hedge: (p) => send(hv, { ...p, stopLossPct: p.reduceOnly ? undefined : venueStopPct(cfg) }),
        sleep,
        now: clock,
      },
      {
        ...o,
        hedgeMinQty: Math.max(hq.minQty, hq.sizeStep, hq.minNotionalUsd / Math.max(hq.markUsd, 1e-9)),
        makerStep: mq.sizeStep,
        timeoutMs: Math.max(10, cfg.makerTimeoutSec) * 1000,
        pollMs: MAKER_POLL_MS,
        repostBps: MAKER_REPOST_BPS,
      },
    );
    for (const f of r.maker) {
      fills.push({ venue: mv, isBuy: o.isBuy, qty: f.qty, px: f.px, takerFee: MAKER_FEE.Hyperliquid });
      sizes[mv] = (sizes[mv] ?? 0) + (o.isBuy ? f.qty : -f.qty);
    }
    return { ...r, makerVenue: mv, hedgeVenue: hv };
  };
  const view = (s: BotStats): BotView => {
    const held = s.longVenue ? spreadAprPct(obs, s.longVenue, s.longVenue === a ? b : a) : null;
    return {
      at: now,
      sizes,
      marks: { [a]: qa.markUsd, [b]: qb.markUsd },
      markets: { [a]: qa.market, [b]: qb.market },
      fundingHourly,
      bestSpreadAprPct: bestOrientation(cfg, obs).spreadAprPct,
      heldSpreadAprPct: held,
      minNotionalUsd,
      takerFees: [qa.takerFee, qb.takerFee],
    };
  };

  // Close both legs at their exact sizes (reduce-only).
  const closeBoth = async (): Promise<{ ok: boolean; error?: string }> => {
    const ms = makerVenue === a ? sa : sb;
    if (useMaker && ms !== 0) {
      const r = await makerRun({ isBuy: ms < 0, qty: Math.abs(ms), reduceOnly: true });
      // A hedge leg larger than the maker leg (a trimmed pair) is closed at taker.
      const hv = r.hedgeVenue;
      const left = sizes[hv] ?? 0;
      if (!r.error && Math.abs(left) * quote(hv).markUsd > DUST_USD) await send(hv, { isBuy: left < 0, qty: Math.abs(left), reduceOnly: true });
      return r.error ? { ok: false, error: r.error } : { ok: true };
    }
    const outs = await Promise.all(
      ([[a, sa], [b, sb]] as const).filter(([, s]) => s !== 0).map(([v, s]) => send(v, { isBuy: s < 0, qty: Math.abs(s), reduceOnly: true })),
    );
    const failed = outs.find((o) => !o.ok);
    return failed ? { ok: false, error: failed.error } : { ok: true };
  };

  // Open the pair long on `longVenue`: the thinner book first, the other at the quantity it filled.
  type Opening = { opened: boolean; message: string; exposed?: boolean; legs?: HeldLeg[]; needsMargin?: TickResult["needsMargin"] };
  const openPair = async (longVenue: PerpVenueName, shortVenue: PerpVenueName): Promise<Opening> => {
    const drawn = openingSize(cfg, minNotionalUsd, rand);
    const [fl, fs] = await Promise.all([venues.freeMargin(longVenue, quote(longVenue).market), venues.freeMargin(shortVenue, quote(shortVenue).market)]);
    // Each closed pair moves its PnL from one venue's margin to the other's: when the thinner venue no longer
    // covers the drawn size, open what it covers (above the markets' minimum) rather than stall.
    const fits = maxPerSideUsd(fl, fs, cfg.leverage);
    const size = fits < drawn && fits >= minNotionalUsd ? fits : drawn;
    const sizedDown = size < drawn ? ` Sized down from ~${fmt(drawn)}: ${fl < fs ? longVenue : shortVenue} has ${fmt(Math.min(fl, fs))} free.` : "";
    const need = marginNeededUsd(size, cfg.leverage);
    const missing = [
      fl < need ? { venue: longVenue, freeUsd: fl, neededUsd: need } : null,
      fs < need ? { venue: shortVenue, freeUsd: fs, neededUsd: need } : null,
    ].filter((x): x is NonNullable<typeof x> => x !== null);
    if (missing.length) {
      return { opened: false, needsMargin: missing, message: `Waiting for margin: each leg needs ~${fmt(need)} (${missing.map((m) => `${m.venue} has ${fmt(m.freeUsd)} free`).join(", ")}).` };
    }
    if (useMaker) {
      const mv = makerVenue as PerpVenueName;
      const mq = quote(mv);
      const qty = Math.floor(size / mq.markUsd / mq.sizeStep + 1e-9) * mq.sizeStep;
      const r = await makerRun({ isBuy: mv === longVenue, qty: Math.round(qty * 1e10) / 1e10, reduceOnly: false });
      const matched = r.matchedQty;
      if (matched * mq.markUsd < minNotionalUsd) {
        return { opened: false, message: r.error ? `Maker opening failed: ${r.error}` : `The maker order didn't fill enough in ${cfg.makerTimeoutSec}s: nothing held, retrying next tick.` };
      }
      const avg = (xs: { qty: number; px: number }[]) => xs.reduce((s2, f) => s2 + f.qty * f.px, 0) / Math.max(1e-12, xs.reduce((s2, f) => s2 + f.qty, 0));
      const makerLeg: HeldLeg = { venue: mv, side: mv === longVenue ? "long" : "short", qty: matched, entryPx: avg(r.maker) || mq.markUsd };
      const hedgeLeg: HeldLeg = { venue: r.hedgeVenue, side: mv === longVenue ? "short" : "long", qty: matched, entryPx: avg(r.hedge) || quote(r.hedgeVenue).markUsd };
      await venues.maker!.protect(mq.market, { isLong: makerLeg.side === "long", qty: matched, entry: makerLeg.entryPx, stopLossPct: venueStopPct(cfg) }).catch(() => undefined);
      return { opened: true, legs: makerLeg.side === "long" ? [makerLeg, hedgeLeg] : [hedgeLeg, makerLeg], message: `Opened ${matched} ${cfg.base} as maker on ${mv}, hedged on ${r.hedgeVenue}: long ${longVenue}, short ${shortVenue}.${sizedDown}` };
    }
    const venuesOf: PerpVenueName[] = [longVenue, shortVenue];
    const first = quote(longVenue).dayVolumeUsd <= quote(shortVenue).dayVolumeUsd ? 0 : 1;
    const run = await runPerpPair([first, 1 - first], {
      open: (i, qty) => send(venuesOf[i], { isBuy: i === 0, sizeUsd: size, qty, reduceOnly: false, stopLossPct: venueStopPct(cfg) }),
      close: (i, qty) => send(venuesOf[i], { isBuy: i !== 0, qty, reduceOnly: true }),
    });
    if (run.status === "neutral") {
      const leg = (f: { legIndex: number; qty: number; avgPx?: number }): HeldLeg => ({
        venue: venuesOf[f.legIndex],
        side: f.legIndex === 0 ? "long" : "short",
        qty: f.qty,
        entryPx: f.avgPx ?? quote(venuesOf[f.legIndex]).markUsd,
      });
      return { opened: true, legs: [leg(run.first), leg(run.second)], message: `Opened ${run.first.qty} ${cfg.base} (~${fmt(size)} a leg): long ${longVenue}, short ${shortVenue}.${sizedDown}` };
    }
    if (run.status === "first_failed") return { opened: false, message: `Opening failed, nothing traded: ${run.error}` };
    if (run.status === "unwound") return { opened: false, message: `Second leg failed (${run.error}); the first was closed.` };
    return { opened: false, exposed: true, message: `Exposed: ${run.qty} ${cfg.base} left open on ${venuesOf[run.legIndex]} (${run.error}; close failed: ${run.unwindError}).` };
  };

  const settle = (s: BotStats, message: string, extra: Partial<TickResult> = {}): TickResult => ({ stats: s, action, message, view: view(s), ...extra });
  const afterOpen = (r: Opening, longVenue: PerpVenueName, kind: "open" | "rotate"): TickResult => {
    const schedule = cfg.mode === "farm" ? planNext(cfg, now, rand) : null;
    const next = recordFills(stats, action, fills, now, r.opened && r.legs ? { longVenue, legs: r.legs, closeAt: schedule?.closeAt ?? null } : undefined);
    // The exposed leg is the bot's own: "Stop & close" closes it.
    if (r.exposed) return settle({ ...next, openedAt: next.openedAt ?? now, stopReason: "a leg is exposed" }, r.message, { error: r.message });
    if (r.needsMargin) return settle(next, r.message, { needsMargin: r.needsMargin });
    const message = kind === "rotate" ? (r.opened ? `Rotated. ${r.message}` : `Rotated out; reopening failed: ${r.message}`) : r.message;
    return settle(next, message, r.opened ? {} : { error: r.message });
  };

  try {
    switch (action.kind) {
      case "wait":
        return settle(stats, action.reason);
      case "stop":
        return settle({ ...stats, stopReason: action.reason }, `Stopped: ${action.reason}.`);
      case "reduce": {
        const out = await send(action.venue, { isBuy: action.isBuy, qty: action.qty, reduceOnly: true });
        const next = recordFills(stats, action, fills, now);
        return out.ok ? settle(next, action.reason) : settle(next, `${action.reason}: failed (${out.error})`, { error: out.error });
      }
      case "close": {
        const out = await closeBoth();
        if (!out.ok) return settle(recordFills(stats, { kind: "wait", reason: "" }, fills, now), `Closing failed: ${out.error}`, { error: out.error });
        const reopenAt = action.scheduled ? planNext(cfg, now, rand).reopenAt : null;
        const next = recordFills(stats, action, fills, now, undefined, reopenAt);
        const when = reopenAt ? ` Next pair at ${new Date(reopenAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}.` : "";
        return settle(next, `Closed the pair (${action.reason}).${when}`);
      }
      case "open":
        return afterOpen(await openPair(action.longVenue, action.shortVenue), action.longVenue, "open");
      case "rotate": {
        const out = await closeBoth();
        if (!out.ok) return settle(recordFills(stats, { kind: "wait", reason: "" }, fills, now), `Rotation: closing failed (${out.error})`, { error: out.error });
        const o = bestOrientation(cfg, obs);
        return afterOpen(await openPair(o.longVenue, o.shortVenue), o.longVenue, "rotate");
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return settle(recordFills(stats, { kind: "wait", reason: "" }, fills, now), `Error: ${msg}`, { error: msg });
  }
}
