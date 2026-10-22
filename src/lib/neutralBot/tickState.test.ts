import { describe, expect, it } from "vitest";
import { DEFAULT_BOT_CONFIG, EMPTY_STATS, type BotConfig } from "@/lib/neutralBot/engine";
import { foldTick, foldTickError, MAX_FAILURES, OFFLINE_MSG, type BotCore } from "@/lib/neutralBot/tickState";
import type { TickResult } from "@/lib/neutralBot/runner";

const cfg: BotConfig = { ...DEFAULT_BOT_CONFIG, base: "ETH", venues: ["Hyperliquid", "Extended"], notionalUsd: 50 };
const base: BotCore = { cfg, stats: EMPTY_STATS, log: [], running: true, failures: 0, view: null, needsMargin: null };
const wait = (message: string, extra: Partial<TickResult> = {}): TickResult => ({ stats: EMPTY_STATS, action: { kind: "wait", reason: message }, message, ...extra });

describe("folding a tick into the bot's state", () => {
  it("logs a quiet hold once, a trade every time", () => {
    const a = foldTick(base, wait("holding"), 1);
    const b = foldTick(a, wait("holding"), 2);
    expect(b.log.map((l) => l.text)).toEqual(["holding"]);
    const c = foldTick(b, { ...wait("Opened"), action: { kind: "open", longVenue: "Extended", shortVenue: "Hyperliquid", spreadAprPct: 1 } }, 3);
    expect(c.log[0]).toMatchObject({ text: "Opened", tone: "ok" });
  });

  it("pauses after three failures in a row, not while offline", () => {
    let s = base;
    for (let i = 0; i < MAX_FAILURES; i++) s = foldTick(s, wait("x", { error: "boom" }), i, true);
    expect(s).toMatchObject({ failures: 0, running: true });
    for (let i = 0; i < MAX_FAILURES; i++) s = foldTick(s, wait("x", { error: "boom" }), i);
    expect(s.running).toBe(false);
    expect(s.log[0].text).toMatch(/Paused after 3 failed ticks/);
  });

  it("stops on a stop reason, and treats a thrown offline tick as a warning", () => {
    expect(foldTick(base, wait("done", { stats: { ...EMPTY_STATS, stopReason: "fee budget used" } }), 1).running).toBe(false);
    const off = foldTickError(base, "Failed to fetch", 1, true);
    expect(off).toMatchObject({ failures: 0, running: true });
    expect(off.log[0].text).toBe(OFFLINE_MSG);
    expect(foldTickError(base, "boom", 1).failures).toBe(1);
  });
});
