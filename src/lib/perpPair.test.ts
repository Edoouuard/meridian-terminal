import { describe, expect, it, vi } from "vitest";
import type { TradePlan } from "@/lib/tradePlan";
import { oneClickPair, pairSequence, runPerpPair, type PairFill, type PairVenue } from "@/lib/perpPair";

const leg = (side: string, protocol: string, sizeUsd = 1000) => ({ side, asset: "ETH-PERP", protocol, sizeUsd, chain: "Arbitrum" }) as TradePlan["legs"][number];

const pairPlan: TradePlan = {
  intent: "betaNeutral",
  summary: "Long ETH on Hyperliquid, short on Extended.",
  legs: [leg("Long", "Hyperliquid"), leg("Short", "Extended")],
  pair: { legs: [0, 1], sizing: "equal_base_quantity" },
};

/** A venue whose orders answer from the scripted fills, recording each call. */
function scripted(opens: Record<number, PairFill>, closes: PairFill[] = []) {
  const calls: string[] = [];
  const venue: PairVenue = {
    open: vi.fn(async (i: number, qty?: number) => {
      calls.push(`open ${i}${qty !== undefined ? ` ${qty}` : ""}`);
      return opens[i];
    }),
    close: vi.fn(async (i: number, qty: number) => {
      calls.push(`close ${i} ${qty}`);
      return closes.shift() ?? { ok: false, error: "no fill" };
    }),
  };
  return { venue, calls };
}

describe("pairSequence / oneClickPair", () => {
  it("follows the plan's execution sequence when it names the pair legs", () => {
    expect(pairSequence(pairPlan)).toEqual([0, 1]);
    const thinFirst = { ...pairPlan, execution: { sequence: [1, 0] } as TradePlan["execution"] };
    expect(pairSequence(thinFirst)).toEqual([1, 0]);
    expect(oneClickPair(thinFirst)).toEqual([1, 0]);
    // A sequence that doesn't match the pair is ignored.
    expect(pairSequence({ ...pairPlan, execution: { sequence: [0, 2] } as TradePlan["execution"] })).toEqual([0, 1]);
  });

  it("only offers two sized perp legs on opposite sides", () => {
    expect(oneClickPair({ ...pairPlan, pair: undefined })).toBeNull();
    expect(oneClickPair({ ...pairPlan, legs: [leg("Long", "Hyperliquid"), leg("Long", "Extended")] })).toBeNull();
    expect(oneClickPair({ ...pairPlan, legs: [leg("Buy", "Hyperliquid"), leg("Short", "Hyperliquid")] })).toBeNull();
    expect(oneClickPair({ ...pairPlan, legs: [leg("Long", "Hyperliquid", 0), leg("Short", "Extended")] })).toBeNull();
    expect(oneClickPair({ ...pairPlan, legs: [leg("Long", "Lighter"), leg("Short", "Extended")] })).toBeNull();
    // Same account: the two legs would just net out.
    expect(oneClickPair({ ...pairPlan, legs: [leg("Long", "Hyperliquid"), leg("Short", "Hyperliquid")] })).toBeNull();
  });
});

describe("runPerpPair", () => {
  it("sizes the second leg on the first fill", async () => {
    const { venue, calls } = scripted({ 1: { ok: true, filledQty: 0.31, avgPx: 3200, ref: "extended:ETH-USD:0.31@3200" }, 0: { ok: true, filledQty: 0.31, avgPx: 3201 } });
    const steps: string[] = [];
    const run = await runPerpPair([1, 0], venue, (s) => steps.push(`${s.phase} ${s.legIndex}`));
    expect(calls).toEqual(["open 1", "open 0 0.31"]);
    expect(steps).toEqual(["first 1", "second 0"]);
    expect(run).toMatchObject({ status: "neutral", first: { legIndex: 1, qty: 0.31, ref: "extended:ETH-USD:0.31@3200" }, second: { legIndex: 0, qty: 0.31 } });
  });

  it("stops before the second leg when the first doesn't fill", async () => {
    const { venue, calls } = scripted({ 0: { ok: true, filledQty: 0 } });
    const run = await runPerpPair([0, 1], venue);
    expect(calls).toEqual(["open 0"]);
    expect(run.status).toBe("first_failed");
  });

  it("closes the first leg when the second fails", async () => {
    const { venue, calls } = scripted({ 0: { ok: true, filledQty: 0.5 }, 1: { ok: false, error: "Insufficient margin" } }, [{ ok: true, filledQty: 0.5 }]);
    const run = await runPerpPair([0, 1], venue);
    expect(calls).toEqual(["open 0", "open 1 0.5", "close 0 0.5"]);
    expect(run).toMatchObject({ status: "unwound", secondIndex: 1, error: "Insufficient margin" });
  });

  it("closes the first leg when the second venue throws", async () => {
    const { venue } = scripted({ 0: { ok: true, filledQty: 0.5 } }, [{ ok: true, filledQty: 0.5 }]);
    venue.open = vi.fn(async (i: number) => {
      if (i === 1) throw new Error("network down");
      return { ok: true, filledQty: 0.5 };
    });
    const run = await runPerpPair([0, 1], venue);
    expect(run).toMatchObject({ status: "unwound", error: "network down" });
  });

  it("reports what stays open when the unwind fails too", async () => {
    const { venue } = scripted({ 0: { ok: true, filledQty: 0.5 }, 1: { ok: false, error: "rejected" } }, [{ ok: true, filledQty: 0.2 }]);
    const run = await runPerpPair([0, 1], venue);
    expect(run).toMatchObject({ status: "exposed", legIndex: 0, error: "rejected" });
    if (run.status === "exposed") expect(run.qty).toBeCloseTo(0.3);
  });

  it("trims the first leg to a partial second fill", async () => {
    const { venue, calls } = scripted({ 0: { ok: true, filledQty: 1 }, 1: { ok: true, filledQty: 0.8 } }, [{ ok: true, filledQty: 0.2 }]);
    const run = await runPerpPair([0, 1], venue);
    expect(calls[2]).toMatch(/^close 0 0\.2/);
    expect(run).toMatchObject({ status: "neutral", second: { qty: 0.8 } });
    if (run.status === "neutral") {
      expect(run.first.qty).toBeCloseTo(0.8);
      expect(run.trimmed).toBeCloseTo(0.2);
    }
  });

  it("accepts a second fill within the size-step tolerance", async () => {
    const { venue, calls } = scripted({ 0: { ok: true, filledQty: 1 }, 1: { ok: true, filledQty: 0.995 } });
    const run = await runPerpPair([0, 1], venue);
    expect(calls).toHaveLength(2);
    expect(run.status).toBe("neutral");
  });
});
