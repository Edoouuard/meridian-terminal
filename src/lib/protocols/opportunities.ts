/**
 * protocols/opportunities.ts — rank DefiLlama pools into the opportunities
 * Meridian shows and feeds the planner. Pure, unit-tested.
 */

import { CHAIN_LABEL } from "@/lib/onchain";
import { LLAMA_CHAIN_ID, PROTOCOLS, assetKind, isExecutablePool, vaultForPool } from "@/lib/protocols/registry";

export interface Opportunity {
  protocol: string;
  project: string;
  category: string;
  chain: string;
  chainId: number;
  symbol: string;
  /** Total APY (base + rewards), percent. */
  apy: number;
  /** Organic part of the APY, percent. */
  apyBase: number;
  /** Incentive part of the APY (token rewards), percent. */
  apyReward: number;
  /** 30-day mean APY, percent, when DefiLlama has it — a steadier figure than today's. */
  apyMean30d?: number;
  tvlUsd: number;
  coverage: "execute" | "watch";
  /** For executable vaults: share token and exit terms. */
  shareSymbol?: string;
  exit?: string;
}

interface RawPool {
  /** DefiLlama pool id. */
  pool?: string;
  project?: string;
  chain?: string;
  symbol?: string;
  apy?: number | null;
  apyBase?: number | null;
  apyReward?: number | null;
  apyMean30d?: number | null;
  tvlUsd?: number;
  exposure?: string;
  outlier?: boolean;
  ilRisk?: string;
}

/** Below this TVL a pool is too thin to recommend. */
export const MIN_OPPORTUNITY_TVL = 5_000_000;
/** Above this APY a single-asset stable/ETH pool is almost always incentives or an error. */
export const MAX_OPPORTUNITY_APY = 40;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function parseOpportunities(
  raw: unknown[],
  { kind, limit = 30, minTvl = MIN_OPPORTUNITY_TVL }: { kind: "stable" | "eth" | "hype"; limit?: number; minTvl?: number },
): Opportunity[] {
  const best = new Map<string, Opportunity>();
  for (const item of raw) {
    const p = item as RawPool;
    const info = p.project ? PROTOCOLS[p.project] : undefined;
    const chainId = p.chain ? LLAMA_CHAIN_ID[p.chain] : undefined;
    if (!info || !chainId || !p.symbol) continue;
    if (p.exposure !== "single" || p.outlier === true || p.ilRisk === "yes") continue;
    if (assetKind(p.symbol) !== kind) continue;
    const apy = num(p.apy);
    const tvlUsd = num(p.tvlUsd);
    if (!(apy > 0) || apy > MAX_OPPORTUNITY_APY || tvlUsd < minTvl) continue;

    const project = p.project as string;
    const vault = vaultForPool(project, chainId, p.symbol, p.pool);
    const opp: Opportunity = {
      protocol: info.name,
      project,
      category: info.category,
      chain: CHAIN_LABEL[chainId] ?? p.chain ?? "",
      chainId,
      // For a vault, show what the user deposits (USDS → sUSDS), not DefiLlama's share-token symbol.
      symbol: vault ? vault.assetSymbol : p.symbol,
      apy: Math.round(apy * 100) / 100,
      apyBase: Math.round(num(p.apyBase) * 100) / 100,
      apyReward: Math.round(num(p.apyReward) * 100) / 100,
      apyMean30d: typeof p.apyMean30d === "number" && Number.isFinite(p.apyMean30d) ? Math.round(p.apyMean30d * 100) / 100 : undefined,
      tvlUsd: Math.round(tvlUsd),
      coverage: isExecutablePool(project, chainId, p.symbol, p.pool) ? "execute" : "watch",
      shareSymbol: vault?.shareSymbol,
      exit: vault?.exit,
    };
    // One row per protocol + chain + symbol: the deepest pool. A pool Meridian executes keeps its own row,
    // so a deeper pool of the same protocol it can't deposit into never hides it.
    const key = `${project}|${chainId}|${p.symbol.toUpperCase()}${vault?.llamaPool ? `|${vault.llamaPool}` : ""}`;
    const prev = best.get(key);
    if (!prev || opp.tvlUsd > prev.tvlUsd) best.set(key, opp);
  }
  return [...best.values()].sort((a, b) => b.apy - a.apy).slice(0, limit);
}
