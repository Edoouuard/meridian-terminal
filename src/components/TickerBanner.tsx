import { TOP_CRYPTOS } from "@/lib/data";

export function TickerBanner() {
  const items = [...TOP_CRYPTOS, ...TOP_CRYPTOS];

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
