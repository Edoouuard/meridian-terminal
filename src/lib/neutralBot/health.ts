/**
 * health.ts — the bot's state in one line for the dashboard and the top bar:
 * all good (pair hedged, next step at…), between two pairs, waiting for
 * margin, paused, stopped. Pure and unit-tested.
 */

import type { BotState } from "@/lib/neutralBot/store";
import { openPnlUsd } from "@/lib/neutralBot/engine";

export type HealthTone = "good" | "info" | "warn" | "bad" | "idle";

export interface BotHealth {
  tone: HealthTone;
  /** Short label for the top bar and the status pill. */
  label: string;
  /** One sentence: what the bot is doing, and what (if anything) needs the user. */
  detail: string;
  /** Imbalance between the two legs, % of the smaller (null when no pair is held). */
  deltaPct: number | null;
}

const clock = (t: number) => new Date(t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
const inMin = (t: number, now: number) => `${Math.max(0, Math.ceil((t - now) / 60_000))} min`;
const ago = (t: number, now: number) => {
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
};

export function botHealth(s: Pick<BotState, "running" | "stats" | "view" | "needsMargin" | "failures" | "cfg">, now: number): BotHealth {
  const legs = s.stats.legs;
  const deltaPct = legs.length === 2 && Math.min(legs[0].qty, legs[1].qty) > 0 ? (Math.abs(legs[0].qty - legs[1].qty) / Math.min(legs[0].qty, legs[1].qty)) * 100 : null;
  const checked = s.view ? ` Last check ${ago(s.view.at, now)}.` : "";

  if (s.stats.stopReason && !s.running) return { tone: s.stats.stopReason === "stopped by you" ? "idle" : "bad", label: "Stopped", detail: `Stopped: ${s.stats.stopReason}.`, deltaPct };
  if (!s.running) {
    return s.stats.openedAt
      ? { tone: "warn", label: "Paused", detail: `Paused with the ${s.cfg.base} pair open: Resume, or Stop & close it.`, deltaPct }
      : { tone: "idle", label: "Off", detail: "Off. Pick a pair and start it: it runs from this tab.", deltaPct };
  }
  if (s.needsMargin?.length) {
    const m = s.needsMargin.map((x) => `${x.venue} has $${x.freeUsd.toFixed(2)} free, needs ~$${x.neededUsd.toFixed(2)}`).join("; ");
    return { tone: "warn", label: "Needs margin", detail: `Waiting for margin: ${m}. It opens as soon as the deposit lands.${checked}`, deltaPct };
  }
  if (s.failures > 0) return { tone: "warn", label: "Retrying", detail: `The last ${s.failures === 1 ? "tick" : `${s.failures} ticks`} failed; retrying (pauses after 3).${checked}`, deltaPct };
  if (s.stats.openedAt && legs.length === 2) {
    const long = legs.find((l) => l.side === "long");
    const short = legs.find((l) => l.side === "short");
    const pnl = s.view ? openPnlUsd(legs, s.view.marks) : null;
    const next = s.cfg.mode === "farm" && s.stats.closeAt ? ` Next ${s.cfg.gapMaxMinutes > 0 ? "close" : "rotation"} at ${clock(s.stats.closeAt)} (in ${inMin(s.stats.closeAt, now)}).` : "";
    const hedge = deltaPct !== null && deltaPct > 2 ? ` Legs differ by ${deltaPct.toFixed(1)}%: rebalancing.` : "";
    return {
      tone: hedge ? "warn" : "good",
      label: s.cfg.mode === "farm" ? "Farming" : "Earning carry",
      detail: `All good: ${s.cfg.base} hedged, long ${long?.venue} / short ${short?.venue}${pnl !== null ? `, hedge PnL ${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(2)}` : ""}.${hedge}${next}${checked}`,
      deltaPct,
    };
  }
  if (s.cfg.mode === "farm" && s.stats.reopenAt && s.stats.reopenAt > now) {
    return { tone: "info", label: "Between pairs", detail: `Between two pairs: the next opens at ${clock(s.stats.reopenAt)} (in ${inMin(s.stats.reopenAt, now)}), at a random time and size.${checked}`, deltaPct };
  }
  return { tone: "info", label: "Starting", detail: `Opening the ${s.cfg.base} pair…${checked}`, deltaPct };
}

/** Volume made in the last 24 hours, from the cumulative history. */
export function volumeLast24h(history: { t: number; volumeUsd: number }[], now: number): number {
  if (history.length === 0) return 0;
  const last = history[history.length - 1].volumeUsd;
  const before = [...history].reverse().find((p) => p.t <= now - 86_400_000);
  return last - (before?.volumeUsd ?? 0);
}
