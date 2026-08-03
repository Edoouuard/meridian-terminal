import {
  HEALTH_FACTOR,
  NET_DELTA_ETH,
  RiskSuggestion,
  RISK_SUGGESTIONS,
  STAKING_CONCENTRATION_PCT,
  fmtUsd,
} from "@/lib/data";
import { LivePortfolio } from "@/hooks/useLivePortfolio";

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

/** Round a dollar amount to a clean, human-parseable figure (nearest $50). */
function roundUsd(n: number): number {
  return Math.round(n / 50) * 50;
}

/**
 * Build the three risk suggestions from the live portfolio (when a wallet is
 * connected), instead of the static demo figures in data.ts. Any metric we
 * can't compute (e.g. no Aave debt, already flat delta) is simply omitted.
 */
function buildLiveSuggestions(live: LivePortfolio): RiskSuggestion[] {
  const out: RiskSuggestion[] = [];

  // 1) Aave health factor — size a repay that lifts HF toward a target.
  const hf = live.riskAave?.healthFactor;
  const debt = live.riskAave?.debtUsd ?? 0;
  if (hf != null && hf < 1.95 && debt > 0) {
    const target = 1.8;
    // HF = (collateral * liqThreshold) / debt  ⇒  repay R → HF' = HF * debt / (debt - R)
    const repay = debt * (1 - hf / target);
    if (repay > 50) {
      out.push({
        kind: "healthFactor",
        text: `Repaying ${fmtUsd(roundUsd(repay))} on Aave brings your health factor from ${hf.toFixed(
          2,
        )} to about ${target.toFixed(2)}.`,
        before: hf,
        after: target,
        max: 2.5,
      });
    }
  }

  // 2) Net ETH delta — size a perp hedge to flatten the tracked spot book.
  const d = live.netDeltaEth;
  if (d != null && Math.abs(d) >= 0.15 && live.ethPrice && live.ethPrice > 0) {
    const shortUsd = roundUsd(Math.abs(d) * live.ethPrice);
    const side = d > 0 ? "long" : "short";
    const hedge = d > 0 ? "Shorting" : "Buying";
    if (shortUsd > 100) {
      out.push({
        kind: "delta",
        text: `Your tracked spot holdings are ${side} ${Math.abs(d).toFixed(
          2,
        )} ETH of net delta. ${hedge} ${fmtUsd(shortUsd)} on Hyperliquid brings it back near flat.`,
        before: Math.abs(d),
        after: 0.02,
        max: 1.0,
      });
    }
  }

  // 3) Staking concentration — size a move out of Lido to hit a target share.
  const c = live.stakingConcentrationPct;
  if (c != null && c >= 20 && c <= 97 && live.netUsd > 0) {
    const target = 30;
    const amount = (live.netUsd * (c - target)) / 100;
    if (amount > 1000) {
      const to = c > target ? target : Math.min(40, c + 10);
      const directed = c > target ? "Moving" : "Adding";
      const verb = c > target ? "cuts" : "lifts";
      out.push({
        kind: "concentration",
        text: `${c.toFixed(0)}% of your portfolio sits in liquid staking/restaking (stETH + wstETH) via Lido. ${directed} ${fmtUsd(
          roundUsd(amount),
        )} into PT weETH ${verb} Lido concentration to ~${to.toFixed(0)}% while locking a fixed yield.`,
        before: c,
        after: to,
        max: 100,
      });
    }
  }

  return out;
}

function HealthFactorGauge({ value, isLive, chainLabel }: { value: number | null; isLive: boolean; chainLabel?: string }) {
  const label = isLive ? `Lowest health factor · Aave${chainLabel ? ` (${chainLabel})` : ""}` : "Lowest health factor · Aave (example)";

  if (value === null) {
    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
          <span className="text-muted">{label}</span>
          <span style={{ color: "var(--risk-good)", fontWeight: 600 }}>No debt</span>
        </div>
        <div style={{ height: 8, borderRadius: 4, background: "var(--risk-good)" }} />
        <p style={{ fontSize: 10, margin: "3px 0 0" }} className="text-muted">
          No open borrows on Aave, so nothing is at liquidation risk.
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

function NetDeltaBar({ value, isLive }: { value: number; isLive: boolean }) {
  const max = 1.5;
  const label = isLive ? "Net spot ETH delta" : "Net ETH delta";
  const status = deltaStatus(Math.abs(value));
  const halfPct = Math.min(50, (Math.abs(value) / max) * 50);
  const isPositive = value >= 0;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
        <span className="text-muted">{label}</span>
        <span style={{ fontVariantNumeric: "tabular-nums", color: statusColor(status), fontWeight: 600 }}>
          {isPositive ? "+" : ""}
          {value.toFixed(2)} ETH
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

export function RiskPanel({ live, isConnected }: { live?: LivePortfolio; isConnected: boolean }) {
  const isLive = isConnected;
  const healthFactorValue = isLive ? (live?.riskAave?.healthFactor ?? null) : HEALTH_FACTOR;
  const netDelta = isLive && live?.netDeltaEth != null ? live.netDeltaEth : NET_DELTA_ETH;
  const stakingConcentration = isLive && live?.stakingConcentrationPct != null ? live.stakingConcentrationPct : STAKING_CONCENTRATION_PCT;
  const suggestions = isLive && live ? buildLiveSuggestions(live) : RISK_SUGGESTIONS;

  return (
    <>
      <div className="hr" style={{ margin: "var(--space-3) 0" }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h6 style={{ color: "var(--color-accent)", margin: 0 }}>Risk</h6>
        <span className="text-muted" style={{ fontSize: 11 }}>
          {suggestions.length} optimizations
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", marginTop: "var(--space-2)" }}>
        <HealthFactorGauge value={healthFactorValue} isLive={isLive} chainLabel={live?.riskAave?.chain} />
        {isLive && live?.riskAave && healthFactorValue !== null && (
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
            <span className="text-muted">Current LTV · Available to borrow</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>
              {live.riskAave.ltvPct.toFixed(1)}% · {fmtUsd(live.riskAave.availableToBorrowUsd)}
            </span>
          </div>
        )}
        <NetDeltaBar value={netDelta} isLive={isLive} />
      </div>

      <p style={{ fontSize: 10, margin: "var(--space-2) 0 0" }} className="text-muted">
        {isLive
          ? `Health factor reads live from your Aave v3 position. Net ETH delta and staking concentration are computed from your tracked spot holdings (${Math.round(
              stakingConcentration,
            )}% in Liquid Staking).`
          : "Example figures. Connect a wallet to compute your real Aave health factor, net ETH delta, and staking concentration."}
        {" "}
        Perps on Hyperliquid/Extended {"aren't"} wired up yet, so perp delta is not included here.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", marginTop: "var(--space-3)" }}>
        {suggestions.map((s, i) => (
          <SuggestionBar key={i} suggestion={s} />
        ))}
        {suggestions.length === 0 && (
          <p style={{ fontSize: 12, margin: 0 }} className="text-muted">
            Your book looks healthy — no risk optimizations to suggest right now.
          </p>
        )}
      </div>
    </>
  );
}
