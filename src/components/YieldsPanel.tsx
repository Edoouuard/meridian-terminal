"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Opportunity } from "@/lib/protocols/opportunities";
import { AskButton } from "@/components/AskButton";

function fmtTvl(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${Math.round(n / 1e6)}M`;
  return `$${Math.round(n / 1e3)}k`;
}

/**
 * Best live yields across every protocol Meridian covers, from DefiLlama
 * (/api/opportunities). Executable rows offer to build the deposit; the
 * others are there to compare, honestly labelled.
 */
export function YieldsPanel() {
  const [kind, setKind] = useState<"stable" | "eth" | "hype">("stable");
  const [onlyExec, setOnlyExec] = useState(false);
  const { data, isLoading } = useQuery<Opportunity[]>({
    queryKey: ["opportunities", kind],
    queryFn: async () => {
      const res = await fetch(`/api/opportunities?kind=${kind}&limit=40`);
      if (!res.ok) throw new Error("opportunities fetch failed");
      return res.json();
    },
    staleTime: 10 * 60_000,
  });
  const rows = (data ?? []).filter((o) => !onlyExec || o.coverage === "execute");
  const execCount = (data ?? []).filter((o) => o.coverage === "execute").length;

  return (
    <section className="panel-card">
      <div className="panel-card__head">
        <h6 className="panel-card__title">Yields</h6>
        <span className="text-muted" style={{ fontSize: 11 }}>{data && data.length > 0 ? "DefiLlama · live" : isLoading ? "loading…" : "offline"}</span>
      </div>
      <div className="yields-filters">
        <div className="seg seg--sm">
          <label className="seg-opt">
            <input type="radio" name="yield-kind" checked={kind === "stable"} onChange={() => setKind("stable")} />
            <span>Stablecoins</span>
          </label>
          <label className="seg-opt">
            <input type="radio" name="yield-kind" checked={kind === "eth"} onChange={() => setKind("eth")} />
            <span>ETH</span>
          </label>
          <label className="seg-opt">
            <input type="radio" name="yield-kind" checked={kind === "hype"} onChange={() => setKind("hype")} />
            <span>HYPE</span>
          </label>
        </div>
        <label className="yields-toggle">
          <input type="checkbox" checked={onlyExec} onChange={(e) => setOnlyExec(e.target.checked)} />
          Executable only{data ? ` (${execCount})` : ""}
        </label>
      </div>

      {rows.length > 0 ? (
        <ul className="yield-list">
          {rows.map((o) => (
            <li key={`${o.project}-${o.chainId}-${o.symbol}`} className="yield-row">
              <div className="yield-row__head">
                <span className="yield-row__name">
                  {o.protocol}
                  <span className="yield-row__where">
                    {o.symbol}
                    {o.shareSymbol ? ` → ${o.shareSymbol}` : ""} · {o.chain}
                  </span>
                </span>
                <span className="yield-row__apy">{o.apy.toFixed(2)}%</span>
              </div>
              <div className="yield-row__meta">
                <span className={`coverage-badge coverage-badge--${o.coverage}`}>{o.coverage === "execute" ? "Executable" : "Compare"}</span>
                <span>{fmtTvl(o.tvlUsd)} TVL</span>
                {o.apyReward > 0 && <span>incl. {o.apyReward.toFixed(1)}% rewards</span>}
                {o.apyMean30d !== undefined && <span>30d {o.apyMean30d.toFixed(1)}%</span>}
              </div>
              {o.coverage === "execute" ? (
                <AskButton
                  label="Put my funds here"
                  prompt={`Deposit my ${o.symbol === "USD₮0" ? "USDT" : o.symbol} into ${o.protocol} on ${o.chain} (${o.apy.toFixed(2)}% APY now). Size it to my wallet and bridge only if it pays.`}
                />
              ) : (
                <AskButton
                  label="Compare"
                  prompt={`${o.protocol} pays ${o.apy.toFixed(2)}% on ${o.symbol} on ${o.chain}. What's the closest thing Meridian can execute, and how do the risks compare?`}
                />
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
          {isLoading ? "Fetching live yields…" : "No live yields right now — DefiLlama is unreachable."}
        </p>
      )}
      <p className="text-muted" style={{ fontSize: 10, margin: 0 }}>
        Single-asset pools with at least $5M TVL on Meridian&apos;s chains (incl. HyperEVM), from DefiLlama. &ldquo;Executable&rdquo; means
        Meridian builds and simulates the deposit itself.
      </p>
    </section>
  );
}
