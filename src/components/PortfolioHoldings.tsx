"use client";

import { useMemo, useState } from "react";
import type { LivePortfolio } from "@/hooks/useLivePortfolio";
import { useLivePrices } from "@/hooks/useLivePrices";
import { allocationSlices, buildPortfolioView, dayChangeUsd, fmtAmount, fmtPrice, type Holding, type PortfolioView } from "@/lib/portfolioView";

function fmtUsd(v: number): string {
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  return a >= 1000 ? `${sign}$${Math.round(a).toLocaleString("en-US")}` : `${sign}$${a.toFixed(2)}`;
}

/*
 * Categorical slots in fixed order (validated: lightness band, chroma, CVD and
 * normal-vision separation on the light surface). Every slice also has a
 * legend row with its label, share and value, so colour never carries
 * identity alone. A colour follows its entity, never its rank.
 */
const SLOT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"] as const;
const OTHER_COLOR = "#9a9993";

const GROUP_COLOR: Record<string, string> = {
  crypto: SLOT[0],
  stable: SLOT[1],
  staking: SLOT[2],
  lending: SLOT[3],
  hyperliquid: SLOT[4],
};

/** Fixed colour per chain; any other chain folds into "Other". */
const CHAIN_COLOR: Record<string, string> = {
  Ethereum: SLOT[0],
  Base: SLOT[1],
  Arbitrum: SLOT[2],
  Optimism: SLOT[3],
  Hyperliquid: SLOT[4],
};
/** HyperEVM is Hyperliquid's EVM: one slice for the ecosystem. */
const CHAIN_GROUP: Record<string, string> = { HyperEVM: "Hyperliquid" };

function fmtUsdShort(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (a >= 10_000) return `$${(v / 1000).toFixed(1)}k`;
  return fmtUsd(v);
}

/**
 * Allocation donut: share of the portfolio by holding type or by chain, with
 * a legend that doubles as the table view (label, share, value). Hovering a
 * slice or its row highlights both and puts it in the centre.
 */
function AllocationDonut({ view }: { view: PortfolioView }) {
  const [by, setBy] = useState<"type" | "chain">("type");
  const [hover, setHover] = useState<string | null>(null);

  const slices = useMemo(() => {
    const raw = allocationSlices(view, by, 6);
    if (by === "type") return raw.map((sl) => ({ ...sl, color: GROUP_COLOR[sl.key] ?? OTHER_COLOR }));
    // Chains without a fixed colour join "Other" so no colour repeats.
    const merged = new Map<string, (typeof raw)[number]>();
    for (const sl of raw) {
      const key = CHAIN_GROUP[sl.key] ?? sl.key;
      const prev = merged.get(key);
      merged.set(key, prev ? { ...prev, usd: prev.usd + sl.usd, share: prev.share + sl.share } : { ...sl, key, label: key });
    }
    const grouped = [...merged.values()].sort((a, b) => b.usd - a.usd);
    const named = grouped.filter((sl) => CHAIN_COLOR[sl.key]);
    const rest = grouped.filter((sl) => !CHAIN_COLOR[sl.key]);
    const out = named.map((sl) => ({ ...sl, color: CHAIN_COLOR[sl.key] }));
    if (rest.length) {
      out.push({
        key: "other",
        label: rest.length === 1 && rest[0].key !== "other" ? rest[0].label : "Other",
        usd: rest.reduce((a, r) => a + r.usd, 0),
        share: rest.reduce((a, r) => a + r.share, 0),
        color: OTHER_COLOR,
      });
    }
    return out;
  }, [view, by]);

  if (slices.length === 0) return null;
  const total = slices.reduce((a, sl) => a + sl.usd, 0);
  const R = 52;
  const C = 2 * Math.PI * R;
  const GAP = slices.length > 1 ? 2 : 0; // 2px surface gap between segments
  const arcs = slices.map((sl, i) => ({
    ...sl,
    len: Math.max(0, sl.share * C - GAP),
    start: slices.slice(0, i).reduce((a, p) => a + p.share * C, 0),
  }));
  const focus = slices.find((sl) => sl.key === hover);
  const describe = slices.map((sl) => `${sl.label} ${Math.round(sl.share * 100)}%`).join(", ");

  return (
    <div className="alloc">
      <div className="alloc__tabs" role="tablist" aria-label="Allocation view">
        {(["type", "chain"] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={by === k} className={by === k ? "is-on" : undefined} onClick={() => { setBy(k); setHover(null); }}>
            {k === "type" ? "By type" : "By chain"}
          </button>
        ))}
      </div>
      <div className="alloc__body">
        <svg className="alloc__donut" viewBox="0 0 140 140" role="img" aria-label={`Portfolio allocation ${by === "type" ? "by type" : "by chain"}: ${describe}`}>
          <circle cx="70" cy="70" r={R} fill="none" stroke="var(--color-divider)" strokeWidth="14" />
          {arcs.map((a) => (
            <circle
              key={a.key}
              cx="70"
              cy="70"
              r={R}
              fill="none"
              stroke={a.color}
              strokeWidth={hover === a.key ? 18 : 14}
              strokeDasharray={`${a.len} ${C - a.len}`}
              strokeDashoffset={-a.start}
              transform="rotate(-90 70 70)"
              opacity={hover && hover !== a.key ? 0.45 : 1}
              style={{ transition: "stroke-width 0.15s ease, opacity 0.15s ease", cursor: "pointer" }}
              onMouseEnter={() => setHover(a.key)}
              onMouseLeave={() => setHover(null)}
            >
              <title>{`${a.label}: ${(a.share * 100).toFixed(1)}% · ${fmtUsd(a.usd)}`}</title>
            </circle>
          ))}
          <text x="70" y="67" textAnchor="middle" className="alloc__center-value">
            {focus ? `${(focus.share * 100).toFixed(focus.share < 0.1 ? 1 : 0)}%` : fmtUsdShort(total)}
          </text>
          <text x="70" y="83" textAnchor="middle" className="alloc__center-label">
            {focus ? focus.label : by === "type" ? "by type" : "by chain"}
          </text>
        </svg>
        <ul className="alloc__legend">
          {slices.map((sl) => (
            <li
              key={sl.key}
              className={hover === sl.key ? "is-hover" : undefined}
              onMouseEnter={() => setHover(sl.key)}
              onMouseLeave={() => setHover(null)}
            >
              <span className="alloc__swatch" style={{ background: sl.color }} aria-hidden="true" />
              <span className="alloc__name">{sl.label}</span>
              <span className="alloc__pct">{(sl.share * 100).toFixed(sl.share < 0.1 ? 1 : 0)}%</span>
              <span className="alloc__usd">{fmtUsd(sl.usd)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

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
      <AllocationDonut view={view} />
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
