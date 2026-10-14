"use client";

import { useMemo, useState } from "react";
import type { LivePortfolio } from "@/hooks/useLivePortfolio";
import { useLivePrices } from "@/hooks/useLivePrices";
import { buildPortfolioView, dayChangeUsd, fmtAmount, fmtPrice, type Holding } from "@/lib/portfolioView";

function fmtUsd(v: number): string {
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  return a >= 1000 ? `${sign}$${Math.round(a).toLocaleString("en-US")}` : `${sign}$${a.toFixed(2)}`;
}

const GROUP_COLOR: Record<string, string> = {
  crypto: "var(--color-accent-500)",
  stable: "#5b8a72",
  staking: "#8a6fb5",
  lending: "#4f7fa8",
  hyperliquid: "#3aa597",
};

/** Hyperliquid account rows read better by what they are than by their unit. */
function holdingLabel(h: Holding): string {
  if (h.group !== "hyperliquid") return h.symbol;
  if (h.venues.some((v) => /perps/i.test(v))) return "Perps account";
  if (h.venues.some((v) => /hlp/i.test(v))) return "HLP vault";
  return "Vault";
}

function HoldingRow({ h }: { h: Holding }) {
  const change = h.change24h;
  const label = holdingLabel(h);
  const showPrice = h.group !== "stable" && h.group !== "hyperliquid";
  return (
    <li className="hold-row">
      <span className="hold-row__main">
        <span className="hold-row__symbol">{label}</span>
        <span className="hold-row__sub">
          {fmtAmount(h.balance)} {h.symbol}
          {showPrice && h.price !== undefined && <> · {fmtPrice(h.price)}</>}
          {change !== undefined && showPrice && (
            <span className={change >= 0 ? "hold-up" : "hold-down"}>
              {" "}
              {change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(1)}%
            </span>
          )}
        </span>
        <span className="hold-row__chains">{h.chains.join(" · ")}</span>
      </span>
      <span className="hold-row__usd">{fmtUsd(h.usd)}</span>
    </li>
  );
}

/**
 * Holdings grouped the way people read a portfolio: crypto with amounts and
 * live prices (24h change), stablecoins, staking & savings, lending (supply,
 * borrow, health factor) and Hyperliquid. A token held on several chains is
 * one row, with its chains listed underneath.
 */
function usePortfolioView(live: LivePortfolio) {
  const { data: prices } = useLivePrices();
  return useMemo(() => {
    const change = (symbol: string) => {
      const base = symbol.toUpperCase().replace(/^W(?=ETH|BTC|HYPE)/, "").replace(/^U(?=ETH|BTC|SOL)/, "");
      const p = prices?.find((e) => e.symbol.toUpperCase() === symbol.toUpperCase() || e.symbol.toUpperCase() === base) as
        | { change24h?: number }
        | undefined;
      return p?.change24h;
    };
    return buildPortfolioView(live.assets, live.aavePositions, change);
  }, [live.assets, live.aavePositions, prices]);
}

/** "▲ $123 (1.2%) today" under the portfolio total, from the holdings' 24h price moves. */
export function PortfolioDayChange({ live }: { live: LivePortfolio }) {
  const view = usePortfolioView(live);
  const d = dayChangeUsd(view);
  if (!d || Math.abs(d.usd) < 0.01) return null;
  const up = d.usd >= 0;
  return (
    <p className={`portfolio-day ${up ? "hold-up" : "hold-down"}`}>
      {up ? "▲" : "▼"} {fmtUsd(Math.abs(d.usd))} ({Math.abs(d.pct).toFixed(2)}%) <span className="text-muted">24h</span>
    </p>
  );
}

export function PortfolioHoldings({ live }: { live: LivePortfolio }) {
  const view = usePortfolioView(live);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  if (view.groups.length === 0) return null;
  const total = view.groups.reduce((s, g) => s + Math.max(0, g.usd), 0);

  return (
    <div className="holdings">
      <div className="holdings__bar" aria-hidden="true">
        {view.groups.map((g) => (
          <div key={g.group} style={{ width: `${total > 0 ? (Math.max(0, g.usd) / total) * 100 : 0}%`, background: GROUP_COLOR[g.group] }} />
        ))}
      </div>
      {view.groups.map((g) => {
        const collapsed = open[g.group] === false;
        return (
          <section key={g.group} className="holdings__group">
            <button
              type="button"
              className="holdings__head"
              aria-expanded={!collapsed}
              onClick={() => setOpen((o) => ({ ...o, [g.group]: collapsed }))}
            >
              <span className="holdings__swatch" style={{ background: GROUP_COLOR[g.group] }} />
              <span className="holdings__label">{g.label}</span>
              <span className="holdings__pct text-muted">{total > 0 ? `${Math.round((Math.max(0, g.usd) / total) * 100)}%` : ""}</span>
              <span className="holdings__usd">{fmtUsd(g.usd)}</span>
              <span className="holdings__chev" aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
            </button>
            {!collapsed &&
              (g.group === "lending" ? (
                <ul className="hold-list">
                  {view.lending.map((l, i) => (
                    <li key={i} className="hold-row">
                      <span className="hold-row__main">
                        <span className="hold-row__symbol">{l.protocol}</span>
                        <span className="hold-row__sub">
                          Supplied {fmtUsd(l.collateralUsd)}
                          {l.debtUsd > 0 && <> · Borrowed {fmtUsd(l.debtUsd)}</>}
                          {l.healthFactor !== null && l.debtUsd > 0 && (
                            <span className={l.healthFactor < 1.3 ? "hold-down" : "hold-up"}> · HF {l.healthFactor.toFixed(2)}</span>
                          )}
                        </span>
                        <span className="hold-row__chains">{l.chain}</span>
                      </span>
                      <span className="hold-row__usd">{fmtUsd(l.collateralUsd - l.debtUsd)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <ul className="hold-list">
                  {g.holdings.map((h) => (
                    <HoldingRow key={`${h.group}-${h.symbol}`} h={h} />
                  ))}
                </ul>
              ))}
          </section>
        );
      })}
    </div>
  );
}
