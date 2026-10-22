"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MarketSnapshot, PerpVenueName } from "@/lib/planner/markets";
import { usePerpTrader } from "@/hooks/usePerpTrader";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { BotVolumeChart } from "@/components/BotVolumeChart";
import { VENUE_ANCHOR } from "@/components/PerpVenuesSummary";
import { rankForCarry, rankForFarming, scanPairs, type PairOpportunity } from "@/lib/neutralBot/opportunities";
import { EMPTY_STATS, openPnlUsd, rotationFeeUsd, spreadAprPct, type BotConfig, type BotMode } from "@/lib/neutralBot/engine";
import { marketOn } from "@/lib/neutralBot/runner";
import { botRunner, getBotState, setBotState, useBotState } from "@/lib/neutralBot/store";
import { botHealth, volumeLast24h } from "@/lib/neutralBot/health";
import { BOT_ANCHOR, onOpenNeutralBot, openToolsAt, takePendingBot } from "@/lib/neutralBot/bus";

const VENUES: PerpVenueName[] = ["Hyperliquid", "Extended", "TxFlow"];
const ANCHOR_OF: Record<PerpVenueName, string> = { Hyperliquid: VENUE_ANCHOR.hyperliquid, Extended: VENUE_ANCHOR.extended, TxFlow: VENUE_ANCHOR.txflow };

/** Dollars with cents under $1,000 ($0.09, $12.40, $1,204). */
const usd = (n: number, signed = false) => {
  const sign = n < 0 ? "−" : signed && n > 0 ? "+" : "";
  const a = Math.abs(n);
  return `${sign}$${a >= 1000 ? Math.round(a).toLocaleString("en-US") : a.toFixed(2)}`;
};
const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
const px = (n: number) => (n >= 1000 ? Math.round(n).toLocaleString("en-US") : n >= 1 ? n.toFixed(2) : n.toPrecision(4));
const clock = (t: number) => new Date(t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const hm = (t: number) => new Date(t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
const duration = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
};

/** Ticks once a second while mounted: countdowns and "x s ago" stay live. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "good" | "bad" }) {
  return (
    <div className="bot-kpi" title={hint}>
      <div className="bot-kpi__label">{label}</div>
      <div className={`bot-kpi__value${tone ? ` bot-kpi__value--${tone}` : ""}`}>{value}</div>
      {hint && <div className="bot-kpi__hint">{hint}</div>}
    </div>
  );
}

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <label className={`bot-field${wide ? " bot-field--wide" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function Opportunity({ p, onUse, disabled }: { p: PairOpportunity; onUse: () => void; disabled: boolean }) {
  return (
    <div className="bot-opp">
      <strong className="bot-opp__base">{p.base}</strong>
      <span className="bot-opp__route text-muted">
        long {p.long.venue} · short {p.short.venue}
      </span>
      <span className="bot-opp__spread" style={{ color: p.spreadAprPct > 0 ? "var(--risk-good)" : undefined }}>
        {pct(p.spreadAprPct)}/yr
      </span>
      {p.arbitrage && (
        <span className="bot-tag" title="The spread pays the round-trip fees back within 3 days">
          ARB
        </span>
      )}
      <button type="button" className="btn btn-secondary bot-opp__use" disabled={disabled} onClick={onUse}>
        Use
      </button>
    </div>
  );
}

/**
 * The neutral bot, full view: what it is doing right now (one status line,
 * green when all is well), the live totals (volume, fees, funding, open
 * interest, the hedge's PnL), the volume curve, the two legs, the schedule,
 * then the settings, the opportunities across venues and the log. The bot
 * runs in components/NeutralBotHost whatever view is open.
 */
export function NeutralBotView() {
  const s = useBotState();
  const now = useNow();
  const trader = usePerpTrader();
  const markets = useQuery({
    queryKey: ["perp-markets"],
    queryFn: async () => (await (await fetch("/api/perp-markets")).json()) as MarketSnapshot,
    refetchInterval: 60_000,
    staleTime: 15_000,
  });
  const [rank, setRank] = useState<BotMode>("farm");
  const [confirming, setConfirming] = useState<"start" | "close" | null>(null);
  const [showSettings, setShowSettings] = useState(true);

  const { cfg, stats, running, busy, view } = s;
  // The settings of a pair the bot holds can't change under it (paused included): close the pair first.
  const locked = running || !!stats.openedAt;

  // "Run it as a bot" from a plan: prefill, never start.
  useEffect(() => {
    const apply = (p: Partial<BotConfig>) => {
      const st = getBotState();
      if (st.running || st.stats.openedAt) return;
      setBotState({ cfg: { ...st.cfg, ...p }, stats: EMPTY_STATS });
    };
    const pending = takePendingBot();
    if (pending) apply(pending);
    return onOpenNeutralBot(apply);
  }, []);

  // Without a wallet the dashboard still shows the opportunities and the settings; only Start waits for one.
  const health = trader.address ? botHealth(s, now) : { tone: "idle" as const, label: "No wallet", detail: "Connect a wallet to run it: the bot trades your own Hyperliquid, Extended and TxFlow accounts.", deltaPct: null };
  const tradable = VENUES.filter((v) => trader.ready(v));
  const pairs = scanPairs(markets.data, { venues: tradable.length >= 2 ? tradable : VENUES });
  const ranked = (rank === "farm" ? rankForFarming(pairs, (cfg.holdMinMinutes + cfg.holdMaxMinutes) / 120) : rankForCarry(pairs)).slice(0, 8);

  const [va, vb] = cfg.venues;
  const qa = markets.data ? marketOn(markets.data, va, cfg.base) : undefined;
  const qb = markets.data ? marketOn(markets.data, vb, cfg.base) : undefined;
  const minNotional = qa && qb ? Math.max(qa.minQty * qa.markUsd, qa.minNotionalUsd, qb.minQty * qb.markUsd, qb.minNotionalUsd) * 1.02 : 0;
  const maxLev = qa && qb ? Math.min(qa.maxLeverage || 1, qb.maxLeverage || 1) : 50;
  const fh = qa && qb ? { [va]: qa.fundingHourly, [vb]: qb.fundingHourly } : null;
  const spreadNow = fh ? Math.max(spreadAprPct({ fundingHourly: fh }, va, vb) ?? 0, spreadAprPct({ fundingHourly: fh }, vb, va) ?? 0) : null;
  const cycleFee = qa && qb ? rotationFeeUsd(cfg, [qa.takerFee, qb.takerFee]) : null;
  const problems = [
    !trader.address ? "Connect a wallet first." : null,
    va === vb ? "Pick two different venues." : null,
    trader.address && (!trader.ready(va) || !trader.ready(vb)) ? `Connect ${[va, vb].filter((v) => !trader.ready(v)).join(" and ")} first (Tools → Perp venues).` : null,
    markets.data && (!qa || !qb) ? `${cfg.base} isn't listed on ${!qa ? va : vb}.` : null,
    qa && qb && cfg.notionalUsd * (1 - cfg.sizeJitterPct / 100) < minNotional ? `Each leg must stay over ${usd(Math.ceil(minNotional))} (the markets' minimum), jitter included.` : null,
    qa && qb && cfg.leverage > maxLev ? `${maxLev}x is the most both markets allow.` : null,
    cfg.holdMaxMinutes < cfg.holdMinMinutes || cfg.gapMaxMinutes < cfg.gapMinMinutes ? "Each range needs its maximum at or above its minimum." : null,
    !(cfg.maxFeesUsd > 0) ? "Set a fee budget: the bot stops once it is spent." : null,
  ].filter((x): x is string => !!x);

  const set = <K extends keyof BotConfig>(k: K, v: BotConfig[K]) => setBotState((st) => ({ cfg: { ...st.cfg, [k]: v } }));
  const num = (v: string, min = 0) => Math.max(min, Number(v) || 0);

  // Live figures.
  const pnl = view ? openPnlUsd(stats.legs, view.marks) : null;
  const oi = stats.legs.reduce((sum, l) => sum + l.qty * (view?.marks[l.venue] ?? l.entryPx), 0);
  const net = stats.fundingUsd - stats.feesUsd;
  const costPer10k = stats.volumeUsd > 0 ? ((stats.feesUsd - stats.fundingUsd) / stats.volumeUsd) * 10_000 : null;
  const day = volumeLast24h(stats.history, now);
  const nextTick = s.nextTickAt ? Math.max(0, Math.ceil((s.nextTickAt - now) / 1000)) : null;

  return (
    <section className="bot-view" id={BOT_ANCHOR}>
      <BotHero health={health}>
        <div className="bot-hero__actions">
          {running ? (
            <button type="button" className="btn btn-secondary" onClick={() => setBotState({ running: false, nextTickAt: null })}>
              Pause
            </button>
          ) : (
            <button type="button" className="btn btn-primary" disabled={busy || problems.length > 0} onClick={() => setConfirming("start")}>
              {stats.openedAt || stats.cycles > 0 ? "Resume →" : "Start the bot →"}
            </button>
          )}
          <button type="button" className="btn btn-secondary" disabled={busy || !trader.address} onClick={() => setConfirming("close")}>
            Stop &amp; close
          </button>
        </div>
      </BotHero>

      {s.needsMargin?.length ? (
        <div className="bot-callout bot-callout--warn">
          {s.needsMargin.map((m) => (
            <div key={m.venue} className="bot-callout__row">
              <span>
                <strong>{m.venue}</strong> needs about {usd(Math.max(5, m.neededUsd - m.freeUsd + 1))} more margin ({usd(m.freeUsd)} free, {usd(m.neededUsd)} a leg).
              </span>
              <button type="button" className="btn btn-primary" onClick={() => openToolsAt(ANCHOR_OF[m.venue])}>
                Deposit on {m.venue} →
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="bot-kpis">
        <Kpi label="Volume made" value={usd(stats.volumeUsd)} hint={`${usd(day)} in the last 24 h`} />
        <Kpi label="Fees paid" value={usd(stats.feesUsd)} hint={cfg.maxFeesUsd > 0 ? `budget ${usd(cfg.maxFeesUsd)}` : undefined} />
        <Kpi label="Funding (est.)" value={usd(stats.fundingUsd, true)} tone={stats.fundingUsd > 0 ? "good" : stats.fundingUsd < 0 ? "bad" : undefined} hint="earned while the pairs were held" />
        <Kpi label="Net cost" value={usd(-net, false)} hint={costPer10k !== null ? `${usd(costPer10k)} per $10k of volume` : "fees − funding"} />
        <Kpi label="Open interest" value={usd(oi)} hint={stats.legs.length ? "both legs, at mark" : "no pair open"} />
        <Kpi label="Hedge PnL" value={pnl === null ? "—" : usd(pnl, true)} tone={pnl !== null ? (pnl >= 0 ? "good" : "bad") : undefined} hint="long + short, should stay near 0" />
        <Kpi label="Cycles" value={`${stats.cycles}${cfg.maxCycles > 0 ? ` / ${cfg.maxCycles}` : ""}`} hint={stats.startedAt ? `running since ${duration(now - stats.startedAt)}` : undefined} />
        <Kpi label="Next check" value={running ? (nextTick === null ? "now" : `${nextTick}s`) : "—"} hint={view ? `last ${clock(view.at)}` : undefined} />
      </div>

      <div className="bot-grid">
        <div className="bot-card bot-card--chart">
          <div className="bot-card__head">
            <h6>Volume made by the bot</h6>
            <span className="text-muted">{usd(stats.volumeUsd)} total</span>
          </div>
          <BotVolumeChart history={stats.history} now={now} />
        </div>

        <div className="bot-card">
          <div className="bot-card__head">
            <h6>The pair</h6>
            <span className="text-muted">
              {cfg.base} · {cfg.leverage}x · {cfg.mode === "farm" ? "farm" : "carry"}
            </span>
          </div>
          {stats.legs.length === 0 ? (
            <p className="text-muted bot-empty">
              {stats.reopenAt && stats.reopenAt > now ? `Flat until ${hm(stats.reopenAt)}: the next pair opens at a random time.` : "No pair open."}
            </p>
          ) : (
            <table className="bot-legs">
              <thead>
                <tr>
                  <th>Venue</th>
                  <th>Side</th>
                  <th>Size</th>
                  <th>Entry</th>
                  <th>Mark</th>
                  <th>PnL</th>
                  <th>Funding</th>
                </tr>
              </thead>
              <tbody>
                {stats.legs.map((l) => {
                  const mark = view?.marks[l.venue];
                  const legPnl = mark ? (l.side === "long" ? mark - l.entryPx : l.entryPx - mark) * l.qty : null;
                  const f = view?.fundingHourly[l.venue];
                  const carry = f === undefined ? null : (l.side === "short" ? f : -f) * 8760 * 100;
                  return (
                    <tr key={l.venue}>
                      <td>{l.venue}</td>
                      <td style={{ color: l.side === "long" ? "var(--risk-good)" : "var(--risk-serious)", fontWeight: 600 }}>{l.side.toUpperCase()}</td>
                      <td>{l.qty}</td>
                      <td>{px(l.entryPx)}</td>
                      <td>{mark ? px(mark) : "—"}</td>
                      <td style={{ color: legPnl === null ? undefined : legPnl >= 0 ? "var(--risk-good)" : "var(--risk-serious)" }}>{legPnl === null ? "—" : usd(legPnl, true)}</td>
                      <td>{carry === null ? "—" : `${pct(carry)}/yr`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div className="bot-schedule text-muted">
            {cfg.mode === "farm" ? (
              <>
                Each pair held {cfg.holdMinMinutes}–{cfg.holdMaxMinutes} min
                {cfg.gapMaxMinutes > 0 ? `, then flat ${cfg.gapMinMinutes}–${cfg.gapMaxMinutes} min` : ", then rotated at once"}, size {usd(cfg.notionalUsd)} ± {cfg.sizeJitterPct}%.
                {stats.closeAt && stats.openedAt ? ` This one closes at ${hm(stats.closeAt)}.` : ""}
              </>
            ) : (
              <>Opens above {cfg.minSpreadAprPct}%/yr of spread, closes under {cfg.exitSpreadAprPct}%/yr.</>
            )}
            {view?.heldSpreadAprPct !== null && view?.heldSpreadAprPct !== undefined && ` Spread held now ${pct(view.heldSpreadAprPct)}/yr.`}
          </div>
        </div>

        <div className="bot-card">
          <div className="bot-card__head">
            <h6>Settings</h6>
            <button type="button" className="btn btn-secondary bot-mini" onClick={() => setShowSettings((x) => !x)}>
              {showSettings ? "Hide" : "Show"}
            </button>
          </div>
          {locked && <p className="text-muted bot-empty">{running ? "Pause the bot to change its settings." : "Close the pair (Stop & close) to change the settings."}</p>}
          {showSettings && (
            <>
              <div className="bot-fields" style={{ opacity: locked ? 0.55 : 1 }}>
                <Field label="Asset">
                  <input value={cfg.base} disabled={locked} onChange={(e) => set("base", e.target.value.toUpperCase().trim())} />
                </Field>
                {[0, 1].map((i) => (
                  <Field key={i} label={`Venue ${i + 1}`}>
                    <select disabled={locked} value={cfg.venues[i]} onChange={(e) => set("venues", (i === 0 ? [e.target.value, cfg.venues[1]] : [cfg.venues[0], e.target.value]) as [PerpVenueName, PerpVenueName])}>
                      {VENUES.map((v) => (
                        <option key={v} value={v}>
                          {v}
                          {trader.ready(v) ? "" : " (not connected)"}
                        </option>
                      ))}
                    </select>
                  </Field>
                ))}
                <Field label="Mode">
                  <select disabled={locked} value={cfg.mode} onChange={(e) => set("mode", e.target.value as BotMode)}>
                    <option value="farm">Farm volume / OI</option>
                    <option value="carry">Carry the spread</option>
                  </select>
                </Field>
                <Field label="Size per leg ($)">
                  <input type="number" min={1} disabled={locked} value={cfg.notionalUsd} onChange={(e) => set("notionalUsd", num(e.target.value, 1))} />
                </Field>
                <Field label="Leverage">
                  <input type="number" min={1} max={maxLev} disabled={locked} value={cfg.leverage} onChange={(e) => set("leverage", Math.round(num(e.target.value, 1)))} />
                </Field>
                {cfg.mode === "farm" ? (
                  <>
                    <Field label="Hold each pair (min) — from">
                      <input type="number" min={5} disabled={locked} value={cfg.holdMinMinutes} onChange={(e) => set("holdMinMinutes", num(e.target.value, 5))} />
                    </Field>
                    <Field label="to">
                      <input type="number" min={5} disabled={locked} value={cfg.holdMaxMinutes} onChange={(e) => set("holdMaxMinutes", num(e.target.value, 5))} />
                    </Field>
                    <Field label="Pause between pairs (min) — from">
                      <input type="number" min={0} disabled={locked} value={cfg.gapMinMinutes} onChange={(e) => set("gapMinMinutes", num(e.target.value))} />
                    </Field>
                    <Field label="to">
                      <input type="number" min={0} disabled={locked} value={cfg.gapMaxMinutes} onChange={(e) => set("gapMaxMinutes", num(e.target.value))} />
                    </Field>
                    <Field label="Vary the size (± %)">
                      <input type="number" min={0} max={50} disabled={locked} value={cfg.sizeJitterPct} onChange={(e) => set("sizeJitterPct", Math.min(50, num(e.target.value)))} />
                    </Field>
                  </>
                ) : (
                  <>
                    <Field label="Open above (%/yr)">
                      <input type="number" disabled={locked} value={cfg.minSpreadAprPct} onChange={(e) => set("minSpreadAprPct", Number(e.target.value) || 0)} />
                    </Field>
                    <Field label="Close under (%/yr)">
                      <input type="number" disabled={locked} value={cfg.exitSpreadAprPct} onChange={(e) => set("exitSpreadAprPct", Number(e.target.value) || 0)} />
                    </Field>
                  </>
                )}
                <Field label="Max cycles">
                  <input type="number" min={1} disabled={locked} value={cfg.maxCycles} onChange={(e) => set("maxCycles", Math.round(num(e.target.value, 1)))} />
                </Field>
                <Field label="Fee budget ($)">
                  <input type="number" min={0} step={0.5} disabled={locked} value={cfg.maxFeesUsd} onChange={(e) => set("maxFeesUsd", num(e.target.value))} />
                </Field>
                <Field label="Volume target ($, 0 = none)">
                  <input type="number" min={0} disabled={locked} value={cfg.volumeTargetUsd} onChange={(e) => set("volumeTargetUsd", num(e.target.value))} />
                </Field>
              </div>
              {qa && qb && (
                <p className="text-muted bot-preview">
                  {cfg.base} spread now {spreadNow === null ? "—" : `${pct(spreadNow)}/yr`} · margin ~{usd((cfg.notionalUsd / Math.max(1, cfg.leverage)) * 1.02)} per venue · open interest {usd(cfg.notionalUsd * 2)}
                  {cycleFee !== null && ` · each cycle makes ${usd(cfg.notionalUsd * 4)} of volume for ~${usd(cycleFee)} of fees`}
                </p>
              )}
              {problems.map((p) => (
                <p key={p} className="bot-problem">
                  {p}
                </p>
              ))}
              {!running && !stats.openedAt && (stats.cycles > 0 || stats.volumeUsd > 0) && (
                <button type="button" className="btn btn-secondary bot-mini" onClick={() => setBotState({ stats: EMPTY_STATS })}>
                  Reset totals
                </button>
              )}
            </>
          )}
        </div>

        <div className="bot-card">
          <div className="bot-card__head">
            <h6>Opportunities now</h6>
            <div className="bot-seg">
              {(["farm", "carry"] as const).map((m) => (
                <button key={m} type="button" className={`btn ${rank === m ? "btn-primary" : "btn-secondary"} bot-mini`} onClick={() => setRank(m)}>
                  {m === "farm" ? "Cheapest volume" : "Best carry"}
                </button>
              ))}
            </div>
          </div>
          {markets.isLoading ? (
            <p className="text-muted bot-empty">Reading funding on the venues…</p>
          ) : ranked.length === 0 ? (
            <p className="text-muted bot-empty">{rank === "carry" ? "No spread pays its fees back within a week right now." : "No liquid pair on two venues right now."}</p>
          ) : (
            ranked.map((p) => (
              <Opportunity
                key={`${p.base}-${p.long.venue}-${p.short.venue}`}
                p={p}
                disabled={locked}
                onUse={() =>
                  setBotState((st) => ({
                    cfg: { ...st.cfg, base: p.base, venues: [p.long.venue, p.short.venue], mode: rank, notionalUsd: Math.max(st.cfg.notionalUsd, Math.ceil(p.minNotionalUsd * 1.25)), leverage: Math.min(st.cfg.leverage, p.maxLeverage) },
                    stats: EMPTY_STATS,
                  }))
                }
              />
            ))
          )}
          <p className="text-muted bot-footnote">Spread: funding a year the pair earns, long where funding is lowest. ARB: the spread pays the taker fees of a round trip back within 3 days.</p>
        </div>
      </div>

      <div className="bot-card">
        <div className="bot-card__head">
          <h6>Activity</h6>
          <span className="text-muted">{s.log.length} events</span>
        </div>
        {s.log.length === 0 ? (
          <p className="text-muted bot-empty">Nothing yet.</p>
        ) : (
          <div className="bot-log">
            {s.log.slice(0, 80).map((l, i) => (
              <div key={`${l.at}-${i}`} className={`bot-log__line bot-log__line--${l.tone}`}>
                <span className="bot-log__time">{clock(l.at)}</span>
                <span>{l.text}</span>
              </div>
            ))}
          </div>
        )}
        <p className="text-muted bot-footnote">The bot runs from this browser tab, through the venues&apos; trading keys: keep it open (a background tab checks less often). Positions stay on the venues if the tab closes; see Risk → Perp positions.</p>
      </div>

      <ConfirmDialog
        open={confirming === "start"}
        title={`Start the ${cfg.base} neutral bot`}
        body={
          <div>
            <p style={{ marginBottom: 6 }}>
              {cfg.mode === "farm"
                ? `Opens about ${usd(cfg.notionalUsd)} long and short ${cfg.base} on ${va} and ${vb} at ${cfg.leverage}x (long where funding is cheapest), holds each pair ${cfg.holdMinMinutes}–${cfg.holdMaxMinutes} min, then ${cfg.gapMaxMinutes > 0 ? `waits ${cfg.gapMinMinutes}–${cfg.gapMaxMinutes} min and opens the next` : "rotates it"}, at random times and sizes (± ${cfg.sizeJitterPct}%).`
                : `Opens ${usd(cfg.notionalUsd)} long and short ${cfg.base} on ${va} and ${vb} at ${cfg.leverage}x when the funding spread passes ${cfg.minSpreadAprPct}%/yr, and closes it under ${cfg.exitSpreadAprPct}%/yr.`}
            </p>
            <p style={{ marginBottom: 6 }}>
              Stops on its own after {cfg.maxCycles} cycles or {usd(cfg.maxFeesUsd)} of fees{cfg.volumeTargetUsd > 0 ? `, or at ${usd(cfg.volumeTargetUsd)} of volume` : ""}, closing the pair first. A failed second leg is unwound at once; a leg it can&apos;t close stops the bot.
            </p>
            <p>Market (taker) orders sent by the venues&apos; trading keys from this tab, without a wallet popup each time. Each leg can be liquidated on its own venue if the price moves far: at {cfg.leverage}x, about {Math.round(100 / Math.max(1, cfg.leverage))}% against it.</p>
          </div>
        }
        confirmLabel="Start trading"
        warning="Real funds. The bot trades automatically while this tab is open."
        onConfirm={() => {
          setConfirming(null);
          void botRunner()?.start();
        }}
        onCancel={() => setConfirming(null)}
      />
      <ConfirmDialog
        open={confirming === "close"}
        title={`Close the ${cfg.base} pair`}
        body={<p>Stops the bot and closes both {cfg.base} legs on {va} and {vb} at market (reduce-only). A position the bot didn&apos;t open is never touched.</p>}
        confirmLabel="Stop and close"
        warning="Market orders: expect fees and a little slippage."
        onConfirm={() => {
          setConfirming(null);
          void botRunner()?.closeNow();
        }}
        onCancel={() => setConfirming(null)}
      />
    </section>
  );
}

function BotHero({ health, children }: { health: ReturnType<typeof botHealth>; children?: React.ReactNode }) {
  return (
    <div className={`bot-hero bot-hero--${health.tone}`}>
      <div className="bot-hero__text">
        <div className="bot-hero__title">
          <h2>Neutral bot</h2>
          <span className={`bot-pill bot-pill--${health.tone}`}>
            <span className="bot-pill__dot" aria-hidden />
            {health.label}
          </span>
        </div>
        <p className="bot-hero__sub">Farm points and airdrops with delta-neutral volume and open interest across Hyperliquid, Extended and TxFlow, or earn the funding spread. No price exposure once both legs fill.</p>
        <p className="bot-hero__status" role="status" aria-live="polite">
          {health.detail}
        </p>
      </div>
      {children}
    </div>
  );
}
