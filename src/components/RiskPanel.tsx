import { useState } from "react";
import {
  HEALTH_FACTOR,
  NET_DELTA_ETH,
  RiskSuggestion,
  RISK_SUGGESTIONS,
  STAKING_CONCENTRATION_PCT,
  fmtUsd,
} from "@/lib/data";
import { LivePortfolio } from "@/hooks/useLivePortfolio";
import {
  roundUsd,
  suggestConcentrationReduction,
  suggestDeltaHedge,
  suggestHealthFactorRepay,
} from "@/lib/riskModel";

/**
 * A self-contained mock portfolio used by the dev-only "Simulate a portfolio"
 * toggle. It mirrors what a real connected wallet might hold — spot ETH +
 * staking exposure and an Aave debt position — and exercises the same
 * dynamic risk logic (buildLiveSuggestions) as real data.
 */
const SIMULATED_PORTFOLIO: LivePortfolio = {
  isConnected: true,
  isLoading: false,
  assets: [
    { symbol: "ETH", venue: "Wallet", chain: "Ethereum", balance: 1.0, usd: 4180 },
    { symbol: "stETH", venue: "Lido", chain: "Ethereum", balance: 4.0, usd: 16720 },
    { symbol: "wstETH", venue: "Lido", chain: "Ethereum", balance: 1.0, usd: 4300 },
    { symbol: "WETH", venue: "Wallet", chain: "Ethereum", balance: 0.5, usd: 2090 },
    { symbol: "USDC", venue: "Wallet", chain: "Ethereum", balance: 12000, usd: 12000 },
  ],
  assetsUsd: 39290,
  aavePositions: [
    { chain: "Ethereum", protocol: "Aave v3", collateralUsd: 20000, debtUsd: 8000, availableToBorrowUsd: 5200, ltvPct: 38.4, healthFactor: 1.32 },
  ],
  aaveCollateralUsd: 20000,
  aaveDebtUsd: 8000,
  riskAave: { chain: "Ethereum", protocol: "Aave v3", collateralUsd: 20000, debtUsd: 8000, availableToBorrowUsd: 5200, ltvPct: 38.4, healthFactor: 1.32 },
  healthFactor: 1.32,
  netUsd: 51290,
  netDeltaEth: 6.53,
  perpNetDeltaEth: 0,
  netDeltaEthTotal: 6.53,
  perps: [],
  perpNotionalUsd: 0,
  perpUnrealizedPnl: 0,
  ethPrice: 4180,
  stakingConcentrationPct: 53.5,
};

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

/** Round a dollar amount to a clean, human-parseable figure (nearest $50). Re-exported from riskModel. */

/**
 * Build the three risk suggestions from the live portfolio (when a wallet is
 * connected), instead of the static demo figures in data.ts. Any metric we
 * can't compute (e.g. no Aave debt, already flat delta) is simply omitted.
 */
function buildLiveSuggestions(live: LivePortfolio): RiskSuggestion[] {
  const out: RiskSuggestion[] = [];

  // 1) Aave health factor — size a repay that lifts HF toward a target.
  const hf = live.riskAave?.healthFactor ?? null;
  const repaySug = suggestHealthFactorRepay(hf, live.riskAave?.debtUsd ?? 0);
  if (repaySug && !repaySug.skip && repaySug.repay !== undefined && hf !== null) {
    out.push({
      kind: "healthFactor",
      text: `Repaying ${fmtUsd(roundUsd(repaySug.repay))} on Aave brings your health factor from ${hf.toFixed(
        2,
      )} to about ${repaySug.target.toFixed(2)}.`,
      before: hf,
      after: repaySug.target,
      max: 2.5,
    });
  }

  // 2) Net ETH delta (cross-venue: spot + Hyperliquid perps) — size a hedge to flatten it.
  const netDelta = live.netDeltaEthTotal ?? live.netDeltaEth ?? null;
  const deltaSug = suggestDeltaHedge(netDelta, live.ethPrice);
  if (deltaSug && !deltaSug.skip && deltaSug.shortUsd !== undefined && netDelta !== null) {
    const d = netDelta;
    const side = deltaSug.direction === "short" ? "short" : "long";
    const hedge = deltaSug.direction === "short" ? "Buying" : "Shorting";
    out.push({
      kind: "delta",
      text: `Your tracked spot + Hyperliquid perp book is ${side} ${Math.abs(d).toFixed(
        2,
      )} ETH of net delta. ${hedge} ${fmtUsd(deltaSug.shortUsd)} on Hyperliquid brings it back near flat.`,
      before: Math.abs(d),
      after: 0.02,
      max: 1.0,
    });
  }

  // 3) Staking concentration — size a move out of Lido to hit a target share.
  const concSug = suggestConcentrationReduction(live.netUsd, live.stakingConcentrationPct);
  if (concSug && !concSug.skip && concSug.amount !== undefined && live.stakingConcentrationPct !== null) {
    const c = live.stakingConcentrationPct;
    const amount = concSug.amount;
    const to = c > concSug.target ? concSug.target : Math.min(40, c + 10);
    const directed = c > concSug.target ? "Moving" : "Adding";
    const verb = c > concSug.target ? "cuts" : "lifts";
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
  const label = isLive ? "Net ETH delta · spot + perps" : "Net ETH delta";
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
  const [simulating, setSimulating] = useState(false);
  const effLive = simulating ? SIMULATED_PORTFOLIO : live;
  const isLive = simulating || isConnected;

  const healthFactorValue = isLive ? (effLive?.riskAave?.healthFactor ?? null) : HEALTH_FACTOR;
  const netDelta =
    isLive ? (effLive?.netDeltaEthTotal ?? effLive?.netDeltaEth ?? null) : NET_DELTA_ETH;
  const netDeltaNull = isLive && netDelta == null;
  const stakingConcentration =
    isLive && effLive?.stakingConcentrationPct != null ? effLive.stakingConcentrationPct : STAKING_CONCENTRATION_PCT;
  const suggestions = isLive && effLive ? buildLiveSuggestions(effLive) : RISK_SUGGESTIONS;

  return (
    <>
      <div className="hr" style={{ margin: "var(--space-3) 0" }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h6 style={{ color: "var(--color-accent)", margin: 0 }}>Risk</h6>
        <span className="text-muted" style={{ fontSize: 11 }}>
          {suggestions.length} optimizations
        </span>
      </div>

      {!isConnected && (
        <div style={{ marginTop: "var(--space-2)" }}>
          <button className="btn btn-secondary" style={{ fontSize: 11 }} onClick={() => setSimulating((s) => !s)}>
            {simulating ? "Use demo figures" : "Simulate a portfolio"}
          </button>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", marginTop: "var(--space-2)" }}>
        <HealthFactorGauge value={healthFactorValue} isLive={isLive} chainLabel={effLive?.riskAave?.chain} />
        {isLive && effLive?.riskAave && healthFactorValue !== null && (
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
            <span className="text-muted">Current LTV · Available to borrow</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>
              {effLive.riskAave.ltvPct.toFixed(1)}% · {fmtUsd(effLive.riskAave.availableToBorrowUsd)}
            </span>
          </div>
        )}
        {netDeltaNull ? (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
              <span className="text-muted">Net ETH delta · spot + perps</span>
              <span className="text-muted">—</span>
            </div>
            <p style={{ fontSize: 10, margin: 0 }} className="text-muted">
              No ETH price could be derived from tracked holdings to size the net delta.
            </p>
          </div>
        ) : (
          <NetDeltaBar value={netDelta as number} isLive={isLive} />
        )}

        {isLive && effLive && effLive.perps.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
              <span className="text-muted">Perps (Hyperliquid)</span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmtUsd(effLive.perpNotionalUsd)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }} className="text-muted">
              <span>
                {effLive.perps.length} position{effLive.perps.length > 1 ? "s" : ""} · unrealized{" "}
                {effLive.perpUnrealizedPnl >= 0 ? "+" : ""}
                {fmtUsd(effLive.perpUnrealizedPnl)}
              </span>
              {effLive.perpNetDeltaEth != null && effLive.perpNetDeltaEth !== 0 && (
                <span style={{ fontVariantNumeric: "tabular-nums" }}>
                  ETH delta{" "}
                  {effLive.perpNetDeltaEth >= 0 ? "+" : ""}
                  {effLive.perpNetDeltaEth.toFixed(2)}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      <p style={{ fontSize: 10, margin: "var(--space-2) 0 0" }} className="text-muted">
        {isLive
          ? `Health factor reads live from your Aave v3 position. Net ETH delta and staking concentration are computed from your tracked spot holdings (${Math.round(
              stakingConcentration,
            )}% in Liquid Staking), with any open Hyperliquid perps folded into the delta.`
          : "Example figures. Connect a wallet to compute your real Aave health factor, net ETH delta, and staking concentration."}
        {simulating && " Simulated portfolio shown — connect a wallet for your real numbers."}
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
