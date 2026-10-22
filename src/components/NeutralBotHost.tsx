"use client";

import { useEffect, useRef } from "react";
import { useAccount } from "wagmi";
import type { MarketSnapshot } from "@/lib/planner/markets";
import { usePerpTrader } from "@/hooks/usePerpTrader";
import { runTick } from "@/lib/neutralBot/runner";
import { makerVenueOf } from "@/lib/neutralBot/engine";
import { bindBotRunner, botLog, getBotState, loadBotFor, setBotState, useBotState } from "@/lib/neutralBot/store";

/** Seconds between two ticks (a background tab may run them less often). */
export const TICK_SECONDS = 20;
/** Consecutive failed ticks before the bot pauses itself. */
const MAX_FAILURES = 3;

const errText = (err: unknown) => (err instanceof Error ? err.message.split("\n")[0] : String(err));
const fetchSnapshot = async () => (await (await fetch("/api/perp-markets", { cache: "no-store" })).json()) as MarketSnapshot;

/**
 * The neutral bot's engine room, mounted once for the page: it loads the
 * wallet's bot, runs a tick every TICK_SECONDS while the bot is on (whatever
 * view the user is in), logs what each tick did, and binds Start and
 * "Stop & close" for the dashboard. Renders nothing.
 */
export function NeutralBotHost() {
  const { address } = useAccount();
  const trader = usePerpTrader();
  const traderRef = useRef(trader);
  useEffect(() => {
    traderRef.current = trader;
  });
  const { running } = useBotState();
  const inFlight = useRef(false);

  useEffect(() => {
    loadBotFor(address ?? null);
  }, [address]);

  // One tick: read, decide, trade, account, log.
  const tick = useRef(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const { cfg, stats, log } = getBotState();
      const r = await runTick(cfg, stats, await fetchSnapshot(), traderRef.current, Date.now());
      const failures = r.error ? getBotState().failures + 1 : 0;
      setBotState({ stats: r.stats, view: r.view ?? getBotState().view, needsMargin: r.needsMargin ?? null, failures });
      const traded = r.action.kind !== "wait" && r.action.kind !== "stop" && !r.needsMargin;
      const tone = r.error ? "bad" : r.needsMargin ? "warn" : traded ? "ok" : "info";
      // A quiet hold or the same wait isn't news: log it only when the message changes.
      if (traded || r.error || log[0]?.text !== r.message) botLog(r.message, tone);
      if (r.stats.stopReason) {
        setBotState({ running: false, nextTickAt: null });
      } else if (failures >= MAX_FAILURES) {
        setBotState({ running: false, nextTickAt: null });
        botLog(`Paused after ${MAX_FAILURES} failed ticks in a row: check the venues, then Resume.`, "bad");
      }
    } catch (err) {
      const failures = getBotState().failures + 1;
      setBotState({ failures });
      botLog(`Tick failed: ${errText(err)}`, "bad");
      if (failures >= MAX_FAILURES) setBotState({ running: false, nextTickAt: null });
    } finally {
      inFlight.current = false;
    }
  });

  // The loop: a tick now, then every TICK_SECONDS while running.
  useEffect(() => {
    if (!running) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      await tick.current();
      if (stop || !getBotState().running) return;
      setBotState({ nextTickAt: Date.now() + TICK_SECONDS * 1000 });
      timer = setTimeout(() => void loop(), TICK_SECONDS * 1000);
    };
    void loop();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [running]);

  // Leaving with the bot on: the browser asks first.
  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  useEffect(() => {
    bindBotRunner({
      start: async () => {
        const { cfg, stats } = getBotState();
        setBotState({ busy: true });
        try {
          await traderRef.current.prepare(cfg.venues);
          setBotState({ failures: 0, stats: { ...stats, stopReason: null, startedAt: stats.startedAt ?? Date.now() }, running: true });
          botLog(
            (cfg.mode === "farm"
              ? `Started: farming ${cfg.base} on ${cfg.venues.join(" + ")}, each pair held ${cfg.holdMinMinutes}–${cfg.holdMaxMinutes} min${cfg.gapMaxMinutes > 0 ? `, ${cfg.gapMinMinutes}–${cfg.gapMaxMinutes} min apart` : ""}.`
              : `Started: carry on ${cfg.base}, opening above ${cfg.minSpreadAprPct}%/yr.`) + (makerVenueOf(cfg) ? " Orders: maker on Hyperliquid, the other leg at market." : " Orders: market on both venues."),
            "ok",
          );
        } catch (err) {
          botLog(`Couldn't start: ${errText(err)}`, "bad");
        } finally {
          setBotState({ busy: false });
        }
      },
      closeNow: async () => {
        setBotState({ running: false, nextTickAt: null, busy: true });
        try {
          const { cfg, stats } = getBotState();
          // The budget path closes a held pair (or a lone leg of it), and never touches a position the bot didn't open.
          const done = Math.max(1, stats.cycles);
          const r = await runTick({ ...cfg, maxCycles: done }, { ...stats, cycles: done, stopReason: null }, await fetchSnapshot(), traderRef.current, Date.now());
          setBotState({ stats: { ...r.stats, cycles: r.action.kind === "close" ? stats.cycles + 1 : stats.cycles, stopReason: "stopped by you" }, view: r.view ?? null, needsMargin: null });
          botLog(r.action.kind === "stop" ? "Nothing to close: no pair open." : r.message, r.error ? "bad" : "ok");
        } catch (err) {
          botLog(`Close failed: ${errText(err)}`, "bad");
        } finally {
          setBotState({ busy: false });
        }
      },
    });
    return () => bindBotRunner(null);
  }, []);

  return null;
}

