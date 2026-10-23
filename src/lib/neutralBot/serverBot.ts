/**
 * serverBot.ts — the neutral bot running on Meridian's server, so it keeps
 * trading while the user's computer sleeps, until the user stops it.
 *
 * A wallet's bot is one record in Redis: its settings, totals, log and state
 * (the same `BotCore` the browser keeps), plus its trading keys sealed with
 * BOT_ENCRYPTION_KEY: the Hyperliquid and TxFlow agent keys (they trade, and
 * can't withdraw) and the Extended account's API and Stark keys. Every minute
 * the tick route runs one tick per running bot, under a lock so two ticks
 * never trade the same pair at once. Starting, pausing and closing are
 * signed by the wallet (`botActionMessage`), so only its owner controls it;
 * reading the state is open (it holds nothing a venue doesn't show).
 */

import { verifyMessage, type Address, type Hex } from "viem";
import type { Signer as ExtendedSigner } from "@blackcube/extended-sdk";
import { fetchPerpSnapshot } from "@/lib/perpFeed";
import { perpCore } from "@/lib/perpCore";
import { hyperliquidEnv } from "@/lib/integrations/hyperliquidTrade";
import { runTick, type BotVenues } from "@/lib/neutralBot/runner";
import { EMPTY_STATS, type BotConfig, type BotStats } from "@/lib/neutralBot/engine";
import { addLog, foldTick, foldTickError, type BotCore, type BotLogLine } from "@/lib/neutralBot/tickState";
import { kv, kvGetJson, kvLock, kvSetJson } from "@/lib/server/kv";
import { open, seal } from "@/lib/server/secretBox";
import { serverRelayToken } from "@/lib/server/relayToken";
import { serverOrigin, setServerRelayBase } from "@/lib/integrations/extendedProxy";
import { botActionMessage, type BotAction } from "@/lib/neutralBot/serverAuth";

export interface BotKeys {
  hlAgentKey?: Hex;
  hlTestnet?: boolean;
  txflowAgentKey?: Hex;
  extended?: ExtendedSigner;
}

export interface ServerBotRecord extends BotCore {
  address: Address;
  /** BotKeys, sealed. */
  keys: string;
  lastTickAt: number | null;
  updatedAt: number;
}

/** What anyone may read: the record without its keys. */
export type ServerBotState = Omit<ServerBotRecord, "keys"> & { hasKeys: boolean };

const recKey = (a: string) => `nbot:${a.toLowerCase()}`;
const lockKey = (a: string) => `nbot:lock:${a.toLowerCase()}`;
export const ACTIVE_SET = "nbot:active";

export { botActionMessage, type BotAction } from "@/lib/neutralBot/serverAuth";

export async function verifyBotAction(action: BotAction, address: Address, ts: number, signature: Hex, now = Date.now()): Promise<boolean> {
  if (!(Math.abs(now - ts) < 5 * 60_000)) return false;
  return verifyMessage({ address, message: botActionMessage(action, address, ts), signature }).catch(() => false);
}

export const publicState = (r: ServerBotRecord): ServerBotState => {
  const { keys, ...rest } = r;
  return { ...rest, hasKeys: !!keys };
};

export const loadRecord = (address: string) => kvGetJson<ServerBotRecord>(recKey(address));
const saveRecord = (r: ServerBotRecord) => kvSetJson(recKey(r.address), { ...r, updatedAt: Date.now() });

/** The venues the bot trades, from its delegated keys. */
function venuesFor(r: ServerBotRecord): BotVenues {
  const token = serverRelayToken();
  if (token) setServerRelayBase(`${serverOrigin()}/api/extended-srv/${token}`);
  const k = JSON.parse(open(r.keys)) as BotKeys;
  const missing = (v: string) => async () => {
    throw new Error(`No ${v} trading key on the server: start the bot again from Meridian.`);
  };
  const core = perpCore({
    user: r.address,
    hlEnv: hyperliquidEnv(!!k.hlTestnet),
    withHl: (fn) => (k.hlAgentKey ? fn(k.hlAgentKey) : missing("Hyperliquid")()),
    withTxflow: (fn) => (k.txflowAgentKey ? fn(k.txflowAgentKey) : missing("TxFlow")()),
    extended: k.extended ?? null,
  });
  return { ...core };
}

/** Start (or resume) a wallet's bot on the server with these settings and keys. */
export async function startServerBot(p: { address: Address; cfg: BotConfig; stats?: BotStats; log?: BotLogLine[]; keys?: BotKeys }): Promise<ServerBotRecord> {
  const prev = await loadRecord(p.address);
  const keys = p.keys ? seal(JSON.stringify(p.keys)) : prev?.keys;
  if (!keys) throw new Error("No trading keys: the server needs them to trade.");
  const now = Date.now();
  const stats = { ...(p.stats ?? prev?.stats ?? EMPTY_STATS), stopReason: null };
  const r: ServerBotRecord = {
    address: p.address,
    cfg: p.cfg,
    stats: { ...stats, startedAt: stats.startedAt ?? now },
    log: addLog(p.log ?? prev?.log ?? [], "Running on Meridian's server: it keeps trading while this computer sleeps, until you pause or stop it.", "ok", now),
    running: true,
    failures: 0,
    view: prev?.view ?? null,
    needsMargin: null,
    keys,
    lastTickAt: prev?.lastTickAt ?? null,
    updatedAt: now,
  };
  await saveRecord(r);
  await kv("SADD", ACTIVE_SET, p.address.toLowerCase());
  return r;
}

export async function pauseServerBot(address: Address): Promise<ServerBotRecord | null> {
  const r = await loadRecord(address);
  await kv("SREM", ACTIVE_SET, address.toLowerCase());
  if (!r) return null;
  const next = { ...r, running: false, log: addLog(r.log, "Paused on the server: the pair stays as it is.", "info", Date.now()) };
  await saveRecord(next);
  return next;
}

/** Forget the bot and its keys (pausing it first). */
export async function forgetServerBot(address: Address): Promise<void> {
  await kv("SREM", ACTIVE_SET, address.toLowerCase());
  await kv("DEL", recKey(address));
}

/** One tick of one bot, under its lock. `close`: close the held pair and stop. */
export async function tickServerBot(address: string, opts: { close?: boolean } = {}): Promise<ServerBotRecord | null> {
  if (!(await kvLock(lockKey(address), 280))) return null;
  try {
    const r = await loadRecord(address);
    if (!r) {
      await kv("SREM", ACTIVE_SET, address.toLowerCase());
      return null;
    }
    if (!r.running && !opts.close) {
      await kv("SREM", ACTIVE_SET, address.toLowerCase());
      return r;
    }
    const now = Date.now();
    let next: ServerBotRecord;
    try {
      const venues = venuesFor(r);
      const snapshot = await fetchPerpSnapshot();
      if (opts.close) {
        // The budget path closes a held pair (or a lone leg of it), never a position the bot didn't open.
        const done = Math.max(1, r.stats.cycles);
        const t = await runTick({ ...r.cfg, maxCycles: done }, { ...r.stats, cycles: done, stopReason: null }, snapshot, venues, now);
        const stats = { ...t.stats, cycles: t.action.kind === "close" ? r.stats.cycles + 1 : r.stats.cycles, stopReason: "stopped by you" };
        next = { ...r, stats, view: t.view ?? r.view, needsMargin: null, running: false, log: addLog(r.log, t.action.kind === "stop" ? "Nothing to close: no pair open." : t.message, t.error ? "bad" : "ok", now) };
      } else {
        next = foldTick(r, await runTick(r.cfg, r.stats, snapshot, venues, now), now);
      }
    } catch (err) {
      next = foldTickError(r, err instanceof Error ? err.message.split("\n")[0] : String(err), now);
    }
    next = { ...next, lastTickAt: now };
    await saveRecord(next);
    if (!next.running) await kv("SREM", ACTIVE_SET, address.toLowerCase());
    return next;
  } finally {
    await kv("DEL", lockKey(address)).catch(() => undefined);
  }
}

export const activeBots = async () => (await kv<string[]>("SMEMBERS", ACTIVE_SET)) ?? [];
