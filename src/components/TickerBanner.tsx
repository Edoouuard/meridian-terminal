"use client";

import { TOP_CRYPTO_SYMBOLS } from "@/lib/data";
import { useLivePrices } from "@/hooks/useLivePrices";

function formatTickerPrice(n: number): string {
  if (n >= 100) return "$" + Math.round(n).toLocaleString("en-US");
  if (n >= 1) return "$" + n.toFixed(2);
  return "$" + n.toPrecision(3);
}

interface TickerRow {
  symbol: string;
  price: string;
  change: number;
}

export function TickerBanner() {
  const { data: live } = useLivePrices();
  const liveBySymbol = new Map((live ?? []).map((p) => [p.symbol, p]));

  // Only ever show a symbol CoinGecko actually returned this fetch — never a
  // stale hardcoded price standing in as if it were live.
  const rows: TickerRow[] = TOP_CRYPTO_SYMBOLS.flatMap((symbol) => {
    const l = liveBySymbol.get(symbol);
    return l ? [{ symbol, price: formatTickerPrice(l.price), change: l.change24h }] : [];
  });
  const items = rows.length > 0 ? [...rows, ...rows] : [];

  return (
    <div
      className="ticker-viewport"
      style={{ background: "var(--color-surface)", borderBottom: "1px solid var(--color-divider)", flex: "none" }}
    >
      {items.length === 0 ? (
        <p className="text-muted" style={{ margin: 0, padding: "6px var(--space-3)", fontSize: 12 }}>
          Fetching live prices…
        </p>
      ) : (
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
      )}
    </div>
  );
}
