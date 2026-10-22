import { describe, expect, it } from "vitest";
import { botHealth, volumeLast24h } from "@/lib/neutralBot/health";
import { DEFAULT_BOT_CONFIG, EMPTY_STATS } from "@/lib/neutralBot/engine";

const NOW = 1_000_000_000_000;
const cfg = { ...DEFAULT_BOT_CONFIG, base: "SOL", venues: ["Extended", "Hyperliquid"] as ["Extended", "Hyperliquid"], notionalUsd: 41 };
const base = { running: true, cfg, stats: EMPTY_STATS, view: null, needsMargin: null, failures: 0 };
const legs = [
  { venue: "Extended" as const, side: "long" as const, qty: 0.3, entryPx: 150 },
  { venue: "Hyperliquid" as const, side: "short" as const, qty: 0.3, entryPx: 150.2 },
];

describe("bot health line", () => {
  it("says all is well when the pair is hedged, with the next step and the last check", () => {
    const view = { at: NOW - 12_000, sizes: {}, marks: { Extended: 151, Hyperliquid: 151 }, markets: {}, fundingHourly: {}, bestSpreadAprPct: 5, heldSpreadAprPct: 5, minNotionalUsd: 10, takerFees: [0.00025, 0.00045] as [number, number] };
    const h = botHealth({ ...base, view, stats: { ...EMPTY_STATS, openedAt: NOW - 60_000, legs, closeAt: NOW + 30 * 60_000 } }, NOW);
    expect(h.tone).toBe("good");
    expect(h.label).toBe("Farming");
    expect(h.detail).toMatch(/All good: SOL hedged, long Extended \/ short Hyperliquid, hedge PnL \+\$0\.06\. Next close at .* \(in 30 min\)\. Last check 12s ago\./);
    expect(h.deltaPct).toBe(0);
  });

  it("flags missing margin, a failing tick, a pause and a stop", () => {
    expect(botHealth({ ...base, needsMargin: [{ venue: "Extended", freeUsd: 0, neededUsd: 13.94 }] }, NOW)).toMatchObject({ tone: "warn", label: "Needs margin", detail: expect.stringMatching(/Extended has \$0\.00 free, needs ~\$13\.94/) });
    expect(botHealth({ ...base, failures: 2 }, NOW)).toMatchObject({ tone: "warn", label: "Retrying" });
    expect(botHealth({ ...base, running: false, stats: { ...EMPTY_STATS, openedAt: 1, legs } }, NOW)).toMatchObject({ tone: "warn", label: "Paused" });
    expect(botHealth({ ...base, running: false, stats: { ...EMPTY_STATS, stopReason: "a leg is exposed" } }, NOW)).toMatchObject({ tone: "bad", label: "Stopped" });
    expect(botHealth({ ...base, running: false }, NOW)).toMatchObject({ tone: "idle", label: "Off" });
  });

  it("shows the random reopening time between two pairs", () => {
    expect(botHealth({ ...base, stats: { ...EMPTY_STATS, reopenAt: NOW + 8 * 60_000 } }, NOW)).toMatchObject({ label: "Between pairs", detail: expect.stringMatching(/in 8 min/) });
  });

  it("counts the volume of the last 24 hours", () => {
    const h = [
      { t: NOW - 30 * 3_600_000, volumeUsd: 100 },
      { t: NOW - 2 * 3_600_000, volumeUsd: 300 },
      { t: NOW - 60_000, volumeUsd: 450 },
    ];
    expect(volumeLast24h(h, NOW)).toBe(350);
    expect(volumeLast24h([], NOW)).toBe(0);
  });
});
