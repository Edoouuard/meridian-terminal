import { describe, expect, it } from "vitest";
import { extendedQuote, hlQuote } from "@/lib/planner/markets";
import { DEFAULT_BOT_CONFIG, EMPTY_STATS, type BotConfig } from "@/lib/neutralBot/engine";
import { runTick, type BotVenues } from "@/lib/neutralBot/runner";
import type { PerpVenueName } from "@/lib/planner/markets";

const hourly = (aprPct: number) => aprPct / 100 / 8760;
const snapshot = {
  quotes: [
    hlQuote({ market: "ETH", base: "ETH", markUsd: 2500, fundingHourly: hourly(11), szDecimals: 4, maxLeverage: 25, dayVolumeUsd: 900e6 }),
    extendedQuote({ market: "ETH-USD", base: "ETH", markUsd: 2500, fundingHourly: hourly(-2), sizeStep: 0.001, minQty: 0.01, maxLeverage: 50, dayVolumeUsd: 80e6 }),
  ],
};
const cfg: BotConfig = { ...DEFAULT_BOT_CONFIG, base: "ETH", venues: ["Hyperliquid", "Extended"], notionalUsd: 50, leverage: 3 };

/** Venues that fill every order at 2500 and keep positions, optionally failing one venue's openings. */
function fakeVenues(opts: { failOpen?: PerpVenueName; failClose?: PerpVenueName; margin?: number } = {}) {
  const pos: Record<string, number> = { Hyperliquid: 0, Extended: 0 };
  const log: string[] = [];
  const v: BotVenues = {
    order: async (venue, o) => {
      if (!o.reduceOnly && opts.failOpen === venue) return { ok: false, error: "no liquidity" };
      if (o.reduceOnly && opts.failClose === venue) return { ok: false, error: "rejected" };
      const qty = o.qty ?? Math.floor(((o.sizeUsd ?? 0) / 2500) * 1000) / 1000;
      pos[venue] += o.isBuy ? qty : -qty;
      log.push(`${venue} ${o.isBuy ? "buy" : "sell"} ${qty}${o.reduceOnly ? " ro" : ""}`);
      return { ok: true, filledQty: qty, avgPx: 2500 };
    },
    position: async (venue) => pos[venue],
    freeMargin: async () => opts.margin ?? 100,
  };
  return { v, pos, log };
}

describe("neutral bot tick", () => {
  it("opens the pair: thinner book first, long where funding is lowest, counting volume and fees", async () => {
    const f = fakeVenues();
    const r = await runTick(cfg, EMPTY_STATS, snapshot, f.v, 1000);
    expect(f.log).toEqual(["Extended buy 0.02", "Hyperliquid sell 0.02"]);
    expect(f.pos).toEqual({ Hyperliquid: -0.02, Extended: 0.02 });
    expect(r.stats).toMatchObject({ volumeUsd: 100, openedAt: 1000, longVenue: "Extended" });
    expect(r.stats.feesUsd).toBeCloseTo(50 * 0.00025 + 50 * 0.00045);
    expect(r.error).toBeUndefined();
  });

  it("refuses to open without the margin on both venues", async () => {
    const f = fakeVenues({ margin: 5 });
    const r = await runTick(cfg, EMPTY_STATS, snapshot, f.v, 1000);
    expect(f.log).toEqual([]);
    expect(r.message).toMatch(/Not enough margin/);
  });

  it("unwinds when the second leg fails", async () => {
    const f = fakeVenues({ failOpen: "Hyperliquid" });
    const r = await runTick(cfg, EMPTY_STATS, snapshot, f.v, 1000);
    expect(f.pos).toEqual({ Hyperliquid: 0, Extended: 0 });
    expect(r.message).toMatch(/first was closed/);
    expect(r.stats.stopReason).toBeNull();
  });

  it("stops when a leg is left exposed", async () => {
    const opts: { failOpen?: PerpVenueName; failClose?: PerpVenueName } = { failOpen: "Hyperliquid", failClose: "Extended" };
    const f = fakeVenues(opts);
    const r = await runTick(cfg, EMPTY_STATS, snapshot, f.v, 1000);
    expect(r.stats.stopReason).toMatch(/exposed/);
    // "Stop & close" afterwards closes the bot's own lone leg.
    opts.failClose = undefined;
    const closing = await runTick({ ...cfg, maxCycles: 1 }, { ...r.stats, cycles: 1, stopReason: null }, snapshot, f.v, 2000);
    expect(closing.action).toMatchObject({ kind: "reduce", venue: "Extended" });
    expect(f.pos).toEqual({ Hyperliquid: 0, Extended: 0 });
  });

  it("rotates on schedule: closes both, reopens, one more cycle", async () => {
    const f = fakeVenues();
    const opened = await runTick(cfg, EMPTY_STATS, snapshot, f.v, 0);
    f.log.length = 0;
    const r = await runTick(cfg, opened.stats, snapshot, f.v, 61 * 60_000);
    expect(r.action.kind).toBe("rotate");
    expect(f.log).toEqual(["Hyperliquid buy 0.02 ro", "Extended sell 0.02 ro", "Extended buy 0.02", "Hyperliquid sell 0.02"]);
    expect(r.stats).toMatchObject({ cycles: 1, volumeUsd: 300, openedAt: 61 * 60_000 });
  });
});
