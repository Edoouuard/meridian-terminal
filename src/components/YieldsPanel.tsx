"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Opportunity } from "@/lib/protocols/opportunities";
import type { PerpVault } from "@/lib/markets/vaults";
import { AskButton } from "@/components/AskButton";
import { ProtocolLogo } from "@/components/ProtocolLogo";

function fmtTvl(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${Math.round(n / 1e6)}M`;
  return `$${Math.round(n / 1e3)}k`;
}

/**
 * Perp DEX vaults (HLP, LLP, JLP, GLVs, gUSDC, MegaVault…), each figure read
 * from the protocol's own API (/api/perp-vaults).
 */
function PerpVaultList({ onlyExec }: { onlyExec: boolean }) {
  const { data, isLoading } = useQuery<{ vaults: PerpVault[] }>({
    queryKey: ["perp-vaults"],
    queryFn: async () => {
      const res = await fetch("/api/perp-vaults");
      if (!res.ok) throw new Error("perp vaults fetch failed");
      return res.json();
    },
    staleTime: 5 * 60_000,
  });
  const rows = (data?.vaults ?? []).filter((v) => !onlyExec || v.executable);
  if (rows.length === 0)
    return <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>{isLoading ? "Reading the vaults…" : "No vault answered right now."}</p>;
  return (
    <ul className="yield-list">
      {rows.map((v) => (
        <li key={v.id} className="yield-row">
          <div className="yield-row__head">
            <span className="yield-row__ident">
              <ProtocolLogo name={v.protocol} size={36} />
              <span className="yield-row__name">
                {v.name}
                <span className="yield-row__where">
                  {v.asset} · {v.chain}
                </span>
              </span>
            </span>
            <span className="yield-row__apy">{v.aprPct.toFixed(2)}%</span>
          </div>
          <div className="yield-row__meta">
            <span className={`coverage-badge coverage-badge--${v.executable ? "execute" : "compare"}`}>{v.executable ? "In Meridian" : "Info only"}</span>
            {v.tvlUsd !== null && <span>{fmtTvl(v.tvlUsd)} deposited</span>}
            <span>Lock: {v.lock}</span>
          </div>
          {v.executable ? (
            <AskButton label="Put my funds here" prompt={`Deposit USDC into ${v.protocol}'s ${v.name} vault (${v.aprPct.toFixed(2)}% APR now, ${v.lock} lock). Size it to my wallet.`} />
          ) : (
            <AskButton
              label="Compare"
              prompt={`${v.protocol}'s ${v.name} vault on ${v.chain} shows ${v.aprPct.toFixed(2)}% (${v.method}). How does it compare with Hyperliquid's HLP and what Meridian can execute, risks included?`}
            />
          )}
          <details className="yield-row__details">
            <summary>Details</summary>
            <p>
              {v.protocol} · {v.name} on {v.chain}
            </p>
            <p>{v.strategy}.</p>
            {v.carriesTraderPnl && <p>Depositors take the other side of traders: when traders win, the vault loses.</p>}
            <p>
              {v.method} ·{" "}
              <a href={v.url} target="_blank" rel="noreferrer">
                {v.protocol}
              </a>
            </p>
          </details>
        </li>
      ))}
    </ul>
  );
}

/**
 * Best live yields across every protocol Meridian covers: lending, staking
 * and pools from DefiLlama (/api/opportunities), and perp DEX vaults from
 * the protocols themselves. Rows Meridian executes offer to build the deposit; the
 * others are there to compare, honestly labelled.
 */
export function YieldsPanel() {
  const [kind, setKind] = useState<"stable" | "eth" | "hype" | "vaults">("stable");
  const [onlyExec, setOnlyExec] = useState(false);
  const { data, isLoading } = useQuery<Opportunity[]>({
    queryKey: ["opportunities", kind],
    enabled: kind !== "vaults",
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
        <span className="text-muted" style={{ fontSize: 11 }}>
          {kind === "vaults" ? "protocol APIs · live" : data && data.length > 0 ? "DefiLlama · live" : isLoading ? "loading…" : "offline"}
        </span>
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
          <label className="seg-opt">
            <input type="radio" name="yield-kind" checked={kind === "vaults"} onChange={() => setKind("vaults")} />
            <span>Perp vaults</span>
          </label>
        </div>
        <label className="yields-toggle">
          <input type="checkbox" checked={onlyExec} onChange={(e) => setOnlyExec(e.target.checked)} />
          Only what Meridian can do{data && kind !== "vaults" ? ` (${execCount})` : ""}
        </label>
      </div>

      {kind === "vaults" ? (
        <PerpVaultList onlyExec={onlyExec} />
      ) : rows.length > 0 ? (
        <ul className="yield-list">
          {rows.map((o) => (
            <li key={`${o.project}-${o.chainId}-${o.symbol}`} className="yield-row">
              <div className="yield-row__head">
                <span className="yield-row__ident">
                  <ProtocolLogo name={o.protocol} slug={o.project} size={36} />
                  <span className="yield-row__name">
                    {o.symbol}
                    {o.shareSymbol ? ` → ${o.shareSymbol}` : ""}
                    <span className="yield-row__where">{o.chain}</span>
                  </span>
                </span>
                <span className="yield-row__apy">{o.apy.toFixed(2)}%</span>
              </div>
              <div className="yield-row__meta">
                <span className={`coverage-badge coverage-badge--${o.coverage}`}>{o.coverage === "execute" ? "In Meridian" : "Info only"}</span>
                <span>{fmtTvl(o.tvlUsd)} deposited</span>
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
              <details className="yield-row__details">
                <summary>Details</summary>
                <p>
                  {o.protocol} · {o.symbol} on {o.chain} · {fmtTvl(o.tvlUsd)} deposited
                </p>
                {(o.apyReward > 0 || o.apyMean30d !== undefined) && (
                  <p>
                    {o.apyReward > 0 && `Includes ${o.apyReward.toFixed(1)}% paid in reward tokens. `}
                    {o.apyMean30d !== undefined && `30-day average ${o.apyMean30d.toFixed(1)}%.`}
                  </p>
                )}
              </details>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
          {isLoading ? "Fetching live yields…" : "No live yields right now — DefiLlama is unreachable."}
        </p>
      )}
      <p className="text-muted" style={{ fontSize: 10, margin: 0 }}>
        {kind === "vaults" ? (
          <>
            Vaults run by perp DEXs, each APR read from the protocol&apos;s own API and computed its own way (hover the method). They earn from fees,
            liquidations and market making, and lose when traders win: past APR is not a promise.
          </>
        ) : (
          <>
        Single-asset pools with at least $5M deposited on Meridian&apos;s chains (incl. HyperEVM), from DefiLlama. &ldquo;In Meridian&rdquo; means
        Meridian builds and simulates the deposit for you.
          </>
        )}
      </p>
    </section>
  );
}
