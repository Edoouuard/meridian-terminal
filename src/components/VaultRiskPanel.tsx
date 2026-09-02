"use client";

import { useVaultRisk } from "@/hooks/useVaultRisk";
import type { RiskTier } from "@/lib/integrations/philidor";

/** Compact USD formatting: $900, $12.3k, $456M, $2.1B. */
function fmtUsd(n?: number): string {
  if (typeof n !== "number" || !isFinite(n) || n <= 0) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

const TIER_COLOR: Record<RiskTier, string> = {
  Prime: "var(--risk-good)",
  Core: "var(--risk-warning)",
  Edge: "var(--risk-serious)",
};

/** Protocols Meridian routes orders to that Philidor also scores (see PHILIDOR_PROTOCOL_ID). */
const TRACKED_PROTOCOLS = "Aave,Morpho,Compound,Spark";

/**
 * VaultRiskPanel — live vault risk scores from Philidor's free DeFi vault
 * risk API (same data as the "Philidor DeFi Vault Risk Analytics" MCP
 * server; see src/lib/integrations/philidor.ts). Shows the safest
 * (highest-scored) vaults across the lending protocols the terminal actually
 * routes orders to, so a supply/lend thesis can be checked against real
 * third-party risk data before it is executed. Falls back to nothing shown
 * (not a broken UI) if the upstream API is unavailable.
 */
export function VaultRiskPanel() {
  const { data, isLoading } = useVaultRisk({ protocol: TRACKED_PROTOCOLS, limit: 6 });
  const vaults = data ?? [];

  return (
    <>
      <div className="hr" style={{ margin: "var(--space-3) 0" }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h6 style={{ color: "var(--color-accent)", margin: 0 }}>Vault risk · live</h6>
        <span className="text-muted" style={{ fontSize: 11 }}>
          {vaults.length > 0 ? "Philidor" : isLoading ? "loading…" : "unavailable"}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", marginTop: "var(--space-2)" }}>
        {vaults.map((v) => (
          <div key={v.id} style={{ padding: "6px 0", borderBottom: "1px solid var(--color-divider)", fontSize: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontFamily: "var(--font-heading)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {v.name}
              </span>
              <span style={{ color: TIER_COLOR[v.riskTier], flex: "none", fontVariantNumeric: "tabular-nums" }}>
                {v.riskTier} · {v.riskScore.toFixed(1)}
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3 }} className="text-muted">
              <span>
                {v.protocol} · {v.chain}
              </span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                TVL {fmtUsd(v.tvlUsd)} · {fmtPct(v.aprNet)} net
              </span>
            </div>
          </div>
        ))}
        {!isLoading && vaults.length === 0 && (
          <p className="text-muted" style={{ fontSize: 11, margin: 0 }}>
            No live vault risk data right now.
          </p>
        )}
        {isLoading && (
          <p className="text-muted" style={{ fontSize: 11, margin: "var(--space-2) 0 0" }}>
            Fetching live vault risk…
          </p>
        )}
      </div>
      <p className="text-muted" style={{ fontSize: 10, margin: "var(--space-2) 0 0" }}>
        Risk scores (0–10, Prime/Core/Edge) from Philidor&apos;s free vault risk API — 40% asset quality, 40% platform
        code maturity, 20% governance.
      </p>
    </>
  );
}
