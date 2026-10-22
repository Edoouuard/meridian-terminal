"use client";

import { useQuery } from "@tanstack/react-query";
import type { LiveChainOverview } from "@/app/api/chains/route";
import { AskButton } from "@/components/AskButton";
import { executableCoverage, PERP_VENUES } from "@/lib/coverage";
import { FEATURES } from "@/lib/features";

const COVERAGE = executableCoverage();

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
 * ChainOverview — what Meridian executes on each chain (lib/coverage.ts, read
 * from the execution code's own tables) next to the chain's live TVL and
 * biggest protocols from DefiLlama's free API (via /api/chains). Falls back
 * to the coverage alone if the upstream API is down.
 */
export function ChainOverview({ hideDivider }: { hideDivider?: boolean } = {}) {
  const { data, isLoading } = useQuery<LiveChainOverview[]>({
    queryKey: ["chains-overview"],
    queryFn: () => fetch("/api/chains", { cache: "no-store" }).then((r) => r.json()),
    staleTime: 5 * 60_000,
  });

  // DefiLlama down or slow: the chains Meridian executes on still show, with their protocols.
  const fetched = Array.isArray(data) ? data : [];
  const chains: LiveChainOverview[] = fetched.length > 0 || isLoading ? fetched : COVERAGE.chains.map((c) => ({ id: String(c.chainId), name: c.name, chainId: c.chainId, topProtocols: [], live: false }));
  const live = chains.some((c) => c.live);

  return (
    <>
      {!hideDivider && <div className="hr" style={{ margin: "var(--space-3) 0" }} />}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h6 className="panel-card__title">Chains</h6>
        <span className="text-muted" style={{ fontSize: 11 }}>
          {live ? "DefiLlama · live" : isLoading ? "loading…" : "offline"}
        </span>
      </div>

      <div className="coverage-summary">
        <div>
          <strong>{COVERAGE.chains.length}</strong> chains
        </div>
        <div>
          <strong>{COVERAGE.protocols.length}</strong> protocols
        </div>
        {FEATURES.perps && (
          <div>
            <strong>{PERP_VENUES.length}</strong> perp venues
          </div>
        )}
      </div>
      <p className="text-muted" style={{ fontSize: 10, margin: "4px 0 0" }}>
        Executable from Meridian today: {COVERAGE.protocols.join(", ")}
        {FEATURES.perps ? `; perps on ${PERP_VENUES.join(", ")}` : ""}.
      </p>

      <div style={{ display: "flex", flexDirection: "column", marginTop: "var(--space-2)" }}>
        {!live && !isLoading && chains.length > 0 && (
          <p className="text-muted" style={{ fontSize: 11, margin: "0 0 var(--space-2)" }}>
            Live TVL is unavailable right now. Strategies still use live rates.
          </p>
        )}
        {chains.map((chain) => (
          <div key={chain.id} className="chain-row">
            <div className="chain-row__head">
              <span className="chain-row__name">{chain.name}</span>
              {chain.tvlUsd ? <span className="chain-row__tvl">TVL {fmtUsd(chain.tvlUsd)}</span> : null}
            </div>
            <ExecutableOn chainId={chain.chainId} />
            {chain.topProtocols.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 5 }}>
                {chain.topProtocols.map((p) => (
                  <span key={p.name} className="protocol-pill">
                    {p.name} · {fmtUsd(p.tvlUsd)}
                  </span>
                ))}
              </div>
            )}
            <AskButton label={`Best yield on ${chain.name}`} prompt={`What's the best yield on my stablecoins on ${chain.name} right now? Compare the options there.`} />
          </div>
        ))}
        {isLoading && (
          <p className="text-muted" style={{ fontSize: 11, margin: "var(--space-2) 0 0" }}>
            Fetching live chain coverage…
          </p>
        )}
      </div>
      <p className="text-muted" style={{ fontSize: 10, margin: "var(--space-2) 0 0" }}>
        &quot;Meridian&quot;: protocols Meridian signs into on that chain (from its own contract tables). TVL and biggest protocols per chain from DefiLlama (free API). Prices for orders come from CoinGecko (free API).
      </p>
    </>
  );
}
/** The protocols Meridian signs into on a chain. */
function ExecutableOn({ chainId }: { chainId?: number }) {
  const exec = COVERAGE.chains.find((c) => c.chainId === chainId)?.protocols ?? [];
  if (exec.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 5 }} title="Protocols Meridian signs into on this chain">
      <span className="text-muted" style={{ fontSize: 10, alignSelf: "center" }}>
        Meridian · {exec.length}
      </span>
      {exec.map((p) => (
        <span key={p} className="protocol-pill protocol-pill--exec">
          {p}
        </span>
      ))}
    </div>
  );
}
