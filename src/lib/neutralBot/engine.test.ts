import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOT_CONFIG,
  EMPTY_STATS,
  accrueFunding,
  bestOrientation,
  budgetReached,
  decide,
  migrateConfig,
  openPnlUsd,
  openingSize,
  planNext,
  recordFills,
  type BotConfig,
  type BotObservation,
} from "@/lib/neutralBot/engine";

const NOW = 1_000_000_000;
const cfg: BotConfig = { ...DEFAULT_BOT_CONFIG, base: "ETH", venues: ["Hyperliquid", "Extended"], notionalUsd: 50, gapMinMinutes: 0, gapMaxMinutes: 0 };
const hourly = (aprPct: number) => aprPct / 100 / 8760;
const obs = (sizes: Record<string, number>, over: Partial<BotObservation> = {}): BotObservation => ({
  now: NOW,
  sizes,
  fundingHourly: { Hyperliquid: hourly(11), Extended: hourly(-2) },
  markUsd: 2400,
  ...over,
});
const held = (over: Partial<typeof EMPTY_STATS> = {}) => ({ ...EMPTY_STATS, openedAt: NOW - 10 * 60_000, longVenue: "Extended" as const, closeAt: NOW + 30 * 60_000, ...over });
const pair = { Extended: 0.02, Hyperliquid: -0.02 };

describe("neutral bot decisions", () => {
  it("opens flat, long where funding is lowest", () => {
    expect(decide(cfg, EMPTY_STATS, obs({}))).toMatchObject({ kind: "open", longVenue: "Extended", shortVenue: "Hyperliquid" });
    expect(bestOrientation(cfg, { fundingHourly: { Hyperliquid: hourly(-5), Extended: hourly(3) } })).toMatchObject({ longVenue: "Hyperliquid", shortVenue: "Extended" });
  });

  it("in carry, waits for a spread worth opening, and closes when it fades", () => {
    const carry = { ...cfg, mode: "carry" as const, minSpreadAprPct: 20, exitSpreadAprPct: 5 };
    expect(decide(carry, EMPTY_STATS, obs({}))).toMatchObject({ kind: "wait" });
    expect(decide(carry, EMPTY_STATS, obs({}, { fundingHourly: { Hyperliquid: hourly(30), Extended: hourly(0) } }))).toMatchObject({ kind: "open", longVenue: "Extended" });
    expect(decide(carry, held(), obs(pair, { fundingHourly: { Hyperliquid: hourly(3), Extended: hourly(0) } }))).toMatchObject({ kind: "close" });
  });

  it("closes a lone leg of its own pair before anything else", () => {
    expect(decide(cfg, held(), obs({ Hyperliquid: -0.02 }))).toMatchObject({ kind: "reduce", venue: "Hyperliquid", isBuy: true, qty: 0.02 });
  });

  it("never touches a position it didn't open", () => {
    expect(decide(cfg, EMPTY_STATS, obs({ Hyperliquid: 0.5 }))).toMatchObject({ kind: "stop", reason: expect.stringMatching(/didn't open is on Hyperliquid/) });
  });

  it("trims the larger leg to the smaller", () => {
    const a = decide(cfg, held(), obs({ Extended: 0.03, Hyperliquid: -0.02 }));
    expect(a).toMatchObject({ kind: "reduce", venue: "Extended", isBuy: false });
    expect(a.kind === "reduce" && a.qty).toBeCloseTo(0.01);
  });

  it("never treats two same-side positions as its pair", () => {
    expect(decide(cfg, held(), obs({ Extended: 0.02, Hyperliquid: 0.02 }))).toMatchObject({ kind: "stop", reason: expect.stringMatching(/not a neutral pair/) });
  });

  it("farms on its schedule: holds until the drawn close time, then rotates (no pause) or closes (with a pause)", () => {
    expect(decide(cfg, held(), obs(pair))).toMatchObject({ kind: "wait", reason: expect.stringMatching(/rotates at .* \(in 30 min\)/) });
    expect(decide(cfg, held({ closeAt: NOW - 1 }), obs(pair))).toMatchObject({ kind: "rotate" });
    const paused = { ...cfg, gapMinMinutes: 5, gapMaxMinutes: 20 };
    expect(decide(paused, held({ closeAt: NOW - 1 }), obs(pair))).toMatchObject({ kind: "close", scheduled: true });
    // Flat again: no new pair before the drawn reopening time.
    expect(decide(paused, { ...EMPTY_STATS, reopenAt: NOW + 7 * 60_000 }, obs({}))).toMatchObject({ kind: "wait", reason: expect.stringMatching(/next pair opens at .* \(in 7 min\)/) });
    expect(decide(paused, { ...EMPTY_STATS, reopenAt: NOW - 1 }, obs({}))).toMatchObject({ kind: "open" });
  });

  it("rotates early when funding flips hard against the held side", () => {
    expect(decide(cfg, held({ longVenue: "Hyperliquid" }), obs({ Hyperliquid: 0.02, Extended: -0.02 }, { fundingHourly: { Hyperliquid: hourly(25), Extended: hourly(0) } }))).toMatchObject({ kind: "rotate" });
  });

  it("stops on a spent budget, closing first", () => {
    const spent = held({ cycles: 24 });
    expect(budgetReached(cfg, spent)).toMatch(/24 cycles/);
    expect(decide(cfg, spent, obs(pair))).toMatchObject({ kind: "close", thenStop: expect.stringMatching(/cycles/) });
    expect(decide(cfg, { ...EMPTY_STATS, cycles: 24 }, obs({}))).toMatchObject({ kind: "stop" });
    expect(decide(cfg, { ...EMPTY_STATS, feesUsd: 5 }, obs({}))).toMatchObject({ kind: "stop", reason: expect.stringMatching(/fee budget/) });
  });

  it("ignores dust", () => {
    expect(decide(cfg, EMPTY_STATS, obs({ Extended: 0.0001, Hyperliquid: 0 }))).toMatchObject({ kind: "open" });
  });
});

describe("random schedule and sizes", () => {
  it("draws the hold and the pause within their ranges", () => {
    const c = { ...cfg, holdMinMinutes: 30, holdMaxMinutes: 90, gapMinMinutes: 5, gapMaxMinutes: 15 };
    expect(planNext(c, NOW, () => 0)).toEqual({ closeAt: NOW + 30 * 60_000, reopenAt: NOW + 5 * 60_000 });
    const r = [0.5, 0.999];
    const p = planNext(c, NOW, () => r.shift()!);
    expect(p.closeAt).toBe(NOW + 60 * 60_000);
    expect(p.reopenAt).toBeCloseTo(NOW + 14.99 * 60_000, -2);
  });

  it("varies the size around the base, never under the markets' minimum", () => {
    expect(openingSize({ ...cfg, sizeJitterPct: 20 }, 10, () => 0)).toBe(40);
    expect(openingSize({ ...cfg, sizeJitterPct: 20 }, 10, () => 0.999)).toBeCloseTo(59.98, 1);
    expect(openingSize({ ...cfg, sizeJitterPct: 20 }, 45, () => 0)).toBe(45);
    expect(openingSize({ ...cfg, mode: "carry", sizeJitterPct: 20 }, 10, () => 0)).toBe(50);
  });

  it("migrates a saved config from the fixed rotation", () => {
    const m = migrateConfig({ base: "SOL", rotateMinutes: 60 } as never, cfg);
    expect(m).toMatchObject({ base: "SOL", holdMinMinutes: 60, holdMaxMinutes: 60, gapMinMinutes: 0, gapMaxMinutes: 0 });
    expect("rotateMinutes" in m).toBe(false);
  });
});

describe("accounting", () => {
  const fills = [
    { venue: "Extended" as const, isBuy: true, qty: 0.02, px: 2500, takerFee: 0.00025 },
    { venue: "Hyperliquid" as const, isBuy: false, qty: 0.02, px: 2500, takerFee: 0.00045 },
  ];
  const legs = [
    { venue: "Extended" as const, side: "long" as const, qty: 0.02, entryPx: 2500 },
    { venue: "Hyperliquid" as const, side: "short" as const, qty: 0.02, entryPx: 2501 },
  ];

  it("counts volume, fees, cycles and the chart history", () => {
    const open = { kind: "open" as const, longVenue: "Extended" as const, shortVenue: "Hyperliquid" as const, spreadAprPct: 13 };
    const s1 = recordFills(EMPTY_STATS, open, fills, 5, { longVenue: "Extended", legs, closeAt: 99 });
    expect(s1).toMatchObject({ volumeUsd: 100, openedAt: 5, longVenue: "Extended", cycles: 0, closeAt: 99, legs });
    expect(s1.feesUsd).toBeCloseTo(0.035);
    expect(s1.history).toEqual([{ t: 5, volumeUsd: 100, feesUsd: s1.feesUsd }]);
    const s2 = recordFills(s1, { kind: "close", reason: "", scheduled: true }, fills, 9, undefined, 40);
    expect(s2).toMatchObject({ cycles: 1, openedAt: null, legs: [], reopenAt: 40, volumeUsd: 200 });
    const s3 = recordFills(s2, { kind: "close", reason: "", thenStop: "done" }, [], 10);
    expect(s3).toMatchObject({ cycles: 2, stopReason: "done" });
  });

  it("accrues funding while a pair is held, and prices the hedge", () => {
    const s = { ...EMPTY_STATS, openedAt: 0, legs };
    // $50 a leg at +17.52%/yr for 10 hours: 50 × 0.1752 × 10 / 8760 = $0.01.
    expect(accrueFunding(s, 17.52, 50, 0, 10 * 3_600_000).fundingUsd).toBeCloseTo(0.01, 6);
    expect(accrueFunding(EMPTY_STATS, 17.52, 50, 0, 3_600_000).fundingUsd).toBe(0);
    // Price up $100: the long gains 2, the short loses 1.98 (it entered $1 higher).
    expect(openPnlUsd(legs, { Extended: 2600, Hyperliquid: 2600 })).toBeCloseTo(0.02);
    expect(openPnlUsd(legs, { Extended: 2600 })).toBeNull();
  });
});
