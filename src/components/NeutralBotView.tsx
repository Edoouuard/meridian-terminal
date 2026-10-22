"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MarketSnapshot, PerpVenueName } from "@/lib/planner/markets";
import { usePerpTrader } from "@/hooks/usePerpTrader";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { BotVolumeChart } from "@/components/BotVolumeChart";
import { BotFunds, VENUE_ANCHOR_OF, useVenueFunds } from "@/components/BotFunds";
import { rankForCarry, rankForFarming, scanPairs, type PairOpportunity } from "@/lib/neutralBot/opportunities";
import { EMPTY_STATS, openPnlUsd, spreadAprPct, type BotConfig, type BotMode } from "@/lib/neutralBot/engine";
import { marketOn } from "@/lib/neutralBot/runner";
import { botRunner, getBotState, setBotState, useBotState } from "@/lib/neutralBot/store";
import { botHealth, volumeLast24h } from "@/lib/neutralBot/health";
import { dayEstimate, feesPer10kUsd, INTENSITY, intensityOf, maxPerSideUsd, type Intensity } from "@/lib/neutralBot/guide";
import { marginNeededUsd } from "@/lib/integrations/hyperliquidTrade";
import { BOT_ANCHOR, onOpenNeutralBot, openToolsAt, takePendingBot } from "@/lib/neutralBot/bus";

const VENUES: PerpVenueName[] = ["Hyperliquid", "Extended", "TxFlow"];
const LEVERAGES = [1, 2, 3, 5];

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
const hours = (h: number) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${h.toFixed(h < 10 ? 1 : 0)} h`);

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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="bot-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Step({ n, title, done, children, aside }: { n: number; title: string; done?: boolean; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className={`bot-step${done ? " is-done" : ""}`}>
      <div className="bot-step__head">
        <span className="bot-step__num" aria-hidden>
          {done ? "✓" : n}
        </span>
        <h3>{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A pair to farm or carry, in plain words: what volume costs on it, what funding does, whether the user can trade it now. */
function PairChoice({ p, on, missing, onPick }: { p: PairOpportunity; on: boolean; missing: PerpVenueName[]; onPick: () => void }) {
  return (
    <button type="button" className={`bot-choice${on ? " is-on" : ""}`} aria-pressed={on} onClick={onPick}>
      <span className="bot-choice__title">
        {p.base}
        {p.arbitrage && (
          <span className="bot-tag" title="The funding spread pays the round trip's fees back within 3 days">
            Funding arb
          </span>
        )}
      </span>
      <span className="bot-choice__sub">
        long {p.long.venue} · short {p.short.venue}
      </span>
      <span className="bot-choice__line">~{usd(feesPer10kUsd(p.roundTripFeePct))} of fees per $10k of volume</span>
      <span className="bot-choice__line" style={{ color: p.spreadAprPct > 0 ? "var(--risk-good)" : undefined }}>
        Funding {p.spreadAprPct >= 0 ? "pays" : "costs"} {Math.abs(p.spreadAprPct).toFixed(1)}%/yr while held
      </span>
      {missing.length > 0 && <span className="bot-choice__warn">Connect {missing.join(" and ")} first</span>}
    </button>
  );
}

/**
 * The neutral bot. Off, it is a four-step setup in plain words: where the
 * money is (and what to do about it), which pair, how much and how fast
 * (with what a day makes and costs), then start. On (or paused with a pair
 * open), it is a dashboard: one status line, green when all is well, the
 * live totals, the volume curve and the two legs. The activity log sits
 * under both. The bot itself runs in components/NeutralBotHost.
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
  const funds = useVenueFunds(trader);
  const [confirming, setConfirming] = useState<"start" | "close" | null>(null);
  const [morePairs, setMorePairs] = useState(false);

  const { cfg, stats, running, busy, view } = s;
  // Off and flat: the setup. Running, or paused with a pair open: the dashboard (settings can't change under a held pair).
  const setup = !running && !stats.openedAt;

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

  const health = trader.address ? botHealth(s, now) : { tone: "idle" as const, label: "No wallet", detail: "Connect a wallet to set it up: the bot trades your own Hyperliquid, Extended and TxFlow accounts.", deltaPct: null };

  const [va, vb] = cfg.venues;
  const qa = markets.data ? marketOn(markets.data, va, cfg.base) : undefined;
  const qb = markets.data ? marketOn(markets.data, vb, cfg.base) : undefined;
  const minNotional = qa && qb ? Math.ceil(Math.max(qa.minQty * qa.markUsd, qa.minNotionalUsd, qb.minQty * qb.markUsd, qb.minNotionalUsd) * 1.02) : 0;
  const maxLev = qa && qb ? Math.min(qa.maxLeverage || 1, qb.maxLeverage || 1) : 50;
  const fh = qa && qb ? { [va]: qa.fundingHourly, [vb]: qb.fundingHourly } : null;
  const spreadNow = fh ? Math.max(spreadAprPct({ fundingHourly: fh }, va, vb) ?? 0, spreadAprPct({ fundingHourly: fh }, vb, va) ?? 0) : null;
  const marginPerVenue = marginNeededUsd(cfg.notionalUsd, cfg.leverage);
  const freeA = funds.data?.free[va] ?? null;
  const freeB = funds.data?.free[vb] ?? null;
  const maxSize = freeA !== null && freeB !== null ? maxPerSideUsd(freeA, freeB, cfg.leverage) : null;
  const day = qa && qb && cfg.mode === "farm" ? dayEstimate(cfg, [qa.takerFee, qb.takerFee]) : null;
  const pace = intensityOf(cfg);

  // What stands between the setup and Start, in the order the steps fix it.
  const short = [freeA !== null && freeA < marginPerVenue ? va : null, freeB !== null && freeB < marginPerVenue ? vb : null].filter((x): x is PerpVenueName => !!x);
  const problems = [
    !trader.address ? "Connect a wallet." : null,
    va === vb ? "The pair needs two different venues." : null,
    trader.address && (!trader.ready(va) || !trader.ready(vb)) ? `Connect ${[va, vb].filter((v) => !trader.ready(v)).join(" and ")} (step 1).` : null,
    markets.data && (!qa || !qb) ? `${cfg.base} isn't listed on ${!qa ? va : vb}: pick another pair (step 2).` : null,
    qa && qb && cfg.notionalUsd * (1 - (cfg.mode === "farm" ? cfg.sizeJitterPct : 0) / 100) < minNotional ? `Size per side: at least ${usd(minNotional * (cfg.mode === "farm" ? 1 / (1 - cfg.sizeJitterPct / 100) : 1))} (the markets' minimum, size variation included).` : null,
    qa && qb && cfg.leverage > maxLev ? `${maxLev}x is the most both markets allow.` : null,
    cfg.holdMaxMinutes < cfg.holdMinMinutes || cfg.gapMaxMinutes < cfg.gapMinMinutes ? "Each range in the advanced settings needs its maximum at or above its minimum." : null,
    !(cfg.maxFeesUsd > 0) ? "Set a fee budget (step 3): the bot stops once it is spent." : null,
  ].filter((x): x is string => !!x);

  const set = <K extends keyof BotConfig>(k: K, v: BotConfig[K]) => setBotState((st) => ({ cfg: { ...st.cfg, [k]: v } }));
  const patch = (p: Partial<BotConfig>) => setBotState((st) => ({ cfg: { ...st.cfg, ...p } }));
  const num = (v: string, min = 0) => Math.max(min, Number(v) || 0);

  // Pairs: the venues the user can trade first, then by what the goal ranks on.
  const pairs = scanPairs(markets.data, { venues: VENUES });
  const ranked = cfg.mode === "farm" ? rankForFarming(pairs, (cfg.holdMinMinutes + cfg.holdMaxMinutes) / 120) : rankForCarry(pairs);
  const missingFor = (p: PairOpportunity) => (trader.address ? [p.long.venue, p.short.venue].filter((v) => !trader.ready(v)) : []);
  const choices = [...ranked].sort((a, b) => missingFor(a).length - missingFor(b).length).slice(0, morePairs ? 9 : 3);
  const isOn = (p: PairOpportunity) => p.base === cfg.base && [p.long.venue, p.short.venue].every((v) => cfg.venues.includes(v));
  const pick = (p: PairOpportunity) => patch({ base: p.base, venues: [p.long.venue, p.short.venue], notionalUsd: Math.max(cfg.notionalUsd, Math.ceil(p.minNotionalUsd * 1.25)), leverage: Math.min(cfg.leverage, p.maxLeverage) });

  // Live figures.
  const pnl = view ? openPnlUsd(stats.legs, view.marks) : null;
  const oi = stats.legs.reduce((sum, l) => sum + l.qty * (view?.marks[l.venue] ?? l.entryPx), 0);
  const costPer10k = stats.volumeUsd > 0 ? ((stats.feesUsd - stats.fundingUsd) / stats.volumeUsd) * 10_000 : null;
  const day24 = volumeLast24h(stats.history, now);
  const nextTick = s.nextTickAt ? Math.max(0, Math.ceil((s.nextTickAt - now) / 1000)) : null;

  const fundsOk = trader.address && trader.ready(va) && trader.ready(vb) && short.length === 0 && freeA !== null && freeB !== null;

  return (
    <section className="bot-view" id={BOT_ANCHOR}>
      <BotHero health={health} setup={setup}>
        {!setup && (
          <div className="bot-hero__actions">
            {running ? (
              <button type="button" className="btn btn-secondary" onClick={() => setBotState({ running: false, nextTickAt: null })}>
                Pause
              </button>
            ) : (
              <button type="button" className="btn btn-primary" disabled={busy || problems.length > 0} onClick={() => setConfirming("start")}>
                Resume →
              </button>
            )}
            <button type="button" className="btn btn-secondary" disabled={busy || !trader.address} onClick={() => setConfirming("close")}>
              Stop &amp; close
            </button>
          </div>
        )}
      </BotHero>

      {s.needsMargin?.length ? (
        <div className="bot-callout bot-callout--warn">
          {s.needsMargin.map((m) => (
            <div key={m.venue} className="bot-callout__row">
              <span>
                <strong>{m.venue}</strong> needs about {usd(Math.max(5, m.neededUsd - m.freeUsd + 1))} more margin ({usd(m.freeUsd)} free, {usd(m.neededUsd)} a leg). The bot waits and opens as soon as it lands.
              </span>
              <button type="button" className="btn btn-primary" onClick={() => openToolsAt(VENUE_ANCHOR_OF[m.venue])}>
                Deposit on {m.venue} →
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {setup ? (
        <div className="bot-steps">
          {stats.volumeUsd > 0 && (
            <div className="bot-lastrun text-muted">
              Last run: {usd(stats.volumeUsd)} of volume, {usd(stats.feesUsd)} of fees, {stats.cycles} pair{stats.cycles === 1 ? "" : "s"}
              {stats.stopReason ? ` · ${stats.stopReason}` : ""}.
              <button type="button" className="btn btn-secondary bot-mini" onClick={() => setBotState({ stats: EMPTY_STATS })}>
                Reset totals
              </button>
            </div>
          )}

          <Step n={1} title="Your money on the venues" done={!!fundsOk} aside={<span className="text-muted bot-step__aside">each venue of the pair needs ~{usd(marginPerVenue)} free</span>}>
            <BotFunds trader={trader} funds={funds.data} pair={cfg.venues} neededUsd={marginPerVenue} />
          </Step>

          <Step
            n={2}
            title="Pick a pair"
            done={!!qa && !!qb}
            aside={
              <div className="bot-seg" role="group" aria-label="Goal">
                {(["farm", "carry"] as BotMode[]).map((m) => (
                  <button key={m} type="button" className={`btn ${cfg.mode === m ? "btn-primary" : "btn-secondary"} bot-mini`} aria-pressed={cfg.mode === m} onClick={() => set("mode", m)}>
                    {m === "farm" ? "Farm volume & points" : "Earn the funding spread"}
                  </button>
                ))}
              </div>
            }
          >
            <p className="bot-step__lead text-muted">
              {cfg.mode === "farm"
                ? "The bot opens the same size long on one venue and short on the other, so price moves cancel out, then closes and reopens it on a random schedule. Every opening and closing is volume and open interest on both venues: what their points and airdrops reward. Cheapest first."
                : "The bot holds the pair while one venue pays more funding than the other, and closes it when the spread fades. Best spread first."}
            </p>
            {markets.isLoading ? (
              <p className="text-muted bot-empty">Reading the venues&apos; markets…</p>
            ) : choices.length === 0 ? (
              <p className="text-muted bot-empty">No liquid pair listed on two venues right now.</p>
            ) : (
              <div className="bot-choices">
                {choices.map((p) => (
                  <PairChoice key={`${p.base}-${p.long.venue}-${p.short.venue}`} p={p} on={isOn(p)} missing={missingFor(p)} onPick={() => pick(p)} />
                ))}
              </div>
            )}
            <div className="bot-step__foot text-muted">
              <span>
                Selected: <strong>{cfg.base}</strong> on {va} + {vb}
                {spreadNow !== null && ` · funding spread now ${pct(spreadNow)}/yr`}
              </span>
              {ranked.length > 3 && (
                <button type="button" className="btn btn-secondary bot-mini" onClick={() => setMorePairs((x) => !x)}>
                  {morePairs ? "Fewer pairs" : "More pairs"}
                </button>
              )}
            </div>
          </Step>

          <Step n={3} title="How much, and how fast">
            <div className="bot-fields bot-fields--main">
              <Field label="Size per side ($)">
                <input type="number" min={1} value={cfg.notionalUsd} onChange={(e) => set("notionalUsd", num(e.target.value, 1))} />
              </Field>
              <Field label="Leverage">
                <div className="bot-seg">
                  {LEVERAGES.filter((l) => l <= maxLev).map((l) => (
                    <button key={l} type="button" className={`btn ${cfg.leverage === l ? "btn-primary" : "btn-secondary"} bot-mini`} aria-pressed={cfg.leverage === l} onClick={() => set("leverage", l)}>
                      {l}x
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Stop after spending ($ of fees)">
                <input type="number" min={0} step={0.5} value={cfg.maxFeesUsd} onChange={(e) => set("maxFeesUsd", num(e.target.value))} />
              </Field>
            </div>
            <p className="text-muted bot-hint">
              {minNotional > 0 && `Minimum ${usd(minNotional)} a side. `}
              Each venue locks ~{usd(marginPerVenue)} of margin
              {maxSize !== null && maxSize > 0 && (
                <>
                  {" "}
                  · your deposits allow up to {usd(maxSize)} a side{" "}
                  <button type="button" className="btn btn-secondary bot-mini" onClick={() => set("notionalUsd", maxSize)}>
                    Use {usd(maxSize)}
                  </button>
                </>
              )}
              . At {cfg.leverage}x, a leg is liquidated if the price moves ~{Math.round(90 / Math.max(1, cfg.leverage))}% against it (the other leg gains the same).
            </p>

            {cfg.mode === "farm" ? (
              <>
                <div className="bot-choices bot-choices--pace" role="group" aria-label="Pace">
                  {(Object.keys(INTENSITY) as Intensity[]).map((k) => (
                    <button key={k} type="button" className={`bot-choice${pace === k ? " is-on" : ""}`} aria-pressed={pace === k} onClick={() => patch({ holdMinMinutes: INTENSITY[k].holdMinMinutes, holdMaxMinutes: INTENSITY[k].holdMaxMinutes, gapMinMinutes: INTENSITY[k].gapMinMinutes, gapMaxMinutes: INTENSITY[k].gapMaxMinutes })}>
                      <span className="bot-choice__title">{INTENSITY[k].label}</span>
                      <span className="bot-choice__sub">{INTENSITY[k].blurb}</span>
                      <span className="bot-choice__line">
                        held {INTENSITY[k].holdMinMinutes}–{INTENSITY[k].holdMaxMinutes} min, then {INTENSITY[k].gapMinMinutes}–{INTENSITY[k].gapMaxMinutes} min off
                      </span>
                    </button>
                  ))}
                </div>
                {pace === null && <p className="text-muted bot-hint">Custom pace (advanced settings): held {cfg.holdMinMinutes}–{cfg.holdMaxMinutes} min, {cfg.gapMinMinutes}–{cfg.gapMaxMinutes} min off.</p>}
                {day && (
                  <div className="bot-estimate">
                    <div>
                      <span className="bot-estimate__label">Volume a day</span>
                      <strong>~{usd(day.volumeUsd)}</strong>
                    </div>
                    <div>
                      <span className="bot-estimate__label">Fees a day</span>
                      <strong>~{usd(day.feesUsd)}</strong>
                    </div>
                    <div>
                      <span className="bot-estimate__label">Pairs a day</span>
                      <strong>~{Math.round(Math.min(day.cyclesPerDay, cfg.maxCycles || Infinity))}</strong>
                    </div>
                    <p className="text-muted">{day.stopsAfterHours !== null ? `The fee budget (or the ${cfg.maxCycles}-pair cap) stops it after ~${hours(day.stopsAfterHours)}: raise it to run longer.` : "Times and sizes are drawn at random within the ranges, so each day differs a little."}</p>
                  </div>
                )}
              </>
            ) : (
              <p className="text-muted bot-hint">
                Opens above {cfg.minSpreadAprPct}%/yr of spread, closes under {cfg.exitSpreadAprPct}%/yr (advanced settings).
              </p>
            )}

            <details className="bot-adv">
              <summary>Advanced settings</summary>
              <div className="bot-fields">
                <Field label="Asset">
                  <input value={cfg.base} onChange={(e) => set("base", e.target.value.toUpperCase().trim())} />
                </Field>
                {[0, 1].map((i) => (
                  <Field key={i} label={`Venue ${i + 1}`}>
                    <select value={cfg.venues[i]} onChange={(e) => set("venues", (i === 0 ? [e.target.value, cfg.venues[1]] : [cfg.venues[0], e.target.value]) as [PerpVenueName, PerpVenueName])}>
                      {VENUES.map((v) => (
                        <option key={v} value={v}>
                          {v}
                          {trader.ready(v) ? "" : " (not connected)"}
                        </option>
                      ))}
                    </select>
                  </Field>
                ))}
                <Field label="Leverage (any)">
                  <input type="number" min={1} max={maxLev} value={cfg.leverage} onChange={(e) => set("leverage", Math.round(num(e.target.value, 1)))} />
                </Field>
                {cfg.mode === "farm" ? (
                  <>
                    <Field label="Hold each pair (min) — from">
                      <input type="number" min={5} value={cfg.holdMinMinutes} onChange={(e) => set("holdMinMinutes", num(e.target.value, 5))} />
                    </Field>
                    <Field label="to">
                      <input type="number" min={5} value={cfg.holdMaxMinutes} onChange={(e) => set("holdMaxMinutes", num(e.target.value, 5))} />
                    </Field>
                    <Field label="Pause between pairs (min) — from">
                      <input type="number" min={0} value={cfg.gapMinMinutes} onChange={(e) => set("gapMinMinutes", num(e.target.value))} />
                    </Field>
                    <Field label="to">
                      <input type="number" min={0} value={cfg.gapMaxMinutes} onChange={(e) => set("gapMaxMinutes", num(e.target.value))} />
                    </Field>
                    <Field label="Vary the size (± %)">
                      <input type="number" min={0} max={50} value={cfg.sizeJitterPct} onChange={(e) => set("sizeJitterPct", Math.min(50, num(e.target.value)))} />
                    </Field>
                  </>
                ) : (
                  <>
                    <Field label="Open above (%/yr)">
                      <input type="number" value={cfg.minSpreadAprPct} onChange={(e) => set("minSpreadAprPct", Number(e.target.value) || 0)} />
                    </Field>
                    <Field label="Close under (%/yr)">
                      <input type="number" value={cfg.exitSpreadAprPct} onChange={(e) => set("exitSpreadAprPct", Number(e.target.value) || 0)} />
                    </Field>
                  </>
                )}
                <Field label="Max pairs (cycles)">
                  <input type="number" min={1} value={cfg.maxCycles} onChange={(e) => set("maxCycles", Math.round(num(e.target.value, 1)))} />
                </Field>
                <Field label="Volume target ($, 0 = none)">
                  <input type="number" min={0} value={cfg.volumeTargetUsd} onChange={(e) => set("volumeTargetUsd", num(e.target.value))} />
                </Field>
              </div>
            </details>
          </Step>

          <Step n={4} title="Start">
            {problems.length > 0 ? (
              <ul className="bot-todo">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : (
              <p className="bot-ready">
                Ready: {cfg.mode === "farm" ? `farm ${cfg.base} with ~${usd(cfg.notionalUsd)} a side on ${va} and ${vb} at ${cfg.leverage}x, ${pace ? INTENSITY[pace].label.toLowerCase() : "custom"} pace` : `carry ${cfg.base} on ${va} and ${vb} at ${cfg.leverage}x`}, stopping after {usd(cfg.maxFeesUsd)} of fees.
              </p>
            )}
            <div className="bot-step__foot">
              <button type="button" className="btn btn-primary bot-start" disabled={busy || problems.length > 0} onClick={() => setConfirming("start")}>
                {busy ? "Starting…" : "Start the bot →"}
              </button>
              <span className="text-muted bot-footnote">It runs from this browser tab: keep it open. Pause or Stop &amp; close any time.</span>
            </div>
          </Step>
        </div>
      ) : (
        <>
          <div className="bot-kpis">
            <Kpi label="Volume made" value={usd(stats.volumeUsd)} hint={`${usd(day24)} in the last 24 h`} />
            <Kpi label="Fees paid" value={usd(stats.feesUsd)} hint={`stops at ${usd(cfg.maxFeesUsd)}`} />
            <Kpi label="Open interest" value={usd(oi)} hint={stats.legs.length ? "both legs, at mark" : "no pair open right now"} />
            <Kpi label="Hedge PnL" value={pnl === null ? "—" : usd(pnl, true)} tone={pnl !== null ? (pnl >= 0 ? "good" : "bad") : undefined} hint="long + short: stays near $0" />
          </div>
          <p className="text-muted bot-subline">
            Funding {usd(stats.fundingUsd, true)} (est.)
            {costPer10k !== null && ` · net cost ${usd(costPer10k)} per $10k of volume`} · {stats.cycles}
            {cfg.maxCycles > 0 ? ` / ${cfg.maxCycles}` : ""} pairs
            {stats.startedAt ? ` · running ${duration(now - stats.startedAt)}` : ""}
            {running && ` · next check ${nextTick === null ? "now" : `in ${nextTick}s`}`}
          </p>

          <div className="bot-grid">
            <div className="bot-card bot-card--chart">
              <div className="bot-card__head">
                <h6>Volume made by the bot</h6>
                <span className="text-muted">{usd(stats.volumeUsd)} total</span>
              </div>
              <BotVolumeChart history={stats.history} now={now} />
            </div>

            <div className="bot-card bot-card--chart">
              <div className="bot-card__head">
                <h6>The pair</h6>
                <span className="text-muted">
                  {cfg.base} · {cfg.leverage}x · {cfg.mode === "farm" ? "farming" : "carry"}
                </span>
              </div>
              {stats.legs.length === 0 ? (
                <p className="text-muted bot-empty">{stats.reopenAt && stats.reopenAt > now ? `Flat until ${hm(stats.reopenAt)}: the next pair opens at a random time.` : "No pair open."}</p>
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
                {" "}To change the settings, {running ? "Pause, then " : ""}Stop &amp; close.
              </div>
            </div>
          </div>
        </>
      )}

      <details className="bot-card bot-activity" open={!setup}>
        <summary className="bot-card__head">
          <h6>Activity</h6>
          <span className="text-muted">{s.log.length} events</span>
        </summary>
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
      </details>

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
              Stops on its own after {cfg.maxCycles} pairs or {usd(cfg.maxFeesUsd)} of fees{cfg.volumeTargetUsd > 0 ? `, or at ${usd(cfg.volumeTargetUsd)} of volume` : ""}, closing the pair first. A failed second leg is unwound at once; a leg it can&apos;t close stops the bot.
            </p>
            <p>Market (taker) orders sent by the venues&apos; trading keys from this tab, without a wallet popup each time. Each leg can be liquidated on its own venue if the price moves far: at {cfg.leverage}x, about {Math.round(90 / Math.max(1, cfg.leverage))}% against it.</p>
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

function BotHero({ health, setup, children }: { health: ReturnType<typeof botHealth>; setup: boolean; children?: React.ReactNode }) {
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
        <p className="bot-hero__sub">
          {setup
            ? "Farms points and airdrops on Hyperliquid, Extended and TxFlow with volume and open interest that has no price exposure: long on one venue, short on the other. Four steps below; nothing trades before you press Start."
            : "Long on one venue, short on the other: price moves cancel out. It trades on its own while this tab is open."}
        </p>
        {!setup && (
          <p className="bot-hero__status" role="status" aria-live="polite">
            {health.detail}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}
