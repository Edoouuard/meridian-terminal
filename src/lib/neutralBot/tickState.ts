/**
 * tickState.ts — what a tick's result does to the bot's state, the same in
 * the browser (components/NeutralBotHost) and on the server
 * (lib/neutralBot/serverBot.ts): the totals, the view, the margin it waits
 * for, the failure count (three in a row pause the bot; no network is not
 * a failure), the log (a quiet hold is logged only when it changes), and
 * whether the bot keeps running.
 */

import type { BotConfig, BotStats } from "@/lib/neutralBot/engine";
import type { BotView, TickResult } from "@/lib/neutralBot/runner";

export interface BotLogLine {
  at: number;
  text: string;
  tone: "ok" | "info" | "warn" | "bad";
}

export interface BotCore {
  cfg: BotConfig;
  stats: BotStats;
  log: BotLogLine[];
  running: boolean;
  failures: number;
  view: BotView | null;
  needsMargin: TickResult["needsMargin"] | null;
}

/** Consecutive failed ticks before the bot pauses itself. */
export const MAX_FAILURES = 3;
export const LOG_LINES = 200;

export const addLog = (log: BotLogLine[], text: string, tone: BotLogLine["tone"], at: number): BotLogLine[] => [{ at, text, tone }, ...log].slice(0, LOG_LINES);

export function foldTick<S extends BotCore>(s: S, r: TickResult, now: number, offline = false): S {
  const failures = r.error ? (offline ? s.failures : s.failures + 1) : 0;
  const traded = r.action.kind !== "wait" && r.action.kind !== "stop" && !r.needsMargin;
  const tone = r.error ? "bad" : r.needsMargin ? "warn" : traded ? "ok" : "info";
  let log = traded || r.error || s.log[0]?.text !== r.message ? addLog(s.log, r.message, tone, now) : s.log;
  let running = s.running;
  if (r.stats.stopReason) running = false;
  else if (failures >= MAX_FAILURES) {
    running = false;
    log = addLog(log, `Paused after ${MAX_FAILURES} failed ticks in a row: check the venues, then Resume.`, "bad", now);
  }
  return { ...s, stats: r.stats, view: r.view ?? s.view, needsMargin: r.needsMargin ?? null, failures, log, running };
}

/** A tick that threw before producing a result. */
export function foldTickError<S extends BotCore>(s: S, message: string, now: number, offline = false): S {
  if (offline) return s.log[0]?.text === OFFLINE_MSG ? s : { ...s, log: addLog(s.log, OFFLINE_MSG, "warn", now) };
  const failures = s.failures + 1;
  const log = addLog(s.log, `Tick failed: ${message}`, "bad", now);
  return { ...s, failures, log, running: failures >= MAX_FAILURES ? false : s.running };
}

export const OFFLINE_MSG = "No network (the computer is waking up or offline): retrying, the bot stays on.";
