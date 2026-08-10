"use client";

import { useQuery } from "@tanstack/react-query";
import type { LiveChainOverview } from "@/app/api/chains/route";

/** Compact USD formatting: $900, $12.3k, $456M, $2.1B. */
function fmtUsd(n?: number): string {
  if (typeof n !== "number" || !isFinite(n) || n <= 0) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
}

/**
 * ChainOverview — live chain x protocol coverage, real numbers from DefiLlama's
 * free API (via /api/chains). Each chain shows its total TVL and its biggest
 * protocols by TVL. Falls back gracefully if the upstream API is down.
 */
export function ChainOverview() {
  const { data, isLoading } = useQuery<LiveChainOverview[]>({
    queryKey: ["chains-overview"],
    queryFn: () => fetch("/api/chains").then((r) => r.json()),
    staleTime: 5 * 60_000,
  });

  const chains = Array.isArray(data) ? data : [];
  const live = chains.some((c) => c.live);

  return (
    <>
      <div className="hr" style={{ margin: "var(--space-3) 0" }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h6 style={{ color: "var(--color-accent)", margin: 0 }}>Chains · live coverage</h6>
        <span className="text-muted" style={{ fontSize: 11 }}>
          {live ? "DefiLlama" : isLoading ? "loading…" : "static"}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", marginTop: "var(--space-2)" }}>
        {chains.map((chain) => (
          <div key={chain.id} style={{ padding: "6px 0", borderBottom: "1px solid var(--color-divider)", fontSize: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontFamily: "var(--font-heading)", fontWeight: 600 }}>{chain.name}</span>
              <span className="text-muted" style={{ fontSize: 11 }}>
                TVL {fmtUsd(chain.tvlUsd)}
              </span>
            </div>
            {chain.topProtocols.length === 0 ? (
              <p className="text-muted" style={{ margin: "3px 0 0", fontSize: 11 }}>
                no live data — static registry only
              </p>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                {chain.topProtocols.map((p) => (
                  <span key={p.name} className="tag" style={{ fontSize: 11 }}>
                    {p.name} · {fmtUsd(p.tvlUsd)}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
        {isLoading && (
          <p className="text-muted" style={{ fontSize: 11, margin: "var(--space-2) 0 0" }}>
            Fetching live chain coverage…
          </p>
        )}
      </div>
      <p className="text-muted" style={{ fontSize: 10, margin: "var(--space-2) 0 0" }}>
        TVL + biggest protocols per chain from DefiLlama (free API). Prices for orders come from CoinGecko (free API).
      </p>
    </>
  );
}