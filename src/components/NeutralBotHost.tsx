"use client";

import { useEffect, useRef } from "react";
import { useAccount, useSignMessage } from "wagmi";
import type { Address } from "viem";
import type { MarketSnapshot } from "@/lib/planner/markets";
import { usePerpTrader } from "@/hooks/usePerpTrader";
import { closeBotPair, runTick } from "@/lib/neutralBot/runner";
import { makerVenueOf } from "@/lib/neutralBot/engine";
import { addLog, foldTick, foldTickError } from "@/lib/neutralBot/tickState";
import { botActionMessage, type BotAction } from "@/lib/neutralBot/serverAuth";
import { hyperliquidEnv, loadAgent } from "@/lib/integrations/hyperliquidTrade";
import { loadTxflowAgent } from "@/lib/integrations/txflowTrade";
import { useExtendedAccount } from "@/hooks/useExtendedAccount";
import { useSharedHlEnv } from "@/hooks/useHyperliquidEnv";
import type { ServerBotState } from "@/lib/neutralBot/serverBot";
import { bindBotRunner, botLog, getBotState, loadBotFor, setBotState, useBotState } from "@/lib/neutralBot/store";

/** Seconds between two ticks (a background tab may run them less often). */
export const TICK_SECONDS = 20;
/** A gap this long between two ticks means the tab didn't run (sleep, frozen background tab). */
const SLEPT_AFTER_MS = 3 * TICK_SECONDS * 1000;
const isOffline = (err: unknown) => (typeof navigator !== "undefined" && navigator.onLine === false) || (err instanceof TypeError && /fetch|network|load failed/i.test(err.message));
const errText = (err: unknown) => (err instanceof Error ? err.message.split("\n")[0] : String(err));
type ServerState = ServerBotState;
const fetchServerState = async (address: string): Promise<ServerState | null> => ((await (await fetch(`/api/bot/server?address=${address}`, { cache: "no-store" })).json()) as { state: ServerState | null }).state;
const fetchSnapshot = async () => (await (await fetch("/api/perp-markets", { cache: "no-store" })).json()) as MarketSnapshot;

/**
 * The neutral bot's engine room, mounted once for the page: it loads the
 * wallet's bot, runs a tick every TICK_SECONDS while the bot is on (whatever
 * view the user is in), logs what each tick did, and binds Start and
 * "Stop & close" for the dashboard. Renders nothing.
 */
export function NeutralBotHost() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const extended = useExtendedAccount();
  const hlEnv = useSharedHlEnv();
  const hlEnvRef = useRef(hlEnv);
  useEffect(() => {
    hlEnvRef.current = hlEnv;
  });
  const trader = usePerpTrader();
  const traderRef = useRef(trader);
  useEffect(() => {
    traderRef.current = trader;
  });
  const { running, onServer } = useBotState();
  const inFlight = useRef(false);

  useEffect(() => {
    loadBotFor(address ?? null);
  }, [address]);

  // One tick: read, decide, trade, account, log.
  const tick = useRef(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const { cfg, stats } = getBotState();
      const r = await runTick(cfg, stats, await fetchSnapshot(), traderRef.current, Date.now());
      const next = foldTick(getBotState(), r, Date.now(), navigator.onLine === false);
      setBotState({ ...next, nextTickAt: next.running ? getBotState().nextTickAt : null });
    } catch (err) {
      const next = foldTickError(getBotState(), errText(err), Date.now(), isOffline(err));
      setBotState({ ...next, nextTickAt: next.running ? getBotState().nextTickAt : null });
    } finally {
      inFlight.current = false;
    }
  });

  const localRunning = running && !onServer;

  // The loop: a tick now, then every TICK_SECONDS while running. A computer that slept freezes the tab's
  // timers; on waking (or coming back online, or the tab showing again) the bot ticks at once and says how long it was out.
  useEffect(() => {
    if (!localRunning) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = Date.now();
    const loop = async () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      const gap = Date.now() - last;
      if (gap > SLEPT_AFTER_MS) botLog(`Back after ${Math.round(gap / 60_000)} min without running (computer asleep or tab frozen): checking the pair now.`, "warn");
      last = Date.now();
      await tick.current();
      last = Date.now();
      if (stop || !getBotState().running) return;
      setBotState({ nextTickAt: Date.now() + TICK_SECONDS * 1000 });
      timer = setTimeout(() => void loop(), TICK_SECONDS * 1000);
    };
    const wake = () => {
      if (document.visibilityState === "visible" && Date.now() - last > TICK_SECONDS * 1000 && !inFlight.current) void loop();
    };
    void loop();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("focus", wake);
    };
  }, [localRunning]);

  // While the bot runs, ask the system not to sleep (screen wake lock: honoured while the tab is visible;
  // closing the lid still sleeps the computer). Re-taken when the tab shows again.
  useEffect(() => {
    if (!localRunning) return;
    type Sentinel = { release: () => Promise<void> };
    const wl = (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<Sentinel> } }).wakeLock;
    if (!wl) return;
    let sentinel: Sentinel | null = null;
    const take = () => {
      if (document.visibilityState === "visible") wl.request("screen").then((s) => (sentinel = s)).catch(() => undefined);
    };
    take();
    document.addEventListener("visibilitychange", take);
    return () => {
      document.removeEventListener("visibilitychange", take);
      void sentinel?.release().catch(() => undefined);
    };
  }, [localRunning]);

  // Leaving with the bot on: the browser asks first.
  useEffect(() => {
    if (!localRunning) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [localRunning]);

  // The server's copy of this wallet's bot: read when the wallet loads (a bot already on the server switches
  // this tab to it), then every 10 s while the bot runs there.
  useEffect(() => {
    if (!address) return;
    let stop = false;
    const pull = async () => {
      const st = await fetchServerState(address).catch(() => null);
      if (stop || !st) return;
      if (!getBotState().onServer && !(st.running || st.stats.openedAt)) return;
      setBotState({ onServer: true, cfg: st.cfg, stats: st.stats, log: st.log, running: st.running, failures: st.failures, view: st.view, needsMargin: st.needsMargin, nextTickAt: st.running && st.lastTickAt ? st.lastTickAt + 60_000 : null });
    };
    void pull();
    if (!onServer) return () => void (stop = true);
    const id = setInterval(() => void pull(), 10_000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [address, onServer]);

  const signRef = useRef(signMessageAsync);
  useEffect(() => {
    signRef.current = signMessageAsync;
  });
  const extendedRef = useRef(extended);
  useEffect(() => {
    extendedRef.current = extended;
  });
  /** A signed action on the server bot; its answer becomes this tab's state. */
  const serverAction = async (action: BotAction, extra: Record<string, unknown> = {}) => {
    const user = getBotState().address as Address | null;
    if (!user) throw new Error("Connect a wallet first.");
    const ts = Date.now();
    const signature = await signRef.current({ message: botActionMessage(action, user, ts) });
    const res = await fetch("/api/bot/server", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, address: user, ts, signature, ...extra }) });
    const body = (await res.json().catch(() => ({}))) as { state?: ServerState | null; error?: string };
    if (!res.ok) throw new Error(body.error ?? `server answered ${res.status}`);
    const st = body.state;
    if (st) setBotState({ cfg: st.cfg, stats: st.stats, log: st.log, running: st.running, failures: st.failures, view: st.view, needsMargin: st.needsMargin, nextTickAt: st.running ? Date.now() + 60_000 : null });
    return st;
  };

  useEffect(() => {
    const startedLine = (cfg: ReturnType<typeof getBotState>["cfg"]) =>
      (cfg.mode === "farm"
        ? `Started: farming ${cfg.base} on ${cfg.venues.join(" + ")}, each pair held ${cfg.holdMinMinutes}–${cfg.holdMaxMinutes} min${cfg.gapMaxMinutes > 0 ? `, ${cfg.gapMinMinutes}–${cfg.gapMaxMinutes} min apart` : ""}.`
        : `Started: carry on ${cfg.base}, opening above ${cfg.minSpreadAprPct}%/yr.`) + (makerVenueOf(cfg) ? " Orders: maker on Hyperliquid, the other leg at market." : " Orders: market on both venues.");
    bindBotRunner({
      start: async () => {
        const { cfg, stats, log, onServer: server, address: user } = getBotState();
        setBotState({ busy: true });
        try {
          // The trading keys first (a wallet signature per venue, once per browser): the server trades with the same ones.
          await traderRef.current.prepare(cfg.venues);
          if (server && user) {
            const testnet = hlEnvRef.current === "testnet";
            const keys = {
              hlAgentKey: cfg.venues.includes("Hyperliquid") ? loadAgent(user as Address, hyperliquidEnv(testnet))?.key : undefined,
              hlTestnet: testnet,
              txflowAgentKey: cfg.venues.includes("TxFlow") ? loadTxflowAgent(user as Address)?.key : undefined,
              extended: cfg.venues.includes("Extended") ? (extendedRef.current ?? undefined) : undefined,
            };
            const st = await serverAction("start", { cfg, stats: { ...stats, stopReason: null }, log: addLog(log, startedLine(cfg), "ok", Date.now()), keys });
            if (!st) throw new Error("the server didn't keep the bot");
            return;
          }
          setBotState({ failures: 0, stats: { ...stats, stopReason: null, startedAt: stats.startedAt ?? Date.now() }, running: true });
          botLog(startedLine(cfg), "ok");
        } catch (err) {
          botLog(`Couldn't start: ${errText(err)}`, "bad");
        } finally {
          setBotState({ busy: false });
        }
      },
      pause: async () => {
        if (!getBotState().onServer) {
          setBotState({ running: false, nextTickAt: null });
          return;
        }
        setBotState({ busy: true });
        try {
          await serverAction("pause");
        } catch (err) {
          botLog(`Couldn't pause on the server: ${errText(err)}`, "bad");
        } finally {
          setBotState({ busy: false });
        }
      },
      closeNow: async () => {
        if (getBotState().onServer) {
          setBotState({ busy: true });
          try {
            await serverAction("close");
          } catch (err) {
            botLog(`Close failed: ${errText(err)}`, "bad");
          } finally {
            setBotState({ busy: false });
          }
          return;
        }
        setBotState({ running: false, nextTickAt: null, busy: true });
        try {
          // A tick still trading (an opening in flight) finishes first: closing before it lands would leave its legs open.
          for (let i = 0; inFlight.current && i < 600; i++) await new Promise((r) => setTimeout(r, 200));
          const { cfg, stats } = getBotState();
          const r = await closeBotPair(cfg, stats, await fetchSnapshot(), traderRef.current, Date.now());
          setBotState({ stats: { ...r.stats, stopReason: "stopped by you" }, view: r.view ?? null, needsMargin: null });
          botLog(r.message, r.error ? "bad" : "ok");
        } catch (err) {
          botLog(`Close failed: ${errText(err)}`, "bad");
        } finally {
          setBotState({ busy: false });
        }
      },
      forgetServer: async () => {
        setBotState({ busy: true });
        try {
          await serverAction("forget");
          setBotState({ onServer: false, running: false, nextTickAt: null });
          botLog("Removed from Meridian's server, with its trading keys.", "info");
        } catch (err) {
          botLog(`Couldn't remove it from the server: ${errText(err)}`, "bad");
        } finally {
          setBotState({ busy: false });
        }
      },
    });
    return () => bindBotRunner(null);
  }, []);

  return null;
}

