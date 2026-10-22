"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import type { MarketSnapshot, PerpVenueName } from "@/lib/planner/markets";
import { usePerpTrader } from "@/hooks/usePerpTrader";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { fmtUsd } from "@/lib/data";
import { rankForCarry, rankForFarming, scanPairs, type PairOpportunity } from "@/lib/neutralBot/opportunities";
import { DEFAULT_BOT_CONFIG, EMPTY_STATS, rotationFeeUsd, spreadAprPct, type BotConfig, type BotMode, type BotStats } from "@/lib/neutralBot/engine";
import { marketOn, runTick } from "@/lib/neutralBot/runner";
import { BOT_ANCHOR, onOpenNeutralBot, takePendingBot } from "@/lib/neutralBot/bus";

const VENUES: PerpVenueName[] = ["Hyperliquid", "Extended", "TxFlow"];
/** Seconds between two ticks (a background tab may run them less often). */
const TICK_SECONDS = 20;
/** Consecutive failed ticks before the bot stops itself. */
const MAX_FAILURES = 3;
const LOG_LINES = 30;

interface Saved {
  cfg: BotConfig;
  stats: BotStats;
  log: { at: number; text: string }[];
}

const storeKey = (address: string) => `meridian:neutralBot:${address.toLowerCase()}`;
function load(address: string): Saved | null {
  try {
    const raw = localStorage.getItem(storeKey(address));
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}
function save(address: string, s: Saved) {
  try {
    localStorage.setItem(storeKey(address), JSON.stringify(s));
  } catch {
    /* storage full or blocked: the bot keeps running, without memory across reloads */
  }
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
const muted = { fontSize: 11, margin: "4px 0 0" } as const;
const label = { fontSize: 11, display: "flex", flexDirection: "column", gap: 2 } as const;
const input = { fontSize: 12, width: "100%" } as const;

function OpportunityRow({ p, onUse }: { p: PairOpportunity; onUse: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, padding: "4px 0", borderBottom: "1px solid var(--color-divider)" }}>
      <strong style={{ minWidth: 44, fontFamily: "var(--font-heading)" }}>{p.base}</strong>
      <span className="text-muted" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        long {p.long.venue} · short {p.short.venue}
      </span>
      <span style={{ fontVariantNumeric: "tabular-nums", color: p.spreadAprPct > 0 ? "var(--risk-good)" : undefined }}>{pct(p.spreadAprPct)}/yr</span>
      {p.arbitrage && (
        <span style={{ fontSize: 9, padding: "1px 4px", borderRadius: 3, background: "var(--color-accent-100, #e6f4ea)", color: "var(--color-accent-700, #1e7a3c)" }} title="Spread pays the round-trip fees back within 3 days">
          ARB
        </span>
      )}
      <button type="button" className="btn btn-secondary" style={{ fontSize: 10, padding: "2px 8px" }} onClick={onUse}>
        Use
      </button>
    </div>
  );
}

/**
 * The neutral bot in Tools: live funding across Hyperliquid, Extended and
 * TxFlow (pairs ranked for farming or carry, funding arbitrage flagged), and
 * a bot that holds one delta-neutral pair and works it on its own — rotating
 * it for volume and open interest (points, airdrops) or holding it for the
 * funding spread (lib/neutralBot). It trades through the venues' trading keys
 * from this tab, while the tab stays open, inside the budgets set here.
 */
export function NeutralBotPanel() {
  const { address } = useAccount();
  // One bot per wallet: its config, totals and log come back with it.
  return address ? <NeutralBot key={address} address={address} /> : null;
}

function NeutralBot({ address }: { address: string }) {
  const trader = usePerpTrader();
  const markets = useQuery({
    queryKey: ["perp-markets"],
    queryFn: async () => (await (await fetch("/api/perp-markets")).json()) as MarketSnapshot,
    refetchInterval: 60_000,
    staleTime: 15_000,
  });

  const tradable = VENUES.filter((v) => trader.ready(v));
  const saved = useState(() => load(address))[0];
  const prefill = useState(() => takePendingBot())[0];
  const [rank, setRank] = useState<BotMode>("farm");
  const [cfg, setCfg] = useState<BotConfig>({ ...(saved?.cfg ?? { ...DEFAULT_BOT_CONFIG, base: "ETH", venues: ["Hyperliquid", "Extended"], notionalUsd: 50 }), ...prefill });
  const [stats, setStats] = useState<BotStats>(prefill ? EMPTY_STATS : (saved?.stats ?? EMPTY_STATS));
  const [log, setLog] = useState<Saved["log"]>(saved?.log ?? []);
  const [running, setRunning] = useState(false);
  const [confirming, setConfirming] = useState<"start" | "close" | null>(null);
  const [busy, setBusy] = useState(false);
  const failures = useRef(0);
  const inFlight = useRef(false);
  // The tick reads the latest config, totals and trader through a ref: it stays one stable callback, so a re-render never fires an extra tick.
  const live = useRef({ cfg, stats, trader });
  useEffect(() => {
    live.current = { cfg, stats, trader };
  });

  // The bot itself never restarts on its own after a reload: only its memory does.
  useEffect(() => {
    save(address, { cfg, stats, log });
  }, [address, cfg, stats, log]);

  // "Run it as a bot" from a plan: prefill, never start.
  useEffect(
    () =>
      onOpenNeutralBot((p) => {
        // A pair the bot holds stays its pair: no new settings until it is closed.
        if (running || live.current.stats.openedAt) return;
        setCfg((c) => ({ ...c, ...p }));
        setStats(EMPTY_STATS);
        document.getElementById(BOT_ANCHOR)?.scrollIntoView({ behavior: "smooth", block: "start" });
      }),
    [running],
  );

  const note = useCallback((text: string) => setLog((l) => [{ at: Date.now(), text }, ...l].slice(0, LOG_LINES)), []);

  const tick = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const snapshot = (await (await fetch("/api/perp-markets", { cache: "no-store" })).json()) as MarketSnapshot;
      const { cfg: c, stats: s, trader: t } = live.current;
      const r = await runTick(c, s, snapshot, t, Date.now());
      setStats(r.stats);
      // A quiet hold isn't news: log it only when the reason changes.
      setLog((l) => (r.action.kind === "wait" && l[0]?.text === r.message ? l : [{ at: Date.now(), text: r.message }, ...l].slice(0, LOG_LINES)));
      failures.current = r.error ? failures.current + 1 : 0;
      if (r.stats.stopReason) setRunning(false);
      else if (failures.current >= MAX_FAILURES) {
        setRunning(false);
        note(`Paused after ${MAX_FAILURES} failed ticks in a row: check the venues, then Start again.`);
      }
    } catch (err) {
      failures.current += 1;
      note(`Tick failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      if (failures.current >= MAX_FAILURES) setRunning(false);
    } finally {
      inFlight.current = false;
    }
  }, [note, setStats, setRunning, setLog]);

  useEffect(() => {
    if (!running) return;
    void tick();
    const id = setInterval(() => void tick(), TICK_SECONDS * 1000);
    return () => clearInterval(id);
  }, [running, tick]);

  // Leaving with the bot running: the browser asks first.
  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  const pairs = scanPairs(markets.data, { venues: tradable.length >= 2 ? tradable : VENUES });
  const ranked = (rank === "farm" ? rankForFarming(pairs, cfg.rotateMinutes / 60) : rankForCarry(pairs)).slice(0, 6);

  // The settings of a pair the bot holds can't change under it (paused included): close the pair first.
  const locked = running || !!stats.openedAt;
  const [va, vb] = cfg.venues;
  const qa = markets.data ? marketOn(markets.data, va, cfg.base) : undefined;
  const qb = markets.data ? marketOn(markets.data, vb, cfg.base) : undefined;
  const minNotional = qa && qb ? Math.max(qa.minQty * qa.markUsd, qa.minNotionalUsd, qb.minQty * qb.markUsd, qb.minNotionalUsd) * 1.02 : 0;
  const maxLev = qa && qb ? Math.min(qa.maxLeverage || 1, qb.maxLeverage || 1) : 1;
  const spread = qa && qb ? Math.max(spreadAprPct({ fundingHourly: { [va]: qa.fundingHourly, [vb]: qb.fundingHourly } }, va, vb) ?? 0, spreadAprPct({ fundingHourly: { [va]: qa.fundingHourly, [vb]: qb.fundingHourly } }, vb, va) ?? 0) : null;
  const rotationFee = qa && qb ? rotationFeeUsd(cfg, [qa.takerFee, qb.takerFee]) : null;
  const problems = [
    va === vb ? "Pick two different venues." : null,
    !trader.ready(va) || !trader.ready(vb) ? `Connect ${[va, vb].filter((v) => !trader.ready(v)).join(" and ")} first (Perp venues above).` : null,
    markets.data && (!qa || !qb) ? `${cfg.base} isn't listed on ${!qa ? va : vb}.` : null,
    qa && qb && cfg.notionalUsd < minNotional ? `Each leg must be at least ${fmtUsd(Math.ceil(minNotional))} (the markets' minimum order).` : null,
    qa && qb && cfg.leverage > maxLev ? `${maxLev}x is the most both markets allow.` : null,
    !(cfg.maxFeesUsd > 0) ? "Set a fee budget: the bot stops once it is spent." : null,
  ].filter((x): x is string => !!x);

  const set = <K extends keyof BotConfig>(k: K, v: BotConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const num = (v: string, min = 0) => Math.max(min, Number(v) || 0);

  const closeNow = async () => {
    setConfirming(null);
    setRunning(false);
    setBusy(true);
    try {
      const snapshot = (await (await fetch("/api/perp-markets", { cache: "no-store" })).json()) as MarketSnapshot;
      const r = await runTick({ ...cfg, maxCycles: Math.max(1, stats.cycles) }, { ...stats, cycles: Math.max(1, stats.cycles), stopReason: null }, snapshot, trader, Date.now());
      setStats({ ...r.stats, cycles: r.action.kind === "close" ? stats.cycles + 1 : stats.cycles, stopReason: "stopped by you" });
      note(r.action.kind === "stop" ? "Nothing to close: no pair open." : r.message);
    } catch (err) {
      note(`Close failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    setConfirming(null);
    setBusy(true);
    try {
      await trader.prepare([va, vb]);
      failures.current = 0;
      setStats((s) => ({ ...s, stopReason: null }));
      note(`Started: ${cfg.mode === "farm" ? `farming ${cfg.base}, rotating every ${cfg.rotateMinutes} min` : `carry on ${cfg.base}, opening above ${cfg.minSpreadAprPct}%/yr`}.`);
      setRunning(true);
    } catch (err) {
      note(`Couldn't start: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel-card" id={BOT_ANCHOR}>
      <h6 className="panel-card__title">Neutral bot · funding &amp; volume</h6>
      <p className="text-muted" style={{ ...muted, marginTop: 0 }}>
        Holds one delta-neutral pair (same quantity long on one venue, short on the other) and works it on its own: <strong>Farm</strong> rotates it for volume and open interest (points, airdrops), <strong>Carry</strong> holds it while the funding spread pays.
      </p>

      <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}>
        <span style={{ fontSize: 11, fontWeight: 600 }}>Opportunities now</span>
        <span style={{ flex: 1 }} />
        {(["farm", "carry"] as const).map((m) => (
          <button key={m} type="button" className={`btn ${rank === m ? "btn-primary" : "btn-secondary"}`} style={{ fontSize: 10, padding: "2px 8px" }} onClick={() => setRank(m)}>
            {m === "farm" ? "Cheapest volume" : "Best carry"}
          </button>
        ))}
      </div>
      {markets.isLoading ? (
        <p className="text-muted" style={muted}>Reading funding on the venues…</p>
      ) : ranked.length === 0 ? (
        <p className="text-muted" style={muted}>{rank === "carry" ? "No spread pays its fees back within a week right now." : "No liquid pair on two venues right now."}</p>
      ) : (
        <div style={{ marginTop: 4 }}>
          {ranked.map((p) => (
            <OpportunityRow
              key={`${p.base}-${p.long.venue}-${p.short.venue}`}
              p={p}
              onUse={() => {
                if (running || stats.openedAt) return;
                setCfg((c) => ({ ...c, base: p.base, venues: [p.long.venue, p.short.venue], mode: rank, notionalUsd: Math.max(c.notionalUsd, Math.ceil(p.minNotionalUsd * 1.05)), leverage: Math.min(c.leverage, p.maxLeverage) }));
                setStats(EMPTY_STATS);
              }}
            />
          ))}
          <p className="text-muted" style={{ ...muted, fontSize: 10 }}>Spread: funding a year the pair earns, long where funding is lowest. Fees: taker, open and close of both legs.</p>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 8, marginTop: 10, opacity: locked ? 0.6 : 1 }}>
        <label style={label}>
          Asset
          <input style={input} value={cfg.base} disabled={locked} onChange={(e) => set("base", e.target.value.toUpperCase().trim())} />
        </label>
        {[0, 1].map((i) => (
          <label key={i} style={label}>
            Venue {i + 1}
            <select
              style={input}
              disabled={locked}
              value={cfg.venues[i]}
              onChange={(e) => set("venues", (i === 0 ? [e.target.value, cfg.venues[1]] : [cfg.venues[0], e.target.value]) as [PerpVenueName, PerpVenueName])}
            >
              {VENUES.map((v) => (
                <option key={v} value={v}>
                  {v}
                  {trader.ready(v) ? "" : " (not connected)"}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label style={label}>
          Mode
          <select style={input} disabled={locked} value={cfg.mode} onChange={(e) => set("mode", e.target.value as BotMode)}>
            <option value="farm">Farm volume / OI</option>
            <option value="carry">Carry the spread</option>
          </select>
        </label>
        <label style={label}>
          Size per leg ($)
          <input style={input} type="number" min={1} disabled={locked} value={cfg.notionalUsd} onChange={(e) => set("notionalUsd", num(e.target.value, 1))} />
        </label>
        <label style={label}>
          Leverage
          <input style={input} type="number" min={1} max={maxLev} disabled={locked} value={cfg.leverage} onChange={(e) => set("leverage", Math.round(num(e.target.value, 1)))} />
        </label>
        {cfg.mode === "farm" ? (
          <label style={label}>
            Rotate every (min)
            <input style={input} type="number" min={5} disabled={locked} value={cfg.rotateMinutes} onChange={(e) => set("rotateMinutes", num(e.target.value, 5))} />
          </label>
        ) : (
          <>
            <label style={label}>
              Open above (%/yr)
              <input style={input} type="number" disabled={locked} value={cfg.minSpreadAprPct} onChange={(e) => set("minSpreadAprPct", Number(e.target.value) || 0)} />
            </label>
            <label style={label}>
              Close under (%/yr)
              <input style={input} type="number" disabled={locked} value={cfg.exitSpreadAprPct} onChange={(e) => set("exitSpreadAprPct", Number(e.target.value) || 0)} />
            </label>
          </>
        )}
        <label style={label}>
          Max cycles
          <input style={input} type="number" min={1} disabled={locked} value={cfg.maxCycles} onChange={(e) => set("maxCycles", Math.round(num(e.target.value, 1)))} />
        </label>
        <label style={label}>
          Fee budget ($)
          <input style={input} type="number" min={0} step={0.5} disabled={locked} value={cfg.maxFeesUsd} onChange={(e) => set("maxFeesUsd", num(e.target.value))} />
        </label>
        <label style={label}>
          Volume target ($, 0 = none)
          <input style={input} type="number" min={0} disabled={locked} value={cfg.volumeTargetUsd} onChange={(e) => set("volumeTargetUsd", num(e.target.value))} />
        </label>
      </div>

      {qa && qb && (
        <p className="text-muted" style={{ ...muted, fontVariantNumeric: "tabular-nums" }}>
          {cfg.base} spread now {spread === null ? "—" : `${pct(spread)}/yr`} · margin ~{fmtUsd((cfg.notionalUsd / Math.max(1, cfg.leverage)) * 1.02)} per venue · open interest {fmtUsd(cfg.notionalUsd * 2)}
          {cfg.mode === "farm" && rotationFee !== null && ` · each rotation makes ${fmtUsd(cfg.notionalUsd * 4)} of volume for ~${fmtUsd(rotationFee)} of fees`}
        </p>
      )}
      {problems.map((p) => (
        <p key={p} style={{ ...muted, color: "var(--risk-warning)" }}>
          {p}
        </p>
      ))}

      <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
        {running ? (
          <button type="button" className="btn btn-secondary" style={{ fontSize: 12 }} onClick={() => setRunning(false)}>
            Pause (keep the pair open)
          </button>
        ) : (
          <button type="button" className="btn btn-primary" style={{ fontSize: 12 }} disabled={busy || problems.length > 0} onClick={() => setConfirming("start")}>
            {stats.cycles > 0 || stats.openedAt ? "Resume the bot →" : "Start the bot →"}
          </button>
        )}
        <button type="button" className="btn btn-secondary" style={{ fontSize: 12 }} disabled={busy} onClick={() => setConfirming("close")}>
          Stop &amp; close the pair
        </button>
        {!running && !stats.openedAt && (stats.cycles > 0 || stats.volumeUsd > 0) && (
          <button type="button" className="btn btn-secondary" style={{ fontSize: 12 }} onClick={() => setStats(EMPTY_STATS)}>
            Reset totals
          </button>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginTop: 10, fontSize: 11 }}>
        {[
          ["Status", running ? "Running" : stats.stopReason ? "Stopped" : "Idle"],
          ["Volume", fmtUsd(stats.volumeUsd)],
          ["Fees (est.)", fmtUsd(stats.feesUsd)],
          ["Cycles", String(stats.cycles)],
        ].map(([k, v]) => (
          <div key={k}>
            <div className="text-muted" style={{ fontSize: 10 }}>
              {k}
            </div>
            <div style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{v}</div>
          </div>
        ))}
      </div>
      {stats.stopReason && <p style={{ ...muted, color: "var(--risk-warning)" }}>Stopped: {stats.stopReason}.</p>}
      {!running && stats.openedAt && <p className="text-muted" style={muted}>Paused with the {cfg.base} pair open: Resume, or Stop &amp; close it to change the settings.</p>}
      {running && <p className="text-muted" style={muted}>Runs from this tab: keep it open (a background tab ticks less often). Positions stay on the venues if you close it; check Risk → Perp positions.</p>}

      {log.length > 0 && (
        <details style={{ marginTop: 8 }} open={running}>
          <summary style={{ fontSize: 11, cursor: "pointer" }}>Bot log</summary>
          <div style={{ maxHeight: 180, overflowY: "auto", fontSize: 10, fontFamily: "var(--font-mono, monospace)" }}>
            {log.map((l, i) => (
              <div key={`${l.at}-${i}`} className="text-muted" style={{ padding: "2px 0" }}>
                {new Date(l.at).toLocaleTimeString()} · {l.text}
              </div>
            ))}
          </div>
        </details>
      )}

      <ConfirmDialog
        open={confirming === "start"}
        title={`Start the ${cfg.base} neutral bot`}
        body={
          <div>
            <p style={{ marginBottom: 6 }}>
              {cfg.mode === "farm"
                ? `Opens ${fmtUsd(cfg.notionalUsd)} long and short ${cfg.base} on ${va} and ${vb} at ${cfg.leverage}x (long where funding is cheapest), then closes and reopens the pair every ${cfg.rotateMinutes} minutes for volume and open interest.`
                : `Opens ${fmtUsd(cfg.notionalUsd)} long and short ${cfg.base} on ${va} and ${vb} at ${cfg.leverage}x when the funding spread passes ${cfg.minSpreadAprPct}%/yr, and closes it under ${cfg.exitSpreadAprPct}%/yr.`}
            </p>
            <p style={{ marginBottom: 6 }}>
              Stops on its own after {cfg.maxCycles} cycles or {fmtUsd(cfg.maxFeesUsd)} of fees{cfg.volumeTargetUsd > 0 ? `, or at ${fmtUsd(cfg.volumeTargetUsd)} of volume` : ""}, closing the pair first. A failed second leg is unwound at once; a leg it can&apos;t close stops the bot.
            </p>
            <p>Orders are market (taker) orders sent by the venues&apos; trading keys from this tab, without a wallet popup each time. Each leg can be liquidated on its own venue if the price moves far: at {cfg.leverage}x, about {Math.round(100 / Math.max(1, cfg.leverage))}% against it.</p>
          </div>
        }
        confirmLabel="Start trading"
        warning="Real funds. The bot trades automatically while this tab is open."
        onConfirm={() => void start()}
        onCancel={() => setConfirming(null)}
      />
      <ConfirmDialog
        open={confirming === "close"}
        title={`Close the ${cfg.base} pair`}
        body={<p>Stops the bot and closes both {cfg.base} legs on {va} and {vb} at market (reduce-only).</p>}
        confirmLabel="Stop and close"
        warning="Market orders: expect fees and a little slippage."
        onConfirm={() => void closeNow()}
        onCancel={() => setConfirming(null)}
      />
    </section>
  );
}
