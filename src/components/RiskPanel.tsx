import { HEALTH_FACTOR, NET_DELTA_ETH, RiskSuggestion, RISK_SUGGESTIONS, fmtUsd } from "@/lib/data";

type Status = "good" | "warning" | "serious";

function statusColor(status: Status): string {
  if (status === "good") return "var(--risk-good)";
  if (status === "warning") return "var(--risk-warning)";
  return "var(--risk-serious)";
}

function healthFactorStatus(v: number): Status {
  return v < 1.15 ? "serious" : v < 1.6 ? "warning" : "good";
}
function deltaStatus(absV: number): Status {
  return absV < 0.15 ? "good" : absV < 0.8 ? "warning" : "serious";
}
function concentrationStatus(v: number): Status {
  return v < 20 ? "good" : v < 40 ? "warning" : "serious";
}

function statusFor(kind: RiskSuggestion["kind"], value: number): Status {
  if (kind === "healthFactor") return healthFactorStatus(value);
  if (kind === "delta") return deltaStatus(Math.abs(value));
  return concentrationStatus(value);
}

function formatValue(kind: RiskSuggestion["kind"], value: number): string {
  if (kind === "healthFactor") return value.toFixed(2);
  if (kind === "delta") return `${value >= 0 ? "+" : ""}${value.toFixed(2)} ETH`;
  return `${value}%`;
}

function HealthFactorGauge({ value, isLive }: { value: number | null; isLive: boolean }) {
  const label = isLive ? "Lowest health factor · Aave (live)" : "Lowest health factor · Aave (example)";

  if (value === null) {
    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
          <span className="text-muted">{label}</span>
          <span style={{ color: "var(--risk-good)", fontWeight: 600 }}>No debt</span>
        </div>
        <div style={{ height: 8, borderRadius: 4, background: "var(--risk-good)" }} />
        <p style={{ fontSize: 10, margin: "3px 0 0" }} className="text-muted">
          No open borrows on Aave — nothing at liquidation risk.
        </p>
      </div>
    );
  }

  const max = 2.5;
  const seriousEnd = 1.15;
  const warningEnd = 1.6;
  const status = healthFactorStatus(value);
  const markerPct = Math.min(100, (value / max) * 100);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
        <span className="text-muted">{label}</span>
        <span style={{ fontVariantNumeric: "tabular-nums", color: statusColor(status), fontWeight: 600 }}>{value.toFixed(2)}</span>
      </div>
      <div style={{ position: "relative", height: 8, borderRadius: 4, overflow: "visible", display: "flex" }}>
        <div style={{ width: `${(seriousEnd / max) * 100}%`, background: "var(--risk-serious)", borderRadius: "4px 0 0 4px" }} />
        <div style={{ width: `${((warningEnd - seriousEnd) / max) * 100}%`, background: "var(--risk-warning)" }} />
        <div style={{ width: `${((max - warningEnd) / max) * 100}%`, background: "var(--risk-good)", borderRadius: "0 4px 4px 0" }} />
        <div
          style={{
            position: "absolute",
            left: `${markerPct}%`,
            top: -2,
            bottom: -2,
            width: 2,
            marginLeft: -1,
            background: "var(--color-text)",
            borderRadius: 1,
          }}
        />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginTop: 3 }} className="text-muted">
        <span>Liquidation · 1.0</span>
        <span>Safe · 1.6+</span>
      </div>
    </div>
  );
}

function NetDeltaBar() {
  const max = 1.5;
  const status = deltaStatus(Math.abs(NET_DELTA_ETH));
  const halfPct = Math.min(50, (Math.abs(NET_DELTA_ETH) / max) * 50);
  const isPositive = NET_DELTA_ETH >= 0;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
        <span className="text-muted">Net ETH delta</span>
        <span style={{ fontVariantNumeric: "tabular-nums", color: statusColor(status), fontWeight: 600 }}>
          {isPositive ? "+" : ""}
          {NET_DELTA_ETH.toFixed(2)} ETH
        </span>
      </div>
      <div style={{ position: "relative", height: 8, borderRadius: 4, background: "var(--color-neutral-200)", overflow: "hidden" }}>
        <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "var(--color-divider)" }} />
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            [isPositive ? "left" : "right"]: "50%",
            width: `${halfPct}%`,
            background: statusColor(status),
          }}
        />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginTop: 3 }} className="text-muted">
        <span>Short</span>
        <span>Flat</span>
        <span>Long</span>
      </div>
    </div>
  );
}

function SuggestionBar({ suggestion }: { suggestion: RiskSuggestion }) {
  const beforeStatus = statusFor(suggestion.kind, suggestion.before);
  const afterStatus = statusFor(suggestion.kind, suggestion.after);
  const beforePct = Math.min(100, (Math.abs(suggestion.before) / suggestion.max) * 100);
  const afterPct = Math.min(100, (Math.abs(suggestion.after) / suggestion.max) * 100);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <p style={{ fontSize: 12, margin: 0, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>{suggestion.text}</p>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 30, flex: "none", fontSize: 10 }} className="text-muted">
          Now
        </span>
        <div style={{ flex: 1, height: 6, borderRadius: 3, background: "var(--color-neutral-200)", overflow: "hidden" }}>
          <div style={{ width: `${beforePct}%`, height: "100%", background: statusColor(beforeStatus), borderRadius: 3 }} />
        </div>
        <span style={{ width: 56, flex: "none", textAlign: "right", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
          {formatValue(suggestion.kind, suggestion.before)}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 30, flex: "none", fontSize: 10 }} className="text-muted">
          After
        </span>
        <div style={{ flex: 1, height: 6, borderRadius: 3, background: "var(--color-neutral-200)", overflow: "hidden" }}>
          <div style={{ width: `${afterPct}%`, height: "100%", background: statusColor(afterStatus), borderRadius: 3 }} />
        </div>
        <span style={{ width: 56, flex: "none", textAlign: "right", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
          {formatValue(suggestion.kind, suggestion.after)}
        </span>
      </div>
    </div>
  );
}

export function RiskPanel({
  liveHealthFactor,
  liveAvailableToBorrowUsd,
  liveLtvPct,
}: {
  liveHealthFactor?: number | null;
  liveAvailableToBorrowUsd?: number;
  liveLtvPct?: number | null;
}) {
  const isLive = liveHealthFactor !== undefined;
  const healthFactorValue = isLive ? liveHealthFactor : HEALTH_FACTOR;

  return (
    <>
      <div className="hr" style={{ margin: "var(--space-3) 0" }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h6 style={{ color: "var(--color-accent)", margin: 0 }}>Risk</h6>
        <span className="text-muted" style={{ fontSize: 11 }}>
          {RISK_SUGGESTIONS.length} optimizations
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", marginTop: "var(--space-2)" }}>
        <HealthFactorGauge value={healthFactorValue} isLive={isLive} />
        {isLive && liveHealthFactor !== null && liveLtvPct != null && (
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
            <span className="text-muted">Current LTV · Available to borrow</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>
              {liveLtvPct.toFixed(1)}% · {fmtUsd(liveAvailableToBorrowUsd ?? 0)}
            </span>
          </div>
        )}
        <NetDeltaBar />
      </div>

      <p style={{ fontSize: 10, margin: "var(--space-2) 0 0" }} className="text-muted">
        {isLive
          ? "Health factor reads live from your Aave v3 position."
          : "Example figures — connect a wallet to see your real Aave health factor."}{" "}
        Net delta and the suggestions below are illustrative until more protocols are connected.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", marginTop: "var(--space-3)" }}>
        {RISK_SUGGESTIONS.map((s, i) => (
          <SuggestionBar key={i} suggestion={s} />
        ))}
      </div>
    </>
  );
}
