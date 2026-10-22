import { crossVenueFunding, crossVenueSummary, extendedSummary, marketBase, txflowCrossVenue, txflowCrossVenueSummary, txflowSummary } from "@/lib/perpVenues";
import { fetchExtendedMarkets, fetchFundingRates, fetchTxflowMarkets, type FundingRow } from "@/lib/perpFeed";
import { extendedQuote, hlQuote, txflowQuote, type MarketQuote, type MarketSnapshot } from "@/lib/planner/markets";
import { NextResponse } from "next/server";
import { parseOpportunities, type Opportunity } from "@/lib/protocols/opportunities";
import { aaveYieldSummary, fetchAaveReservesByChain, type AaveReserve } from "@/lib/mcp/aave";
import { neutralCarryRows, neutralCarrySummary, type CarryRow } from "@/lib/neutralCarry";
import { findToken } from "@/lib/assetMap";
import { UNISWAP_SWAP_ROUTER02_BY_CHAIN } from "@/lib/integrations/uniswap";
import { ACTIVE_CHAIN_IDS, CHAIN_LABEL } from "@/lib/onchain";
import { PENDLE_CHAINS, fetchPendleMarkets, type PendleMarket } from "@/lib/integrations/pendle";
import * as haiku from "@/lib/mcp/providers/haiku";
import { MIN_VAULT_TVL_USD } from "@/lib/vaultPolicy";
import { MIN_MORPHO_RISK_SCORE } from "@/lib/integrations/morpho";

/**
 * GET /api/yield-context
 *
 * Aggregates ALL live yield data from every source, fetched fresh each time.
 * No hardcoded rates — everything comes from protocol APIs + MCP servers:
 *
 * 1. DefiLlama yields → ALL lending/LP pools from protocols Meridian supports
 * 2. DefiLlama yields → ALL ETH liquid staking providers
 * 3. Hyperliquid API → ALL perp funding rates (every listed coin)
 * 4. Hyperliquid API → HLP vault APR
 * 5. Lighter API → ALL public pool APRs
 * 6. Philidor API → ALL risk-scored DeFi vaults (Morpho, Aave, Compound, etc.)
 * 7. Aave MCP (mcp.aave.com) → Live Aave v3/v4 rates across all chains
 *
 * Returns a text summary for the LLM + structured JSON.
 * Never throws — returns partial data on any individual source failure.
 */

export const revalidate = 0; // Always fresh — yields change continuously

const DEFILLAMA_YIELDS = "https://yields.llama.fi/pools";
const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";
const HLP_VAULT_ADDRESS = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303";
const LIGHTER_POOLS = "https://mainnet.zklighter.elliot.ai/api/v1/publicPoolsMetadata";
const PHILIDOR_VAULTS = "https://api.philidor.io/v1/vaults";
const TIMEOUT = 8000;

/* ---------- Types ---------- */

interface DefiLlamaPool {
  project?: string;
  chain?: string;
  symbol?: string;
  apy?: number;
  apyBase?: number;
  apyReward?: number;
  tvlUsd?: number;
  exposure?: string;
}

interface YieldRow {
  protocol: string;
  asset: string;
  chain: string;
  apy: number;
  tvlUsd: number;
  kind: string;
}


interface VaultYield {
  name: string;
  apr: number;
}

interface PhilidorVault {
  protocol: string;
  asset: string;
  chain: string;
  apy: number;
  riskScore: number;
  riskTier: string;
  tvlUsd: number;
}

export interface YieldContext {
  lending: YieldRow[];
  staking: YieldRow[];
  funding: FundingRow[];
  vaults: VaultYield[];
  riskScoredVaults: PhilidorVault[];
  fetchedAt: string;
  summary: string;
}

/* ---------- DefiLlama: dynamic protocol discovery ---------- */

/**
 * Protocols Meridian has execution wired for (or can route to).
 * We match DefiLlama project slugs dynamically — any pool from these
 * protocols on DefiLlama is included, regardless of asset or chain.
 * New pools/assets/chains appear automatically as DefiLlama indexes them.
 */
const MERIDIAN_PROTOCOL_SLUGS = new Set([
  // Lending
  "aave-v3", "aave-v2",
  "compound-v3", "compound-v2",
  "morpho", "morpho-blue",
  "spark", "sparklend", "spark-savings",
  "fluid", "fluid-lending",
  "sky-lending",
  "ethena-usde",
  // Staking (for comparison)
  "lido",
  "rocket-pool",
  "ether.fi-stake",
  "stakewise",
  "stakewise-v3",
  "frax-ether",
  "mantle-staked-eth",
  "swell-liquid-staking",
  "coinbase-wrapped-staked-eth",
  // DEX LP (yield opportunities)
  "uniswap-v3",
  "curve-dex",
]);

/** Min TVL to filter noise — pools under this are ignored */
const MIN_TVL = 100_000;
/** Min TVL for LP pools — higher bar to exclude memecoin pairs */
const MIN_TVL_LP = 1_000_000;
/** Max credible APY — anything above is likely a memecoin or exploit */
const MAX_APY = 200;

/** Blue-chip tokens that are legitimate LP pair components */
const BLUECHIP_TOKENS = new Set([
  "ETH", "WETH", "STETH", "WSTETH", "CBETH", "RETH",
  "USDC", "USDT", "DAI", "FRAX", "LUSD", "GUSD", "PYUSD", "CRVUSD", "GHO", "USDS",
  "WBTC", "BTC", "TBTC",
  "ARB", "OP", "MATIC", "AVAX", "BNB", "SOL", "LINK", "UNI", "AAVE", "MKR", "CRV",
  "LDO", "RPL", "COMP", "SNX", "SUSHI", "BAL", "FXS", "CVX", "PENDLE",
  "WEETH", "EZETH", "RSETH", "METH", "SWETH",
]);

/** Check if an LP symbol contains only blue-chip tokens */
function isLegitLpPair(symbol: string): boolean {
  // LP symbols look like "USDC-ETH", "WBTC-USDC", etc.
  const tokens = symbol.split(/[-\/]/);
  return tokens.length >= 2 && tokens.every((t) => BLUECHIP_TOKENS.has(t.trim().toUpperCase()));
}

async function fetchDefiLlama(): Promise<{ lending: YieldRow[]; staking: YieldRow[]; pools: DefiLlamaPool[] }> {
  try {
    const res = await fetch(DEFILLAMA_YIELDS, {
      signal: AbortSignal.timeout(TIMEOUT),
      cache: "no-store",
    });
    if (!res.ok) return { lending: [], staking: [], pools: [] };
    const body: { data?: DefiLlamaPool[] } = await res.json();
    const pools = body.data ?? [];

    const lendingMap = new Map<string, YieldRow>();
    const stakingMap = new Map<string, YieldRow>();

    for (const p of pools) {
      if (!p.project || !MERIDIAN_PROTOCOL_SLUGS.has(p.project)) continue;
      const apy = p.apyBase ?? p.apy;
      if (typeof apy !== "number" || !Number.isFinite(apy) || apy <= 0) continue;
      if (apy > MAX_APY) continue; // Filter unrealistic yields
      if ((p.tvlUsd ?? 0) < MIN_TVL) continue;

      const sym = (p.symbol ?? "").toUpperCase();
      const chain = p.chain ?? "?";
      const isLp = /uniswap|curve/i.test(p.project);

      // For LP pools: require blue-chip pairs and higher TVL
      if (isLp) {
        if ((p.tvlUsd ?? 0) < MIN_TVL_LP) continue;
        if (!isLegitLpPair(sym)) continue;
      }
      const displayName = p.project
        .replace(/-v(\d)/, " v$1")
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .replace("Aave V3", "Aave v3")
        .replace("Compound V3", "Compound III")
        .replace("Morpho Blue", "Morpho")
        .replace("Ether.fi Stake", "ether.fi")
        .replace("Uniswap V3", "Uniswap v3")
        .replace("Curve Dex", "Curve");

      // Classify: staking vs lending/LP
      const isStaking = /lido|rocket-pool|ether\.fi|stakewise|frax-ether|mantle-staked|swell|coinbase-wrapped/i.test(p.project);

      if (isStaking) {
        // Keep best (deepest TVL) per staking protocol
        const existing = stakingMap.get(p.project);
        if (!existing || (p.tvlUsd ?? 0) > existing.tvlUsd) {
          stakingMap.set(p.project, {
            protocol: displayName,
            asset: sym,
            chain,
            apy,
            tvlUsd: p.tvlUsd ?? 0,
            kind: "staking",
          });
        }
      } else {
        // Keep best (deepest TVL) per protocol+asset+chain
        const key = `${p.project}:${sym}:${chain}`;
        const existing = lendingMap.get(key);
        if (!existing || (p.tvlUsd ?? 0) > existing.tvlUsd) {
          lendingMap.set(key, {
            protocol: displayName,
            asset: sym,
            chain,
            apy,
            tvlUsd: p.tvlUsd ?? 0,
            kind: isLp ? "lp" : "lending",
          });
        }
      }
    }

    // The deepest markets, not the highest APYs: a top-by-APY cut kept thin, odd
    // pools and dropped the plain Aave / Compound / Fluid USDC markets, so the
    // planner had no real rate for them and filled the gap itself.
    const lending = Array.from(lendingMap.values())
      .sort((a, b) => b.tvlUsd - a.tvlUsd)
      .slice(0, 80)
      .sort((a, b) => b.apy - a.apy);
    const staking = Array.from(stakingMap.values())
      .sort((a, b) => b.apy - a.apy);

    return { lending, staking, pools };
  } catch {
    return { lending: [], staking: [], pools: [] };
  }
}

/* ---------- Hyperliquid: ALL funding rates ---------- */

/* ---------- Protocol vaults ---------- */

async function fetchHlpVault(): Promise<VaultYield | null> {
  try {
    const res = await fetch(HYPERLIQUID_INFO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "vaultDetails", vaultAddress: HLP_VAULT_ADDRESS }),
      signal: AbortSignal.timeout(TIMEOUT),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data.apr !== "number" || !Number.isFinite(data.apr)) return null;
    // Hyperliquid reports the APR as a decimal (0.12 = 12%); the summary prints percent.
    return { name: "HLP (Hyperliquid Vault)", apr: data.apr * 100 };
  } catch {
    return null;
  }
}

async function fetchLighterVaults(): Promise<VaultYield[]> {
  try {
    const res = await fetch(LIGHTER_POOLS, {
      signal: AbortSignal.timeout(TIMEOUT),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = await res.json();
    const pools = Array.isArray(data)
      ? data
      : Array.isArray(data?.pools)
        ? data.pools
        : Array.isArray(data?.data)
          ? data.data
          : [];
    const results: VaultYield[] = [];
    for (const p of pools) {
      const raw = p.apr ?? p.apy ?? p.annualized_return ?? p.annualizedReturn;
      const n = typeof raw === "number" ? raw : parseFloat(String(raw ?? ""));
      if (!Number.isFinite(n)) continue;
      const pct = n > 0 && n < 1 ? n * 100 : n;
      const name = p.name ?? p.symbol ?? "Lighter Pool";
      results.push({ name: `${name} (Lighter)`, apr: pct });
    }
    return results;
  } catch {
    return [];
  }
}

/* ---------- Philidor: ALL risk-scored vaults ---------- */

interface RawPhilidorVault {
  protocol_name?: unknown;
  asset_symbol?: unknown;
  chain_name?: unknown;
  apr_net?: unknown;
  total_score?: unknown;
  risk_tier?: unknown;
  tvl_usd?: unknown;
}

async function fetchPhilidorVaults(): Promise<PhilidorVault[]> {
  try {
    const res = await fetch(
      `${PHILIDOR_VAULTS}?limit=50&sortBy=tvl_usd&sortOrder=desc&minTvl=${MIN_VAULT_TVL_USD}`,
      { signal: AbortSignal.timeout(TIMEOUT), cache: "no-store" },
    );
    if (!res.ok) return [];
    const body: { data?: RawPhilidorVault[] } = await res.json();
    if (!Array.isArray(body.data)) return [];
    return body.data
      .filter((v) => typeof v.apr_net === "number" && typeof v.total_score === "number" && (v.total_score as number) >= MIN_MORPHO_RISK_SCORE)
      .map((v) => ({
        protocol: String(v.protocol_name ?? ""),
        asset: String(v.asset_symbol ?? ""),
        chain: String(v.chain_name ?? ""),
        // Philidor reports apr_net as a fraction (0.0315 = 3.15%).
        apy: (v.apr_net as number) * 100,
        riskScore: v.total_score as number,
        riskTier: String(v.risk_tier ?? ""),
        tvlUsd: typeof v.tvl_usd === "number" ? v.tvl_usd : 0,
      }));
  } catch {
    return [];
  }
}

/**
 * The exact Morpho vault Meridian deposits into for each chain and asset —
 * the same rule as the Morpho execute button: Philidor's best risk score with
 * at least MIN_VAULT_TVL_USD, Core tier or better. Quoting this vault's rate
 * keeps the strategy's APY equal to what the user actually gets.
 */
async function fetchMorphoExecutableVaults(): Promise<string> {
  // One query per chain, as the execute button does (a global top-50 by score
  // left whole chains, Arbitrum included, without any Morpho rate).
  const chains = ACTIVE_CHAIN_IDS.map((id) => CHAIN_LABEL[id]).filter((c): c is string => !!c);
  const perChain = await Promise.all(
    chains.map(async (chain) => {
      try {
        const res = await fetch(
          `${PHILIDOR_VAULTS}?protocol=morpho&chain=${encodeURIComponent(chain)}&limit=25&sortBy=total_score&sortOrder=desc&minTvl=${MIN_VAULT_TVL_USD}`,
          { signal: AbortSignal.timeout(TIMEOUT), cache: "no-store" },
        );
        if (!res.ok) return [];
        const body: { data?: (RawPhilidorVault & { name?: unknown })[] } = await res.json();
        return body.data ?? [];
      } catch {
        return [];
      }
    }),
  );
  const best = new Map<string, string>();
  for (const v of perChain.flat()) {
    if (typeof v.apr_net !== "number" || typeof v.total_score !== "number" || v.total_score < MIN_MORPHO_RISK_SCORE) continue;
    if (typeof v.tvl_usd !== "number" || v.tvl_usd < MIN_VAULT_TVL_USD) continue;
    const key = `${v.chain_name}|${v.asset_symbol}`;
    if (best.has(key)) continue; // sorted by score: the first is the one Meridian picks
    best.set(
      key,
      `- Morpho | ${String(v.asset_symbol)} | ${String(v.chain_name)} | ${(v.apr_net * 100).toFixed(2)}% net APY | vault "${String(v.name ?? "")}" | risk ${v.total_score.toFixed(1)}/10 | ${fmtTvl(v.tvl_usd)} TVL`,
    );
  }
  if (best.size === 0) return "";
  return [
    "\n\n### Morpho — the vault Meridian deposits into (use exactly this rate for a Morpho leg; no other Morpho rate is real for execution; no row = no Morpho on that chain/asset)",
    ...best.values(),
  ].join("\n");
}

/* ---------- Build text summary ---------- */

function fmtTvl(tvl: number): string {
  if (tvl >= 1e9) return `$${(tvl / 1e9).toFixed(1)}B`;
  if (tvl >= 1e6) return `$${(tvl / 1e6).toFixed(1)}M`;
  return `$${(tvl / 1e3).toFixed(0)}K`;
}

function buildSummary(ctx: Omit<YieldContext, "summary" | "fetchedAt">): string {
  const lines: string[] = [
    `## LIVE YIELD DATA — fetched ${new Date().toISOString()}`,
    "Use ONLY these rates. Do NOT guess or recall rates from memory.",
  ];

  if (ctx.lending.length > 0) {
    lines.push("\n### Lending & LP Yields");
    for (const r of ctx.lending) {
      lines.push(`- ${r.protocol} | ${r.asset} | ${r.chain} | ${r.apy.toFixed(2)}% APY | ${fmtTvl(r.tvlUsd)} TVL | ${r.kind}`);
    }
  }

  if (ctx.staking.length > 0) {
    lines.push("\n### ETH Liquid Staking");
    for (const r of ctx.staking) {
      lines.push(`- ${r.protocol} | ${r.asset} | ${r.apy.toFixed(2)}% APY | ${fmtTvl(r.tvlUsd)} TVL`);
    }
  }

  if (ctx.vaults.length > 0) {
    lines.push("\n### Protocol Vaults (market-making / liquidity)");
    for (const v of ctx.vaults) {
      lines.push(`- ${v.name} | ${v.apr.toFixed(2)}% APR`);
    }
  }

  if (ctx.riskScoredVaults.length > 0) {
    lines.push("\n### Risk-Scored DeFi Vaults (Philidor)");
    for (const v of ctx.riskScoredVaults) {
      lines.push(`- ${v.protocol} | ${v.asset} | ${v.chain} | ${v.apy.toFixed(2)}% APY | risk ${v.riskScore.toFixed(1)}/10 ${v.riskTier} | ${fmtTvl(v.tvlUsd)} TVL`);
    }
  }

  if (ctx.funding.length > 0) {
    lines.push("\n### Perp Funding Rates (Hyperliquid) — positive = longs pay shorts: a SHORT earns a positive rate, a LONG pays it (negative: the reverse)");
    for (const f of ctx.funding) {
      const sign = f.annualizedPct >= 0 ? "+" : "";
      lines.push(`- ${f.coin} | ${sign}${f.annualizedPct.toFixed(1)}% annualized | ${sign}${(f.hourlyRate * 100).toFixed(4)}%/hr`);
    }
  }

  if (ctx.lending.length === 0 && ctx.staking.length === 0 && ctx.funding.length === 0 && ctx.vaults.length === 0) {
    lines.push("\n(No live yield data available right now — inform the user that rates could not be fetched)");
  }

  return lines.join("\n");
}

/** Executable Pendle fixed-rate markets (prime or major stablecoin, ≥ $1M liquidity, > 14 days to expiry), best fixed APY first. */
function pendleSummary(markets: PendleMarket[]): string {
  if (markets.length === 0) return "";
  const chainName: Record<number, string> = { 1: "Ethereum", 42161: "Arbitrum", 8453: "Base" };
  const lines = ["\n\n### Pendle fixed yield (buy PT, held to expiry; Pendle prime or major-stablecoin markets only) — executable, use asset \"PT-<name>\" and the chain shown. Propose no other Pendle market"];
  for (const m of markets.slice(0, 20)) {
    lines.push(
      `- PT-${m.name} | ${chainName[m.chainId] ?? m.chainId} | ${m.impliedApyPct.toFixed(2)}% fixed until ${m.expiry.slice(0, 10)} | ${fmtTvl(m.liquidityUsd)} liquidity${m.isPrime ? " | prime" : " | major stable"}${m.categories.length ? ` | ${m.categories.join(",")}` : ""}`,
    );
  }
  const empty = Object.entries(chainName).filter(([id]) => !markets.some((m) => m.chainId === Number(id))).map(([, n]) => n);
  if (empty.length > 0) lines.push(`- No eligible Pendle market on ${empty.join(" or ")} right now: never put a Pendle leg there.`);
  return lines.join("\n");
}

/**
 * Cross-protocol coverage from DefiLlama (lib/protocols/registry.ts): the
 * best single-asset stablecoin and ETH yields on the active chains (incl. HyperEVM), split into
 * what Meridian executes and what it only watches.
 */
function opportunitiesSummary(pools: unknown[]): string {
  if (pools.length === 0) return "";
  const lines: string[] = [];
  const row = (o: Opportunity) =>
    `- ${o.protocol} | ${o.symbol}${o.shareSymbol ? ` → ${o.shareSymbol}` : ""} | ${o.chain} | ${o.apy.toFixed(2)}% APY${o.apyReward > 0 ? ` (${o.apyBase.toFixed(2)}% base + ${o.apyReward.toFixed(2)}% rewards)` : ""}${o.apyMean30d !== undefined ? ` | 30d avg ${o.apyMean30d.toFixed(2)}%` : ""} | ${fmtTvl(o.tvlUsd)} TVL${o.exit ? ` | exit: ${o.exit}` : ""}`;
  for (const kind of ["stable", "eth", "hype"] as const) {
    const all = parseOpportunities(pools, { kind, limit: 60 });
    const exec = all.filter((o) => o.coverage === "execute").slice(0, 15);
    const watch = all.filter((o) => o.coverage === "watch").slice(0, 8);
    const label = kind === "stable" ? "stablecoins" : kind === "eth" ? "ETH" : "HYPE (Hyperliquid)";
    if (exec.length > 0) {
      lines.push(`\n\n### Best ${label} yields Meridian EXECUTES (DefiLlama, live) — use protocol name exactly as written`);
      lines.push(...exec.map(row));
    }
    if (watch.length > 0) {
      lines.push(`\n### Other ${label} yields (comparison only, NOT executable — never put these in a leg; mention them only to compare)`);
      lines.push(...watch.map(row));
    }
  }
  return lines.join("\n");
}

/* ---------- Beta-neutral carry (spot only) ---------- */

/** DefiLlama staking pool (project + symbol on Ethereum) behind each LST's yield. */
const LST_STAKING_POOL: Record<string, { project: string; symbol: string }> = {
  WSTETH: { project: "lido", symbol: "STETH" },
  WEETH: { project: "ether.fi-stake", symbol: "WEETH" },
  RETH: { project: "rocket-pool", symbol: "RETH" },
  CBETH: { project: "coinbase-wrapped-staked-eth", symbol: "CBETH" },
};

function carryRows(perChain: { chainId: number; reserves: AaveReserve[] }[], pools: DefiLlamaPool[]): CarryRow[] {
  const staking: Record<string, number> = {};
  for (const [lst, src] of Object.entries(LST_STAKING_POOL)) {
    const pool = pools.find((p) => p.project === src.project && p.chain === "Ethereum" && (p.symbol ?? "").toUpperCase() === src.symbol);
    const apy = pool?.apyBase ?? pool?.apy;
    if (typeof apy === "number" && Number.isFinite(apy) && apy > 0 && apy < 15) staking[lst] = apy;
  }
  const rows: CarryRow[] = [];
  for (const { chainId, reserves } of perChain) {
    // Every leg must be executable here: Aave, a tracked LST and a Uniswap router.
    if (!UNISWAP_SWAP_ROUTER02_BY_CHAIN[chainId] || !findToken("WETH", chainId)) continue;
    const swappable = ["wstETH", "weETH", "rETH", "cbETH"].filter((s) => findToken(s, chainId)?.symbol.toUpperCase() === s.toUpperCase());
    const carry = reserves.map((r) => ({ symbol: r.symbol, supplyApy: r.supplyAPY * 100, borrowApy: r.borrowAPY * 100, totalSupplyUsd: r.totalSupply }));
    rows.push(...neutralCarryRows(CHAIN_LABEL[chainId] ?? String(chainId), carry, staking, swappable));
  }
  // Only the best chain + LST: given one row per chain, the planner filled all
  // three strategies with the same carry on three chains.
  return rows.sort((a, b) => b.netApy - a.netApy).slice(0, 1);
}

/* ---------- Hyperliquid HIP-3: stock, index and commodity perps ---------- */

interface Hip3Market {
  coin: string;
  mark: number;
  fundingHourly: number;
  szDecimals: number;
  fundingAnnualizedPct: number;
  maxLeverage: number;
  dayVolumeUsd: number;
  isolatedOnly: boolean;
}

/** The most traded HIP-3 perps on dexes collateralised in USDC (the ones Meridian can fund). */
async function fetchHip3Markets(): Promise<Hip3Market[]> {
  const post = async (body: object) => {
    const res = await fetch(HYPERLIQUID_INFO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  };
  try {
    const dexes = ((await post({ type: "perpDexs" })) as ({ name: string } | null)[]).filter((d): d is { name: string } => !!d).map((d) => d.name);
    const all = await Promise.all(
      dexes.map(async (dex) => {
        try {
          const [meta, ctxs] = (await post({ type: "metaAndAssetCtxs", dex })) as [
            { collateralToken?: number; universe?: { name: string; maxLeverage: number; szDecimals?: number; onlyIsolated?: boolean; isDelisted?: boolean }[] },
            { markPx?: string; funding?: string; dayNtlVlm?: string }[],
          ];
          if ((meta.collateralToken ?? 0) !== 0) return [];
          return (meta.universe ?? []).flatMap((u, i): Hip3Market[] => {
            const mark = Number(ctxs[i]?.markPx);
            if (u.isDelisted || !(mark > 0)) return [];
            return [
              {
                coin: u.name,
                mark,
                fundingHourly: Number(ctxs[i]?.funding ?? 0),
                szDecimals: u.szDecimals ?? 0,
                fundingAnnualizedPct: Number(ctxs[i]?.funding ?? 0) * 24 * 365 * 100,
                maxLeverage: u.maxLeverage,
                dayVolumeUsd: Number(ctxs[i]?.dayNtlVlm ?? 0),
                isolatedOnly: !!u.onlyIsolated,
              },
            ];
          });
        } catch {
          return [];
        }
      }),
    );
    return all
      .flat()
      .filter((m) => m.dayVolumeUsd >= 1_000_000)
      .sort((a, b) => b.dayVolumeUsd - a.dayVolumeUsd)
      .slice(0, 40);
  } catch {
    return [];
  }
}

function hip3Summary(markets: Hip3Market[]): string {
  if (markets.length === 0) return "";
  const lines = ["\n### Stock, index & commodity perps (Hyperliquid HIP-3, USDC margin, executable) — exact market name | price | funding (positive = a short earns it) | max leverage | 24h volume"];
  for (const m of markets) {
    const sign = m.fundingAnnualizedPct >= 0 ? "+" : "";
    lines.push(
      `- ${m.coin} | $${m.mark.toLocaleString("en-US", { maximumFractionDigits: 4 })} | ${sign}${m.fundingAnnualizedPct.toFixed(1)}% annualized | ${m.maxLeverage}x${m.isolatedOnly ? " isolated" : ""} | ${fmtTvl(m.dayVolumeUsd)}`,
    );
  }
  return lines.join("\n");
}

/* ---------- Hyperliquid spot (UETH, UBTC, USOL) ---------- */

async function fetchHlSpotQuotes(): Promise<MarketQuote[]> {
  try {
    const res = await fetch(HYPERLIQUID_INFO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "spotMetaAndAssetCtxs" }),
      signal: AbortSignal.timeout(TIMEOUT),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const [meta, ctxs] = (await res.json()) as [
      { tokens: { name: string; index: number; szDecimals: number }[]; universe: { name: string; tokens: [number, number]; index: number }[] },
      { coin?: string; markPx?: string; dayNtlVlm?: string }[],
    ];
    const usdc = meta.tokens.find((t) => t.name === "USDC")?.index;
    const out: MarketQuote[] = [];
    for (const [token, base] of [["UETH", "ETH"], ["UBTC", "BTC"], ["USOL", "SOL"]] as const) {
      const t = meta.tokens.find((x) => x.name === token);
      const pair = t && meta.universe.find((u) => u.tokens[0] === t.index && u.tokens[1] === usdc);
      const ctx = pair && ctxs.find((c) => c.coin === pair.name);
      const mark = Number(ctx?.markPx ?? 0);
      if (!t || !pair || !(mark > 0)) continue;
      out.push(hlQuote({ kind: "spot", market: token, base, markUsd: mark, fundingHourly: 0, szDecimals: t.szDecimals, maxLeverage: 1, dayVolumeUsd: Number(ctx?.dayNtlVlm ?? 0) }));
    }
    return out;
  } catch {
    return [];
  }
}

/* ---------- Handler ---------- */

export async function GET() {
  // Fetch ALL sources in parallel — each is independently null-safe
  const [defiLlama, funding, hlp, lighterVaults, philidor, aaveReserves, haikuYields, pendleMarkets, morphoVaults, hip3, extended, hlSpot, txflow] = await Promise.all([
    fetchDefiLlama(),
    fetchFundingRates(),
    fetchHlpVault(),
    fetchLighterVaults(),
    fetchPhilidorVaults(),
    fetchAaveReservesByChain([...ACTIVE_CHAIN_IDS]).catch(() => [] as { chainId: number; reserves: AaveReserve[] }[]),
    haiku.fetchYieldOpportunities({ minApy: 1 }).catch(() => []),
    Promise.all(PENDLE_CHAINS.map((c) => fetchPendleMarkets(c))).then((all) => all.flat()),
    fetchMorphoExecutableVaults(),
    fetchHip3Markets(),
    fetchExtendedMarkets(),
    fetchHlSpotQuotes(),
    fetchTxflowMarkets(),
  ]);

  const vaults: VaultYield[] = [
    hlp,
    ...lighterVaults,
  ].filter((v): v is VaultYield => v !== null);

  // Merge Haiku MCP yield opportunities into lending data (deduplicated)
  const haikuLending: YieldRow[] = haikuYields
    .filter((y) => y.apy > 0 && y.tvlUsd > MIN_TVL)
    .map((y) => ({
      protocol: y.protocol,
      asset: y.asset.toUpperCase(),
      chain: CHAIN_LABEL[y.chainId] ?? String(y.chainId),
      apy: y.apy,
      tvlUsd: y.tvlUsd,
      kind: y.type,
    }));
  // Deduplicate: prefer DefiLlama data (already validated), add Haiku-only entries
  const existingKeys = new Set(defiLlama.lending.map((r) => `${r.protocol}:${r.asset}:${r.chain}`));
  // Haiku rows only fill gaps in DefiLlama's deep markets, and only with a sane, real-chain rate.
  const mergedLending = [
    ...defiLlama.lending,
    ...haikuLending.filter((r) => !existingKeys.has(`${r.protocol}:${r.asset}:${r.chain}`) && !/^\d+$/.test(r.chain) && r.apy < 40).slice(0, 10),
  ];

  const ctx: YieldContext = {
    lending: mergedLending,
    staking: defiLlama.staking,
    funding,
    vaults,
    riskScoredVaults: philidor,
    fetchedAt: new Date().toISOString(),
    summary: "",
  };
  // Build summary with optional Aave MCP enrichment appended
  const aaveMcp = aaveYieldSummary(aaveReserves);
  // Which sources answered: a missing one is "unavailable", never zero.
  const status = (ok: boolean) => (ok ? "ok" : "unavailable");
  const dataStatus = [
    `\n\n### DATA STATUS (fetched ${ctx.fetchedAt}) — a source marked unavailable has no figures below: never treat it as zero`,
    `- Hyperliquid funding: ${status(funding.length > 0)}`,
    `- Hyperliquid stock/index/commodity perps (HIP-3): ${status(hip3.length > 0)}`,
    `- Extended markets: ${status(extended.length > 0)}`,
    `- TxFlow markets: ${status(txflow.length > 0)}`,
    `- Lending & staking yields (DefiLlama): ${status(defiLlama.lending.length + defiLlama.staking.length > 0)}`,
    `- Pendle markets: ${status(pendleMarkets.length > 0)}`,
    `- Aave reserves: ${status(aaveReserves.length > 0)}`,
  ].join("\n");
  ctx.summary =
    dataStatus +
    buildSummary(ctx) +
    morphoVaults +
    opportunitiesSummary(defiLlama.pools) +
    pendleSummary(pendleMarkets) +
    neutralCarrySummary(carryRows(aaveReserves, defiLlama.pools)) +
    hip3Summary(hip3) +
    extendedSummary(extended) +
    crossVenueSummary(
      crossVenueFunding(
        [...funding, ...hip3.map((m) => ({ coin: m.coin, hourlyRate: m.fundingAnnualizedPct / 100 / (24 * 365) }))],
        // Liquid markets only: a pair needs both books deep enough to open and close at size.
        extended.filter((m) => m.dayVolumeUsd >= 1_000_000),
      ).sort((a, b) => b.spreadPct - a.spreadPct),
    ) +
    txflowSummary(txflow) +
    txflowCrossVenueSummary(
      txflowCrossVenue(
        [...funding, ...hip3.map((m) => ({ coin: m.coin, hourlyRate: m.fundingAnnualizedPct / 100 / (24 * 365) }))],
        extended.filter((m) => m.dayVolumeUsd >= 1_000_000),
        txflow.filter((m) => m.dayVolumeUsd >= 100_000),
      ),
    ) +
    (aaveMcp ? `\n${aaveMcp}` : "");

  // Structured quotes for the server checks of the planner (lib/planner/markets.ts).
  const markets: MarketSnapshot = {
    fetchedAt: ctx.fetchedAt,
    quotes: [
      ...funding
        .filter((f) => f.markUsd > 0)
        .map((f) => hlQuote({ market: f.coin, base: marketBase(f.coin), markUsd: f.markUsd, fundingHourly: f.hourlyRate, szDecimals: f.szDecimals, maxLeverage: f.maxLeverage, dayVolumeUsd: f.dayVolumeUsd })),
      ...hip3.map((m) => hlQuote({ market: m.coin, base: marketBase(m.coin), markUsd: m.mark, fundingHourly: m.fundingHourly, szDecimals: m.szDecimals, maxLeverage: m.maxLeverage, dayVolumeUsd: m.dayVolumeUsd })),
      ...hlSpot,
      ...extended
        .filter((m) => m.sizeStep > 0)
        .map((m) => extendedQuote({ market: m.name, base: m.base, markUsd: m.mark, fundingHourly: m.fundingHourly, sizeStep: m.sizeStep, minQty: m.minQty, maxLeverage: m.maxLeverage, dayVolumeUsd: m.dayVolumeUsd })),
      ...txflow.map((m) => txflowQuote({ market: m.name, base: m.base, markUsd: m.mark, fundingHourly: m.fundingHourly, szDecimals: m.szDecimals, maxLeverage: m.maxLeverage, dayVolumeUsd: m.dayVolumeUsd })),
    ],
  };

  return NextResponse.json({ ...ctx, markets });
}
