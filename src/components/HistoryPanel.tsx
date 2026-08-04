"use client";

import { clearHistory, useHistory, type OrderRecord, type OrderStatus } from "@/lib/history";

/** Short "12:04" clock format for the recorded timestamp. */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Tiny helper for e.g. "1.2 ETH" + protocol. */
function fmtAmount(rec: OrderRecord): string {
  const parts = [rec.amount, rec.asset].filter(Boolean).join(" ");
  return parts || "—";
}

const STATUS_META: Record<OrderStatus, { label: string; color: string; bg: string }> = {
  confirmed: { label: "confirmed", color: "#7d5411", bg: "#fff3e4" },
  error: { label: "error", color: "#b03a2e", bg: "#fbeeea" },
  pending: { label: "pending", color: "#605d5d", bg: "#efecec" },
};

function shortHash(hash: string): string {
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

function HistoryRow({ rec }: { rec: OrderRecord }) {
  const meta = STATUS_META[rec.status] ?? STATUS_META.pending;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 8,
        padding: "6px 0",
        borderBottom: "1px solid var(--color-divider)",
        fontSize: 12,
      }}
    >
      <span className="text-muted" style={{ flex: "none", fontVariantNumeric: "tabular-nums", fontSize: 11 }}>
        {fmtTime(rec.ts)}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {rec.label}
        </span>
        {rec.asset && (
          <span className="text-muted" style={{ display: "block", fontSize: 11 }}>
            {fmtAmount(rec)}
            {rec.protocol ? <span> · {rec.protocol}</span> : null}
          </span>
        )}
        {rec.hash && (
          <span className="text-muted" style={{ display: "block", fontSize: 10, fontVariantNumeric: "tabular-nums" }}>
            {shortHash(rec.hash)}
          </span>
        )}
      </span>
      <span
        style={{
          flex: "none",
          fontSize: 10,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          padding: "2px 8px",
          borderRadius: 6,
          background: meta.bg,
          color: meta.color,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {meta.label}
      </span>
    </div>
  );
}

/**
 * Recent order history panel. Reads the localStorage order log via `useHistory`
 * (kept live by the internal emitter + storage events) and renders it as a
 * compact list with a Clear button. Empty state when nothing has been logged.
 */
export function HistoryPanel() {
  const history = useHistory();

  return (
    <div className="card" style={{ marginTop: "var(--space-3)", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 12, fontWeight: 600, fontFamily: "var(--font-heading)", color: "var(--color-accent)" }}>
          Recent orders
        </span>
        {history.length > 0 && (
          <button
            className="btn btn-secondary"
            style={{ fontSize: 11, padding: "2px 10px", minHeight: 0 }}
            onClick={() => clearHistory()}
          >
            Clear
          </button>
        )}
      </div>

      {history.length === 0 ? (
        <p style={{ margin: 0, fontSize: 12 }} className="text-muted">
          No orders yet — executed trades will appear here.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {history.map((rec) => (
            <HistoryRow key={rec.id} rec={rec} />
          ))}
        </div>
      )}
    </div>
  );
}
