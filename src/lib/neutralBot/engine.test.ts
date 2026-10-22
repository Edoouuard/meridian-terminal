import { describe, expect, it } from "vitest";
import { DEFAULT_BOT_CONFIG, EMPTY_STATS, bestOrientation, budgetReached, decide, recordFills, type BotConfig, type BotObservation } from "@/lib/neutralBot/engine";

const cfg: BotConfig = { ...DEFAULT_BOT_CONFIG, base: "ETH", venues: ["Hyperliquid", "Extended"], notionalUsd: 50 };
const hourly = (aprPct: number) => aprPct / 100 / 8760;
const obs = (sizes: Record<string, number>, over: Partial<BotObservation> = {}): BotObservation => ({
  now: 1_000_000_000,
  sizes,
  fundingHourly: { Hyperliquid: hourly(11), Extended: hourly(-2) },
  markUsd: 2400,
  ...over,
});

describe("neutral bot decisions", () => {
  it("opens flat, long where funding is lowest", () => {
    expect(decide(cfg, EMPTY_STATS, obs({}))).toMatchObject({ kind: "open", longVenue: "Extended", shortVenue: "Hyperliquid" });
    expect(bestOrientation(cfg, { fundingHourly: { Hyperliquid: hourly(-5), Extended: hourly(3) } })).toMatchObject({ longVenue: "Hyperliquid", shortVenue: "Extended" });
  });

  it("in carry, waits for a spread worth opening, and closes when it fades", () => {
    const carry = { ...cfg, mode: "carry" as const, minSpreadAprPct: 20, exitSpreadAprPct: 5 };
    expect(decide(carry, EMPTY_STATS, obs({}))).toMatchObject({ kind: "wait" });
    expect(decide(carry, EMPTY_STATS, obs({}, { fundingHourly: { Hyperliquid: hourly(30), Extended: hourly(0) } }))).toMatchObject({ kind: "open", longVenue: "Extended" });
    const held = { ...EMPTY_STATS, openedAt: 0, longVenue: "Extended" as const };
    expect(decide(carry, held, obs({ Extended: 0.02, Hyperliquid: -0.02 }, { fundingHourly: { Hyperliquid: hourly(3), Extended: hourly(0) } }))).toMatchObject({ kind: "close" });
  });

  it("closes a lone leg of its own pair before anything else", () => {
    const held = { ...EMPTY_STATS, openedAt: 1_000_000_000 };
    expect(decide(cfg, held, obs({ Hyperliquid: -0.02 }))).toMatchObject({ kind: "reduce", venue: "Hyperliquid", isBuy: true, qty: 0.02 });
  });

  it("never touches a position it didn't open", () => {
    expect(decide(cfg, EMPTY_STATS, obs({ Hyperliquid: 0.5 }))).toMatchObject({ kind: "stop", reason: expect.stringMatching(/didn't open is on Hyperliquid/) });
  });

  it("trims the larger leg to the smaller", () => {
    const a = decide(cfg, { ...EMPTY_STATS, openedAt: 1_000_000_000 }, obs({ Extended: 0.03, Hyperliquid: -0.02 }));
    expect(a).toMatchObject({ kind: "reduce", venue: "Extended", isBuy: false });
    expect(a.kind === "reduce" && a.qty).toBeCloseTo(0.01);
  });

  it("never treats two same-side positions as its pair", () => {
    expect(decide(cfg, { ...EMPTY_STATS, openedAt: 1 }, obs({ Extended: 0.02, Hyperliquid: 0.02 }))).toMatchObject({ kind: "stop", reason: expect.stringMatching(/not a neutral pair/) });
  });

  it("farms: holds, then rotates on schedule", () => {
    const held = { ...EMPTY_STATS, openedAt: 1_000_000_000 - 10 * 60_000, longVenue: "Extended" as const };
    expect(decide(cfg, held, obs({ Extended: 0.02, Hyperliquid: -0.02 }))).toMatchObject({ kind: "wait" });
    const old = { ...held, openedAt: 1_000_000_000 - 61 * 60_000 };
    expect(decide(cfg, old, obs({ Extended: 0.02, Hyperliquid: -0.02 }))).toMatchObject({ kind: "rotate" });
  });

  it("rotates early when funding flips hard against the held side", () => {
    const held = { ...EMPTY_STATS, openedAt: 1_000_000_000, longVenue: "Hyperliquid" as const };
    expect(decide(cfg, held, obs({ Hyperliquid: 0.02, Extended: -0.02 }, { fundingHourly: { Hyperliquid: hourly(25), Extended: hourly(0) } }))).toMatchObject({ kind: "rotate" });
  });

  it("stops on a spent budget, closing first", () => {
    const spent = { ...EMPTY_STATS, cycles: 24, openedAt: 1_000_000_000 };
    expect(budgetReached(cfg, spent)).toMatch(/24 cycles/);
    expect(decide(cfg, spent, obs({ Extended: 0.02, Hyperliquid: -0.02 }))).toMatchObject({ kind: "close", thenStop: expect.stringMatching(/cycles/) });
    expect(decide(cfg, spent, obs({}))).toMatchObject({ kind: "stop" });
    expect(decide(cfg, { ...EMPTY_STATS, feesUsd: 5 }, obs({}))).toMatchObject({ kind: "stop", reason: expect.stringMatching(/fee budget/) });
  });

  it("ignores dust", () => {
    expect(decide(cfg, EMPTY_STATS, obs({ Extended: 0.0001, Hyperliquid: 0 }))).toMatchObject({ kind: "open" });
  });
});

describe("recordFills", () => {
  it("counts volume, fees and cycles", () => {
    const open = { kind: "open" as const, longVenue: "Extended" as const, shortVenue: "Hyperliquid" as const, spreadAprPct: 13 };
    const s1 = recordFills(EMPTY_STATS, open, [{ qty: 0.02, px: 2500, takerFee: 0.00025 }, { qty: 0.02, px: 2500, takerFee: 0.00045 }], 5, { longVenue: "Extended" });
    expect(s1).toMatchObject({ volumeUsd: 100, openedAt: 5, longVenue: "Extended", cycles: 0 });
    expect(s1.feesUsd).toBeCloseTo(0.035);
    const s2 = recordFills(s1, { kind: "rotate", reason: "" }, [], 9, { longVenue: "Hyperliquid" });
    expect(s2).toMatchObject({ cycles: 1, openedAt: 9, longVenue: "Hyperliquid" });
    const s3 = recordFills(s2, { kind: "close", reason: "", thenStop: "done" }, [], 10);
    expect(s3).toMatchObject({ cycles: 2, openedAt: null, stopReason: "done" });
  });
});
