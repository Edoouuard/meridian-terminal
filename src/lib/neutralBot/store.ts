/**
 * store.ts — the neutral bot's state for the whole page: settings, totals,
 * the last tick's view, the log, running or not.
 *
 * It lives outside any panel so the bot keeps running while the user moves
 * between the terminal, Tools and the bot's own view (components/NeutralBotHost
 * runs the ticks; components/NeutralBotView shows them). Settings, totals and
 * the log are kept per wallet in localStorage; the bot itself never restarts
 * on its own after a reload.
 */

import { useSyncExternalStore } from "react";
import type { PerpVenueName } from "@/lib/planner/markets";
import { DEFAULT_BOT_CONFIG, EMPTY_STATS, migrateConfig, type BotConfig, type BotStats } from "@/lib/neutralBot/engine";
import type { BotView, TickResult } from "@/lib/neutralBot/runner";

import type { BotLogLine } from "@/lib/neutralBot/tickState";
export type { BotLogLine } from "@/lib/neutralBot/tickState";

export interface BotState {
  address: string | null;
  cfg: BotConfig;
  stats: BotStats;
  log: BotLogLine[];
  running: boolean;
  /** An order or the start sequence is in flight. */
  busy: boolean;
  view: BotView | null;
  needsMargin: TickResult["needsMargin"] | null;
  /** Consecutive failed ticks. */
  failures: number;
  /** When the next tick is due (ms), while running. */
  nextTickAt: number | null;
  /** The bot runs on Meridian's server (24/7) rather than in this tab. */
  onServer: boolean;
}

export const DEFAULT_CONFIG: BotConfig = { ...DEFAULT_BOT_CONFIG, base: "ETH", venues: ["Hyperliquid", "Extended"] as [PerpVenueName, PerpVenueName], notionalUsd: 50 };
const LOG_LINES = 200;

let state: BotState = { address: null, cfg: DEFAULT_CONFIG, stats: EMPTY_STATS, log: [], running: false, busy: false, view: null, needsMargin: null, failures: 0, nextTickAt: null, onServer: false };
const listeners = new Set<() => void>();

const storeKey = (address: string) => `meridian:neutralBot:${address.toLowerCase()}`;

function persist() {
  if (!state.address) return;
  try {
    localStorage.setItem(storeKey(state.address), JSON.stringify({ cfg: state.cfg, stats: state.stats, log: state.log.slice(0, LOG_LINES), onServer: state.onServer }));
  } catch {
    /* storage full or blocked: the bot keeps running, without memory across reloads */
  }
}

export function getBotState(): BotState {
  return state;
}

export function setBotState(patch: Partial<BotState> | ((s: BotState) => Partial<BotState>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  if ("cfg" in p || "stats" in p || "log" in p || "onServer" in p) persist();
  for (const l of listeners) l();
}

/** The wallet changed: load its bot (a running bot of another wallet stops first). */
export function loadBotFor(address: string | null) {
  if (address === state.address) return;
  type Saved = { cfg?: Partial<BotConfig> & { rotateMinutes?: number }; stats?: Partial<BotStats>; log?: BotLogLine[]; onServer?: boolean };
  const read = (): Saved | null => {
    try {
      return address ? (JSON.parse(localStorage.getItem(storeKey(address)) ?? "null") as Saved | null) : null;
    } catch {
      return null;
    }
  };
  const saved = read();
  state = {
    ...state,
    address,
    running: false,
    busy: false,
    view: null,
    needsMargin: null,
    failures: 0,
    nextTickAt: null,
    cfg: saved?.cfg ? migrateConfig(saved.cfg, DEFAULT_CONFIG) : DEFAULT_CONFIG,
    stats: { ...EMPTY_STATS, ...(saved?.stats ?? {}) },
    log: (saved?.log ?? []).map((l) => ({ ...l, tone: l.tone ?? "info" })),
    onServer: !!saved?.onServer,
  };
  for (const l of listeners) l();
}

export function botLog(text: string, tone: BotLogLine["tone"] = "info") {
  setBotState((s) => ({ log: [{ at: Date.now(), text, tone }, ...s.log].slice(0, LOG_LINES) }));
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useBotState(): BotState {
  return useSyncExternalStore(subscribe, getBotState, getBotState);
}

/** The actions the host binds (it holds the venues' trading keys). */
export interface BotRunner {
  start: () => Promise<void>;
  pause: () => Promise<void>;
  closeNow: () => Promise<void>;
  /** Remove the bot and its trading keys from the server. */
  forgetServer: () => Promise<void>;
}

let runner: BotRunner | null = null;
export function bindBotRunner(r: BotRunner | null) {
  runner = r;
}
export function botRunner(): BotRunner | null {
  return runner;
}
