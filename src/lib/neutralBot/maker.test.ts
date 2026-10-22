import { describe, expect, it } from "vitest";
import { runMakerLeg, type MakerLegPlan, type MakerVenues } from "@/lib/neutralBot/maker";

/** A maker venue whose resting order fills `fills[i]` during poll i, a hedge venue that fills everything. */
function sim(opts: { fills: number[]; books?: { bid: number; ask: number }[]; rejectPost?: boolean; hedgeFails?: boolean }) {
  let t = 0;
  let pos = 0;
  let hedgePos = 0;
  let poll = 0;
  let resting: { oid: number; isBuy: boolean; left: number } | null = null;
  let oid = 0;
  const log: string[] = [];
  const v: MakerVenues = {
    book: async () => opts.books?.[Math.min(poll, (opts.books?.length ?? 1) - 1)] ?? { bid: 100, ask: 100.1 },
    post: async (o) => {
      if (opts.rejectPost) return { ok: false, error: "would take" };
      resting = { oid: ++oid, isBuy: o.isBuy, left: o.qty };
      log.push(`post ${o.isBuy ? "buy" : "sell"} ${o.qty}@${o.px}`);
      return { ok: true, oid };
    },
    cancel: async (id) => {
      if (resting?.oid === id) resting = null;
      log.push(`cancel ${id}`);
    },
    makerPosition: async () => pos,
    makerTaker: async (o) => {
      pos += o.isBuy ? o.qty : -o.qty;
      log.push(`maker-taker ${o.isBuy ? "buy" : "sell"} ${o.qty}`);
      return { ok: true, filledQty: o.qty, avgPx: 100 };
    },
    hedge: async (o) => {
      if (opts.hedgeFails) return { ok: false, error: "no liquidity" };
      hedgePos += o.isBuy ? o.qty : -o.qty;
      log.push(`hedge ${o.isBuy ? "buy" : "sell"} ${o.qty}`);
      return { ok: true, filledQty: o.qty, avgPx: 100.05 };
    },
    sleep: async (ms) => {
      t += ms;
      const f = Math.min(opts.fills[poll] ?? 0, resting?.left ?? 0);
      if (resting && f > 0) {
        pos += resting.isBuy ? f : -f;
        resting.left = Math.round((resting.left - f) * 1e10) / 1e10;
      }
      poll++;
    },
    now: () => t,
  };
  return { v, log, pos: () => pos, hedgePos: () => hedgePos };
}

const plan: MakerLegPlan = { isBuy: true, qty: 1, reduceOnly: false, hedgeMinQty: 0.1, makerStep: 0.01, timeoutMs: 10_000, pollMs: 1000, repostBps: 5 };

describe("maker leg", () => {
  it("joins the best bid and hedges each fill at taker on the other venue", async () => {
    const s = sim({ fills: [0.4, 0.6] });
    const r = await runMakerLeg(s.v, plan);
    expect(s.log).toEqual(["post buy 1@100", "hedge sell 0.4", "hedge sell 0.6"]);
    expect(r.matchedQty).toBe(1);
    expect(r.maker.reduce((a, f) => a + f.qty, 0)).toBe(1);
    expect(s.pos()).toBe(1);
    expect(s.hedgePos()).toBe(-1);
  });

  it("waits until a fill reaches the hedge venue's minimum", async () => {
    const s = sim({ fills: [0.05, 0.05, 0.9] });
    await runMakerLeg(s.v, plan);
    expect(s.log).toEqual(["post buy 1@100", "hedge sell 0.1", "hedge sell 0.9"]);
  });

  it("re-posts at the new best price when the book moves away", async () => {
    const s = sim({ fills: [0, 1], books: [{ bid: 100, ask: 100.1 }, { bid: 100.2, ask: 100.3 }] });
    await runMakerLeg(s.v, plan);
    expect(s.log.slice(0, 3)).toEqual(["post buy 1@100", "cancel 1", "post buy 1@100.2"]);
    expect(s.hedgePos()).toBe(-1);
  });

  it("opening: keeps what filled by the deadline as a smaller pair, closes an unhedgeable slice", async () => {
    const s = sim({ fills: [0.3, 0.05] });
    const r = await runMakerLeg(s.v, { ...plan, timeoutMs: 2000 });
    expect(r.matchedQty).toBe(0.3);
    expect(s.log).toEqual(["post buy 1@100", "hedge sell 0.3", "cancel 1", "maker-taker sell 0.05"]);
    expect(s.pos()).toBeCloseTo(0.3);
    expect(s.hedgePos()).toBeCloseTo(-0.3);
  });

  it("closing: finishes both legs at taker after the deadline", async () => {
    const s = sim({ fills: [0.25] });
    const r = await runMakerLeg(s.v, { ...plan, isBuy: false, reduceOnly: true, timeoutMs: 1000 });
    expect(s.log).toEqual(["post sell 1@100.1", "hedge buy 0.25", "cancel 1", "maker-taker sell 0.75", "hedge buy 0.75"]);
    expect(r.matchedQty).toBe(1);
  });

  it("stops posting when the hedge fails, and reports it", async () => {
    const s = sim({ fills: [0.5], hedgeFails: true });
    const r = await runMakerLeg(s.v, plan);
    expect(r.error).toMatch(/no liquidity/);
    // The unhedged fill is closed again: no naked slice.
    expect(s.pos()).toBe(0);
  });
});
