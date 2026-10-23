import { describe, expect, it } from "vitest";
import { extendedQuote, hlQuote } from "@/lib/planner/markets";
import { DEFAULT_BOT_CONFIG, EMPTY_STATS, type BotConfig } from "@/lib/neutralBot/engine";
import { closeBotPair, runTick, type BotVenues } from "@/lib/neutralBot/runner";
import type { PerpVenueName } from "@/lib/planner/markets";

const hourly = (aprPct: number) => aprPct / 100 / 8760;
const snapshot = {
  quotes: [
    hlQuote({ market: "ETH", base: "ETH", markUsd: 2500, fundingHourly: hourly(11), szDecimals: 4, maxLeverage: 25, dayVolumeUsd: 900e6 }),
    extendedQuote({ market: "ETH-USD", base: "ETH", markUsd: 2500, fundingHourly: hourly(-2), sizeStep: 0.001, minQty: 0.01, maxLeverage: 50, dayVolumeUsd: 80e6 }),
  ],
};
const cfg: BotConfig = { ...DEFAULT_BOT_CONFIG, base: "ETH", venues: ["Hyperliquid", "Extended"], notionalUsd: 50, leverage: 3, holdMinMinutes: 60, holdMaxMinutes: 60, gapMinMinutes: 0, gapMaxMinutes: 0, sizeJitterPct: 0 };
const mid = () => 0.5;

/** Venues that fill every order at 2500 and keep positions, optionally failing one venue's openings. */
function fakeVenues(opts: { failOpen?: PerpVenueName; failClose?: PerpVenueName; margin?: number; marginOf?: Partial<Record<PerpVenueName, number>> } = {}) {
  const pos: Record<string, number> = { Hyperliquid: 0, Extended: 0 };
  const log: string[] = [];
  const v: BotVenues = {
    order: async (venue, o) => {
      if (!o.reduceOnly && opts.failOpen === venue) return { ok: false, error: "no liquidity" };
      if (o.reduceOnly && opts.failClose === venue) return { ok: false, error: "rejected" };
      const qty = o.qty ?? Math.floor(((o.sizeUsd ?? 0) / 2500) * 1000) / 1000;
      pos[venue] += o.isBuy ? qty : -qty;
      log.push(`${venue} ${o.isBuy ? "buy" : "sell"} ${qty}${o.reduceOnly ? " ro" : ""}${o.stopLossPct ? ` sl${o.stopLossPct}` : ""}`);
      return { ok: true, filledQty: qty, avgPx: 2500 };
    },
    position: async (venue) => pos[venue],
    freeMargin: async (venue) => opts.marginOf?.[venue] ?? opts.margin ?? 100,
  };
  return { v, pos, log };
}

describe("neutral bot tick", () => {
  it("opens the pair: thinner book first, long where funding is lowest, counting volume and fees", async () => {
    const f = fakeVenues();
    const r = await runTick(cfg, EMPTY_STATS, snapshot, f.v, 1000, mid);
    // Each opening leg carries a stop on its venue, short of liquidation (3x: 22.5%).
    expect(f.log).toEqual(["Extended buy 0.02 sl22.5", "Hyperliquid sell 0.02 sl22.5"]);
    expect(f.pos).toEqual({ Hyperliquid: -0.02, Extended: 0.02 });
    expect(r.stats).toMatchObject({ volumeUsd: 100, openedAt: 1000, longVenue: "Extended", closeAt: 1000 + 60 * 60_000 });
    expect(r.stats.legs).toEqual([
      { venue: "Extended", side: "long", qty: 0.02, entryPx: 2500 },
      { venue: "Hyperliquid", side: "short", qty: 0.02, entryPx: 2500 },
    ]);
    expect(r.view).toMatchObject({ sizes: { Extended: 0.02, Hyperliquid: -0.02 }, markets: { Hyperliquid: "ETH", Extended: "ETH-USD" } });
    expect(r.stats.feesUsd).toBeCloseTo(50 * 0.00025 + 50 * 0.00045);
    expect(r.error).toBeUndefined();
  });

  it("refuses to open without the margin on both venues", async () => {
    const f = fakeVenues({ margin: 5 });
    const r = await runTick(cfg, EMPTY_STATS, snapshot, f.v, 1000, mid);
    expect(f.log).toEqual([]);
    expect(r.message).toMatch(/Waiting for margin/);
    // Waiting on a deposit is not a failure: the bot keeps checking.
    expect(r.error).toBeUndefined();
    expect(r.needsMargin?.map((m) => m.venue)).toEqual(["Extended", "Hyperliquid"]);
  });

  it("opens what the thinner venue's margin covers, rather than stall, above the markets' minimum", async () => {
    // $10 free on Extended at 3x covers ~$29 a side, not the $50 asked.
    const f = fakeVenues({ marginOf: { Extended: 10, Hyperliquid: 100 } });
    const r = await runTick(cfg, EMPTY_STATS, snapshot, f.v, 1000, mid);
    expect(r.message).toMatch(/Sized down from ~\$50\.00: Extended has \$10\.00 free/);
    expect(f.pos.Extended).toBeCloseTo(0.011);
    expect(r.needsMargin).toBeUndefined();
  });

  it("unwinds when the second leg fails", async () => {
    const f = fakeVenues({ failOpen: "Hyperliquid" });
    const r = await runTick(cfg, EMPTY_STATS, snapshot, f.v, 1000, mid);
    expect(f.pos).toEqual({ Hyperliquid: 0, Extended: 0 });
    expect(r.message).toMatch(/first was closed/);
    expect(r.stats.stopReason).toBeNull();
  });

  it("stops when a leg is left exposed", async () => {
    const opts: { failOpen?: PerpVenueName; failClose?: PerpVenueName } = { failOpen: "Hyperliquid", failClose: "Extended" };
    const f = fakeVenues(opts);
    const r = await runTick(cfg, EMPTY_STATS, snapshot, f.v, 1000, mid);
    expect(r.stats.stopReason).toMatch(/exposed/);
    // "Stop & close" afterwards closes the bot's own lone leg.
    opts.failClose = undefined;
    const closing = await runTick({ ...cfg, maxCycles: 1 }, { ...r.stats, cycles: 1, stopReason: null }, snapshot, f.v, 2000, mid);
    expect(closing.action).toMatchObject({ kind: "reduce", venue: "Extended" });
    expect(f.pos).toEqual({ Hyperliquid: 0, Extended: 0 });
  });

  it("rotates on schedule: closes both, reopens, one more cycle", async () => {
    const f = fakeVenues();
    const opened = await runTick(cfg, EMPTY_STATS, snapshot, f.v, 0, mid);
    f.log.length = 0;
    const r = await runTick(cfg, opened.stats, snapshot, f.v, 61 * 60_000, mid);
    expect(r.action.kind).toBe("rotate");
    expect(f.log).toEqual(["Hyperliquid buy 0.02 ro", "Extended sell 0.02 ro", "Extended buy 0.02 sl22.5", "Hyperliquid sell 0.02 sl22.5"]);
    expect(r.stats).toMatchObject({ cycles: 1, volumeUsd: 300, openedAt: 61 * 60_000 });
    expect(r.stats.history.map((p) => p.volumeUsd)).toEqual([100, 300]);
  });

  it("with a pause: closes on schedule, stays flat until the drawn time, then reopens", async () => {
    const paused = { ...cfg, gapMinMinutes: 10, gapMaxMinutes: 10 };
    const f = fakeVenues();
    const opened = await runTick(paused, EMPTY_STATS, snapshot, f.v, 0, mid);
    const closed = await runTick(paused, opened.stats, snapshot, f.v, 61 * 60_000, mid);
    expect(closed.action).toMatchObject({ kind: "close", scheduled: true });
    expect(closed.stats.reopenAt).toBe(71 * 60_000);
    expect(f.pos).toEqual({ Hyperliquid: 0, Extended: 0 });
    expect((await runTick(paused, closed.stats, snapshot, f.v, 65 * 60_000, mid)).action.kind).toBe("wait");
    expect((await runTick(paused, closed.stats, snapshot, f.v, 72 * 60_000, mid)).action.kind).toBe("open");
  });

  it("maker mode: posts the Hyperliquid leg at the best price and hedges Extended at taker, at the maker fee", async () => {
    const f = fakeVenues();
    let t = 0;
    let resting: { isBuy: boolean; qty: number; px: number } | null = null;
    const posted: string[] = [];
    f.v.maker = {
      book: async () => ({ bid: 2499.9, ask: 2500.1 }),
      post: async (_m, o) => {
        resting = o;
        posted.push(`${o.isBuy ? "buy" : "sell"} ${o.qty}@${o.px}${o.reduceOnly ? " ro" : ""}`);
        return { ok: true, oid: posted.length };
      },
      cancel: async () => {
        resting = null;
      },
      protect: async () => undefined,
    };
    // The resting order fills in full at the first poll.
    f.v.sleep = async (ms) => {
      t += ms;
      if (resting) {
        f.pos.Hyperliquid += resting.isBuy ? resting.qty : -resting.qty;
        resting = null;
      }
    };
    f.v.clock = () => t;
    const r = await runTick({ ...cfg, execution: "maker" }, EMPTY_STATS, snapshot, f.v, 1000, mid);
    // Long Extended / short Hyperliquid: the short is posted at the ask, Extended bought at taker.
    expect(posted).toEqual(["sell 0.02@2500.1"]);
    expect(f.log).toEqual(["Extended buy 0.02 sl22.5"]);
    expect(f.pos).toEqual({ Hyperliquid: -0.02, Extended: 0.02 });
    expect(r.stats.legs.map((l) => `${l.venue} ${l.side} ${l.qty}`)).toEqual(["Extended long 0.02", "Hyperliquid short 0.02"]);
    // Hyperliquid at 0.015% (maker), Extended at 0.025% (taker).
    expect(r.stats.feesUsd).toBeCloseTo(0.02 * 2500.1 * 0.00015 + 0.02 * 2500 * 0.00025, 6);

    // Closing: the Hyperliquid leg buys back as maker, Extended sells at taker.
    const later = r.stats.closeAt as number;
    const closed = await runTick({ ...cfg, execution: "maker", gapMaxMinutes: 5, gapMinMinutes: 1 }, r.stats, snapshot, f.v, later + 1, mid);
    expect(closed.action.kind).toBe("close");
    expect(posted[1]).toBe("buy 0.02@2499.9 ro");
    expect(f.pos).toEqual({ Hyperliquid: 0, Extended: 0 });
  });

  describe("Stop & close", () => {
    const opened = async (f: ReturnType<typeof fakeVenues>) => (await runTick(cfg, EMPTY_STATS, snapshot, f.v, 1000, mid)).stats;

    it("closes both legs at market, even unequal ones, and counts the pair", async () => {
      const f = fakeVenues();
      const stats = await opened(f);
      f.pos.Extended = 0.03; // legs out of balance: a trim alone would leave the pair open
      f.log.length = 0;
      const r = await closeBotPair(cfg, stats, snapshot, f.v, 2000);
      expect(f.pos).toEqual({ Hyperliquid: 0, Extended: 0 });
      expect(f.log).toEqual(["Hyperliquid buy 0.02 ro", "Extended sell 0.03 ro"]);
      expect(r.stats).toMatchObject({ openedAt: null, legs: [], cycles: 1 });
      expect(r.message).toMatch(/Closed the pair \(stopped by you\)/);
    });

    it("closes a lone leg the bot opened", async () => {
      const f = fakeVenues();
      const stats = await opened(f);
      f.pos.Hyperliquid = 0;
      await closeBotPair(cfg, stats, snapshot, f.v, 2000);
      expect(f.pos).toEqual({ Hyperliquid: 0, Extended: 0 });
    });

    it("in maker mode, closes at market rather than wait on a post-only order", async () => {
      const f = fakeVenues();
      const stats = await opened(f);
      f.v.maker = { book: async () => ({ bid: 2499.9, ask: 2500.1 }), post: async () => ({ ok: true, oid: 1 }), cancel: async () => undefined, protect: async () => undefined };
      f.log.length = 0;
      await closeBotPair({ ...cfg, execution: "maker" }, stats, snapshot, f.v, 2000);
      expect(f.log).toEqual(["Hyperliquid buy 0.02 ro", "Extended sell 0.02 ro"]);
    });

    it("never touches a position the bot didn't open, and says so", async () => {
      const f = fakeVenues();
      f.pos.Hyperliquid = -0.05;
      const r = await closeBotPair(cfg, EMPTY_STATS, snapshot, f.v, 2000);
      expect(f.log).toEqual([]);
      expect(r.message).toMatch(/wasn't opened by the bot: left as is/);
      const flat = await closeBotPair(cfg, EMPTY_STATS, snapshot, fakeVenues().v, 2000);
      expect(flat.message).toMatch(/no pair open, nothing to close/);
    });
  });
});
