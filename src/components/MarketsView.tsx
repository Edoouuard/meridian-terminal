"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AskButton } from "@/components/AskButton";
import { pairPrompt, type FundingPair, type FundingQuote, type FundingVenue } from "@/lib/markets/funding";
import type { PerpVault } from "@/lib/markets/vaults";
import { AIRDROPS_COMPILED, upcomingPrograms } from "@/lib/markets/airdrops";
import { FEATURES } from "@/lib/features";

interface FundingBoard {
  fetchedAt: string;
  venues: FundingVenue[];
  venuesDown: FundingVenue[];
  quoteCount: number;
  pairs: FundingPair[];
  executablePairs: FundingPair[];
}

const pct = (n: number, d = 1) => `${n > 0 ? "+" : ""}${n.toFixed(d)}%`;
const usd = (n: number | null) => (n === null ? "n/a" : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`);
const since = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");

function Leg({ q, side }: { q: FundingQuote; side: "long" | "short" }) {
  return (
    <span className="mkt-leg">
      <span className={`mkt-leg__side mkt-leg__side--${side}`}>{side}</span>
      {q.venue}
      <span className="mkt-leg__rate">{pct(q.annualPct)}</span>
    </span>
  );
}

function FundingTab() {
  const [scope, setScope] = useState<"meridian" | "all">("meridian");
  const { data, isLoading } = useQuery<FundingBoard>({
    queryKey: ["funding-board"],
    queryFn: async () => {
      const res = await fetch("/api/funding-board");
      if (!res.ok) throw new Error("funding board fetch failed");
      return res.json();
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const rows = (scope === "meridian" ? data?.executablePairs : data?.pairs) ?? [];

  return (
    <section className="panel-card">
      <div className="panel-card__head">
        <h6 className="panel-card__title">Funding arbitrage</h6>
        <span className="text-muted" style={{ fontSize: 11 }}>
          {data ? `${data.venues.length} venues · ${data.quoteCount} markets · ${since(data.fetchedAt)}` : isLoading ? "loading…" : "offline"}
        </span>
      </div>
      <p className="mkt-lede">
        Long where funding costs a long the least, short where it pays a short the most: price moves cancel, the funding gap is the return. Rates as a %
        a year at today&apos;s rates, which move every hour.
      </p>
      <div className="seg seg--sm" style={{ alignSelf: "flex-start" }}>
        <label className="seg-opt">
          <input type="radio" name="fund-scope" checked={scope === "meridian"} onChange={() => setScope("meridian")} />
          <span>Executable in Meridian</span>
        </label>
        <label className="seg-opt">
          <input type="radio" name="fund-scope" checked={scope === "all"} onChange={() => setScope("all")} />
          <span>All venues</span>
        </label>
      </div>
      {rows.length > 0 ? (
        <div className="mkt-table-wrap">
          <table className="mkt-table">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Legs</th>
                <th className="num">Spread / yr</th>
                <th className="num">Fees in &amp; out</th>
                <th className="num">Break-even</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 40).map((p) => (
                <tr key={`${p.base}-${p.long.venue}-${p.short.venue}`}>
                  <td className="mkt-asset">{p.base}</td>
                  <td>
                    <div className="mkt-legs">
                      <Leg q={p.long} side="long" />
                      <Leg q={p.short} side="short" />
                    </div>
                  </td>
                  <td className="num mkt-strong">{pct(p.spreadAprPct)}</td>
                  <td className="num">{p.roundTripFeePct !== null ? `${p.roundTripFeePct.toFixed(2)}%` : "—"}</td>
                  <td className="num">{p.breakEvenDays !== null ? `${p.breakEvenDays < 1 ? "<1" : Math.ceil(p.breakEvenDays)} d` : "—"}</td>
                  <td>{p.executable && FEATURES.perps ? <AskButton label="Open the pair" prompt={pairPrompt(p)} /> : <span className="mkt-ref">reference</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>{isLoading ? "Reading funding on every venue…" : "No pair earns a positive spread right now."}</p>
      )}
      <p className="mkt-foot">
        Venues: {data?.venues.join(", ") ?? "—"}
        {data && data.venuesDown.length > 0 ? ` · not answering: ${data.venuesDown.join(", ")}` : ""}. Fees and break-even only where Meridian knows the
        taker fee (Hyperliquid, Extended, TxFlow). Legs under $1M of 24h volume are left out when the venue reports volume; Lighter, Binance and Bybit
        don&apos;t in this feed, so their pairs need a second leg that does.
      </p>
    </section>
  );
}

function VaultsTab() {
  const { data, isLoading } = useQuery<{ fetchedAt: string; vaults: PerpVault[] }>({
    queryKey: ["perp-vaults"],
    queryFn: async () => {
      const res = await fetch("/api/perp-vaults");
      if (!res.ok) throw new Error("perp vaults fetch failed");
      return res.json();
    },
    staleTime: 5 * 60_000,
  });
  return (
    <section className="panel-card">
      <div className="panel-card__head">
        <h6 className="panel-card__title">Perp vaults</h6>
        <span className="text-muted" style={{ fontSize: 11 }}>{data ? `live · ${since(data.fetchedAt)}` : isLoading ? "loading…" : "offline"}</span>
      </div>
      <p className="mkt-lede">Vaults the exchanges run themselves: they make markets and take liquidations, and depositors share the result, losses included.</p>
      {data?.vaults.length ? (
        <div className="mkt-vaults">
          {data.vaults.map((v, i) => (
            <article key={v.id} className="mkt-vault">
              <div className="mkt-vault__head">
                <span className="mkt-vault__rank">{i + 1}</span>
                <div>
                  <div className="mkt-vault__name">{v.name}</div>
                  <div className="mkt-vault__where">
                    {v.venue} · {v.chain} · {v.asset}
                  </div>
                </div>
                <div className="mkt-vault__apr">{v.aprPct !== null ? `${v.aprPct.toFixed(1)}%` : "—"}<span>APR</span></div>
              </div>
              <dl className="mkt-vault__facts">
                <div><dt>TVL</dt><dd>{usd(v.tvlUsd)}</dd></div>
                <div><dt>30 days</dt><dd>{v.return30dPct !== null ? pct(v.return30dPct, 2) : "—"}</dd></div>
                <div><dt>Depositors</dt><dd>{v.depositors !== null ? v.depositors.toLocaleString() : "—"}</dd></div>
                <div><dt>Lock</dt><dd>{v.lock}</dd></div>
              </dl>
              <p className="mkt-vault__how">{v.strategy}. {v.aprMethod}.</p>
              <div className="mkt-vault__actions">
                {v.meridianPrompt ? <AskButton label="Deposit with Meridian" prompt={v.meridianPrompt} /> : null}
                <a className="mkt-link" href={v.url} target="_blank" rel="noreferrer">
                  Open on {v.venue} ↗
                </a>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>{isLoading ? "Reading the vaults…" : "The vault APIs aren't answering right now."}</p>
      )}
      <p className="mkt-foot">Each exchange computes its APR its own way (line under each vault). Past returns don&apos;t promise future ones.</p>
    </section>
  );
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function AirdropsTab() {
  const now = new Date();
  const programs = upcomingPrograms(now);
  return (
    <section className="panel-card">
      <div className="panel-card__head">
        <h6 className="panel-card__title">Points &amp; airdrops</h6>
        <span className="text-muted" style={{ fontSize: 11 }}>compiled {AIRDROPS_COMPILED}</span>
      </div>
      <p className="mkt-lede">
        Perp DEX points programs and when their weekly points drop (UTC). Volume and open interest are what most of them reward: a neutral pair earns
        both without price exposure.
      </p>
      <ul className="mkt-drops">
        {programs.map(({ program: p, next }) => (
          <li key={p.venue} className={`mkt-drop${p.meridian ? " mkt-drop--meridian" : ""}`}>
            <div className="mkt-drop__when">
              {next ? (
                <>
                  <b>{DAY_NAMES[next.getUTCDay()]}</b>
                  <span>{next.toISOString().slice(5, 10).replace("-", "/")}</span>
                </>
              ) : (
                <span>no fixed day</span>
              )}
            </div>
            <div className="mkt-drop__body">
              <div className="mkt-drop__title">
                {p.url ? (
                  <a href={p.url} target="_blank" rel="noreferrer">
                    {p.venue}
                  </a>
                ) : (
                  p.venue
                )}
                <span className="mkt-drop__program">{p.program}</span>
                {p.meridian && <span className="mkt-drop__badge">Meridian trades it</span>}
              </div>
              <div className="mkt-drop__meta">
                <span>{p.weeklyPool === "—" ? "no published pool" : `${p.weeklyPool} pts${/season/.test(p.weeklyPool) ? "" : " / week"}`}</span>
                <span>earns: {p.earns.join(" · ")}</span>
                {p.endsOn && <span>until {p.endsOn}</span>}
              </div>
              {p.note && <p className="mkt-drop__note">{p.note}</p>}
              {p.meridian && FEATURES.perps && <AskButton label="Farm it with the neutral bot" prompt={`Farm ${p.venue} points with a neutral pair: volume and open interest without price exposure.`} />}
            </div>
          </li>
        ))}
      </ul>
      <p className="mkt-foot">
        Curated from the programs&apos; public pages (via arb.sh/airdrops) on {AIRDROPS_COMPILED}; programs change week to week. Points convert to a token
        only if and when an exchange decides.
      </p>
    </section>
  );
}

/** The Markets tab: funding arbitrage across nine venues, perp vaults, points programs. */
export function MarketsView() {
  const [tab, setTab] = useState<"funding" | "vaults" | "airdrops">("funding");
  return (
    <div className="mkt">
      <div className="seg" role="tablist" aria-label="Markets">
        {(
          [
            ["funding", "Funding arb"],
            ["vaults", "Perp vaults"],
            ["airdrops", "Airdrops"],
          ] as const
        ).map(([id, label]) => (
          <label key={id} className="seg-opt">
            <input type="radio" name="mkt-tab" checked={tab === id} onChange={() => setTab(id)} />
            <span>{label}</span>
          </label>
        ))}
      </div>
      {tab === "funding" && <FundingTab />}
      {tab === "vaults" && <VaultsTab />}
      {tab === "airdrops" && <AirdropsTab />}
    </div>
  );
}
