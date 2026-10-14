"use client";

import { useMemo } from "react";
import { useAccount } from "wagmi";
import { resolveOrderForLeg } from "@/lib/assetMap";
import type { Order } from "@/lib/execution";
import { legChainId } from "@/lib/chains";
import type { TradeLeg, TradePlan } from "@/lib/tradePlan";
import { StrategyLegContext } from "@/components/thread/strategyLegContext";
import { useLivePrices } from "@/hooks/useLivePrices";
import { useBestYield } from "@/hooks/useBestYield";
import { useHlpApr, useLlpApr } from "@/hooks/useVaultYields";
import { ValidatedExecuteButton } from "@/components/ValidatedExecuteButton";
import { MorphoExecuteButton } from "@/components/execute/VenueExecuteButtons";
import { NotWired, OrderRow, isUnsupported } from "@/components/thread/shared";

/** One honest row for a single yield option inside YieldFinderCard — a real Execute button when the venue is wired (Aave/Morpho/Compound), an honest "not wired" note with the real APY otherwise (vault deposits, LP pools, every other DefiLlama-tracked protocol). */
function YieldOptionRow({ option, asset, sizeUsd }: { option: MergedYieldOption; asset: string; sizeUsd: number }) {
  const { data: prices } = useLivePrices();
  const { chain } = useAccount();
  const leg: TradeLeg = { side: "Supply", asset, protocol: option.protocol, sizeUsd, chain: option.chain };
  const resolved = resolveOrderForLeg(leg, undefined, prices, legChainId(leg, chain?.id));
  const isMorpho = option.protocol === "Morpho";
  // A one-step strategy, so the deposit is tracked in the Strategies tab and celebrated like any other.
  const plan: TradePlan = useMemo(
    () => ({
      intent: "supply",
      asset,
      sizeUsd,
      summary: `Supply ${asset} on ${option.protocol} (${option.chain}).`,
      variantLabel: `${option.protocol} ${asset} on ${option.chain}`,
      apyPct: option.apy,
      legs: [leg],
    }),
    // leg is rebuilt each render from these same values
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [asset, sizeUsd, option.protocol, option.chain, option.apy],
  );
  const wired = option.wired && (isMorpho || !isUnsupported(resolved));

  return (
    <div style={{ padding: "4px 0" }}>
      <OrderRow
        label={`${option.protocol} · ${option.chain}`}
        value={`${option.apy.toFixed(2)}% ${option.kind === "lp" ? "APY (LP)" : option.kind === "vault" ? "APR (vault)" : "APY"}`}
        valueColor="var(--color-accent-700)"
      />
      {option.vaultNote && (
        <p className="text-muted" style={{ fontSize: 10, margin: "2px 0 0" }}>
          {option.vaultNote}
        </p>
      )}
      {wired ? (
        <StrategyLegContext.Provider value={{ plan, legIndex: 0 }}>
          {isMorpho ? (
            <MorphoExecuteButton leg={leg} prices={prices} />
          ) : (
            <ValidatedExecuteButton order={resolved as Order} label={`Execute on ${option.protocol} →`} />
          )}
        </StrategyLegContext.Provider>
      ) : (
        <NotWired
          venue={option.protocol}
          reason={
            option.kind === "vault"
              ? `${option.protocol} deposit isn't wired for one-click execution yet — this is a real live rate, not something you can act on from here today.`
              : option.kind === "lp"
                ? `${option.protocol} liquidity provision carries impermanent-loss risk and isn't wired for one-click execution yet.`
                : `${option.protocol} isn't wired for one-click execution yet — this is a real live rate from DefiLlama, shown for comparison.`
          }
        />
      )}
    </div>
  );
}

interface MergedYieldOption {
  protocol: string;
  chain: string;
  apy: number;
  tvlUsd: number;
  kind: "lending" | "lp" | "vault";
  wired: boolean;
  vaultNote?: string;
}

const WIRED_YIELD_PROTOCOLS = new Set(["Aave", "Morpho", "Compound"]);

/**
 * Live cross-protocol yield search (tradePlan's "yieldSearch" intent — "find
 * the best yield on X"). Pulls real ranked data from /api/best-yield
 * (DefiLlama lending/LP pools) plus, for USDC specifically, Hyperliquid's
 * HLP and Lighter's LLP vault APRs (the two biggest venue-owned vaults this
 * app already has some integration with) — never a single resolved deposit,
 * since the whole point is comparing across venues Meridian doesn't have
 * execution wired for yet alongside the ones it does. Composes up to 3
 * honest strategies from the live list: the single best rate, the best rate
 * among venues already wired for a real one-click deposit, and an
 * equal-weighted split across the top few (deduped against each other so
 * the same venue never appears as two "different" strategies).
 */
export function YieldFinderCard({ asset, sizeUsd }: { asset: string; sizeUsd: number }) {
  const upperAsset = asset.toUpperCase();
  const { data: pools, isLoading: poolsLoading } = useBestYield(upperAsset);
  const { data: hlpApr, isLoading: hlpLoading } = useHlpApr();
  const { data: llpApr, isLoading: llpLoading } = useLlpApr();
  const isUsdc = upperAsset === "USDC";

  const options: MergedYieldOption[] = useMemo(() => {
    const base: MergedYieldOption[] = (pools ?? []).map((p) => ({
      protocol: p.protocol,
      chain: p.chain,
      apy: p.apy,
      tvlUsd: p.tvlUsd,
      kind: p.kind,
      wired: WIRED_YIELD_PROTOCOLS.has(p.protocol),
    }));
    // HLP (USDC only on Hyperliquid) and LLP (USDC only on Lighter) aren't
    // DefiLlama pools — see useVaultYields.ts — so they're merged in here,
    // only when the search is actually for USDC.
    if (isUsdc && typeof hlpApr === "number") {
      base.push({ protocol: "Hyperliquid HLP", chain: "Hyperliquid", apy: hlpApr, tvlUsd: 0, kind: "vault", wired: false });
    }
    if (isUsdc && typeof llpApr === "number") {
      base.push({
        protocol: "Lighter LLP",
        chain: "Lighter",
        apy: llpApr,
        tvlUsd: 0,
        kind: "vault",
        wired: false,
        vaultNote: "Depositing into LLP requires locking LIT tokens (1:10 ratio) — not just USDC.",
      });
    }
    return base.sort((a, b) => b.apy - a.apy);
  }, [pools, hlpApr, llpApr, isUsdc]);

  const loading = poolsLoading || (isUsdc && (hlpLoading || llpLoading));

  if (loading && options.length === 0) {
    return (
      <p className="text-muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
        Scanning live yields for {upperAsset} across DeFi…
      </p>
    );
  }
  if (options.length === 0) {
    return (
      <p className="text-muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
        No live yield data found for {upperAsset} right now across the protocols this search covers.
      </p>
    );
  }

  const best = options[0];
  const establishedPool = options.find((o) => o.wired);
  const splitPool = options.slice(0, 3);
  const blendedApy = splitPool.reduce((s, o) => s + o.apy, 0) / splitPool.length;

  const sections: { label: string; apy: number; pools: MergedYieldOption[] }[] = [{ label: "Best live rate", apy: best.apy, pools: [best] }];
  if (establishedPool && establishedPool.protocol !== best.protocol) {
    sections.push({ label: "Established — already wired for one click", apy: establishedPool.apy, pools: [establishedPool] });
  }
  if (splitPool.length > 1) {
    sections.push({ label: `Diversified — split evenly across ${splitPool.length}`, apy: blendedApy, pools: splitPool });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      {sections.map((s, i) => (
        <div key={i} className="card" style={{ gap: 4, padding: "var(--space-2)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <strong style={{ fontSize: 13 }}>{s.label}</strong>
            <span style={{ fontSize: 13, fontVariantNumeric: "tabular-nums", color: "var(--color-accent-700)" }}>
              ~{s.apy.toFixed(2)}% blended
            </span>
          </div>
          {s.pools.map((p, j) => (
            <YieldOptionRow key={j} option={p} asset={upperAsset} sizeUsd={s.pools.length > 1 ? sizeUsd / s.pools.length : sizeUsd} />
          ))}
        </div>
      ))}
      <p className="text-muted" style={{ fontSize: 10, margin: 0 }}>
        Lending/LP rates from DefiLlama&apos;s free yields API · vault APRs read live from Hyperliquid/Lighter&apos;s own APIs — not editorial picks.
      </p>
    </div>
  );
}
