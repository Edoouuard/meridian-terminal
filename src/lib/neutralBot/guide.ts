/**
 * guide.ts — the plain-language side of the neutral bot's setup: the pace
 * presets (Calm / Normal / Intense) behind the schedule's four numbers, what
 * a day at that pace makes and costs, and the largest size the deposits
 * allow. Pure and unit-tested; components/NeutralBotView shows them.
 */

import type { BotConfig } from "@/lib/neutralBot/engine";
import { rotationFeeUsd } from "@/lib/neutralBot/engine";

export type Intensity = "calm" | "normal" | "intense";

type Schedule = Pick<BotConfig, "holdMinMinutes" | "holdMaxMinutes" | "gapMinMinutes" | "gapMaxMinutes">;

export const INTENSITY: Record<Intensity, Schedule & { label: string; blurb: string }> = {
  calm: { label: "Calm", blurb: "a pair every few hours", holdMinMinutes: 120, holdMaxMinutes: 240, gapMinMinutes: 15, gapMaxMinutes: 60 },
  normal: { label: "Normal", blurb: "a pair every hour or two", holdMinMinutes: 45, holdMaxMinutes: 120, gapMinMinutes: 2, gapMaxMinutes: 20 },
  intense: { label: "Intense", blurb: "a pair every half hour", holdMinMinutes: 15, holdMaxMinutes: 40, gapMinMinutes: 1, gapMaxMinutes: 5 },
};

/** The preset the schedule matches, or null when it was tuned by hand. */
export function intensityOf(cfg: Schedule): Intensity | null {
  const hit = (Object.keys(INTENSITY) as Intensity[]).find((k) => {
    const p = INTENSITY[k];
    return p.holdMinMinutes === cfg.holdMinMinutes && p.holdMaxMinutes === cfg.holdMaxMinutes && p.gapMinMinutes === cfg.gapMinMinutes && p.gapMaxMinutes === cfg.gapMaxMinutes;
  });
  return hit ?? null;
}

export interface DayEstimate {
  /** Pairs opened and closed a day at this pace (budgets aside). */
  cyclesPerDay: number;
  volumeUsd: number;
  feesUsd: number;
  /** Hours until the fee budget or the cycle cap stops the bot, when that comes within a day. */
  stopsAfterHours: number | null;
}

/** What a day of farming makes and costs at the configured size and pace (average draw of the random schedule). */
export function dayEstimate(cfg: Pick<BotConfig, "notionalUsd" | "maxFeesUsd" | "maxCycles"> & Schedule, takerFees: [number, number]): DayEstimate {
  const cycleMin = Math.max(1, (cfg.holdMinMinutes + cfg.holdMaxMinutes) / 2 + (cfg.gapMinMinutes + cfg.gapMaxMinutes) / 2);
  const cyclesPerDay = 1440 / cycleMin;
  const feePerCycle = rotationFeeUsd(cfg, takerFees);
  const capCycles = Math.min(cfg.maxCycles > 0 ? cfg.maxCycles : Infinity, cfg.maxFeesUsd > 0 && feePerCycle > 0 ? cfg.maxFeesUsd / feePerCycle : Infinity);
  const stopsAfterHours = capCycles < cyclesPerDay ? (capCycles * cycleMin) / 60 : null;
  const cycles = Math.min(cyclesPerDay, capCycles);
  return { cyclesPerDay, volumeUsd: cycles * cfg.notionalUsd * 4, feesUsd: cycles * feePerCycle, stopsAfterHours };
}

/** The largest size per side both venues' free margin opens at this leverage (2% kept for fees), whole dollars. */
export function maxPerSideUsd(freeA: number, freeB: number, leverage: number): number {
  return Math.max(0, Math.floor((Math.min(freeA, freeB) * Math.max(1, leverage)) / 1.02));
}

/** Fees per $10k of volume for a pair, from its round trip (% of one leg; a cycle trades four legs). */
export function feesPer10kUsd(roundTripFeePct: number): number {
  return (10_000 / 4) * (roundTripFeePct / 100);
}
