"use client";

import { TOP_CRYPTOS } from "@/lib/data";
import { useLivePrices } from "@/hooks/useLivePrices";

function formatTickerPrice(n: number): string {
  if (n >= 100) return "$" + Math.round(n).toLocaleString("en-US");
  if (n >= 1) return "$" + n.toFixed(2);
  return "$" + n.toPrecision(3);
}

export function TickerBanner() {
  const { data: live } = useLivePrices();
  const liveBySymbol = new Map((live ?? []).map((p) => [p.symbol, p]));

  const merged = TOP_CRYPTOS.map((c) => {
    const l = liveBySymbol.get(c.symbol);
    return l ? { symbol: c.symbol, price: formatTickerPrice(l.price), change: l.change24h } : c;
  });
  const items = [...merged, ...merged];

  return (
    <div
      className="ticker-viewport"
      style={{ background: "var(--color-surface)", borderBottom: "1px solid var(--color-divider)", flex: "none" }}
    >
      <div className="ticker-track" style={{ padding: "6px 0" }}>
        {items.map((c, i) => (
          <span
            key={i}
            style={{
              display: "inline-flex",
              alignItems: "baseline",
              gap: 6,
              padding: "0 var(--space-3)",
              fontSize: 12,
              borderRight: "1px solid var(--color-divider)",
              flex: "none",
            }}
          >
            <strong style={{ fontFamily: "var(--font-heading)" }}>{c.symbol}</strong>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{c.price}</span>
            <span
              style={{
                fontVariantNumeric: "tabular-nums",
                color: c.change > 0 ? "var(--risk-good)" : c.change < 0 ? "var(--risk-serious)" : "var(--color-text)",
              }}
            >
              {c.change > 0 ? "+" : ""}
              {c.change.toFixed(1)}%
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
