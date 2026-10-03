import { NextResponse } from "next/server";

/**
 * GET /api/yield-context
 *
 * Aggregates ALL live yield data from every source, fetched fresh each time.
 * No hardcoded rates — everything comes from protocol APIs:
 *
 * 1. DefiLlama yields → ALL lending/LP pools from protocols Meridian supports
 * 2. DefiLlama yields → ALL ETH liquid staking providers
 * 3. Hyperliquid API → ALL perp funding rates (every listed coin)
 * 4. Hyperliquid API → HLP vault APR
 * 5. Lighter API → ALL public pool APRs
 * 6. Philidor API → ALL risk-scored DeFi vaults (Morpho, Aave, Compound, etc.)
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

interface FundingRow {
  coin: string;
  hourlyRate: number;
  annualizedPct: number;
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
  "spark",
  "fluid",
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

async function fetchDefiLlama(): Promise<{ lending: YieldRow[]; staking: YieldRow[] }> {
  try {
    const res = await fetch(DEFILLAMA_YIELDS, {
      signal: AbortSignal.timeout(TIMEOUT),
      cache: "no-store",
    });
    if (!res.ok) return { lending: [], staking: [] };
    const body: { data?: DefiLlamaPool[] } = await res.json();
    const pools = body.data ?? [];

    const lendingMap = new Map<string, YieldRow>();
    const stakingMap = new Map<string, YieldRow>();

    for (const p of pools) {
      if (!p.project || !MERIDIAN_PROTOCOL_SLUGS.has(p.project)) continue;
      const apy = p.apyBase ?? p.apy;
      if (typeof apy !== "number" || !Number.isFinite(apy) || apy <= 0) continue;
      if ((p.tvlUsd ?? 0) < MIN_TVL) continue;

      const sym = (p.symbol ?? "").toUpperCase();
      const chain = p.chain ?? "?";
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
            kind: /uniswap|curve/i.test(p.project) ? "lp" : "lending",
          });
        }
      }
    }

    const lending = Array.from(lendingMap.values())
      .sort((a, b) => b.apy - a.apy)
      .slice(0, 50);
    const staking = Array.from(stakingMap.values())
      .sort((a, b) => b.apy - a.apy);

    return { lending, staking };
  } catch {
    return { lending: [], staking: [] };
  }
}

/* ---------- Hyperliquid: ALL funding rates ---------- */

async function fetchFundingRates(): Promise<FundingRow[]> {
  try {
    const res = await fetch(HYPERLIQUID_INFO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      signal: AbortSignal.timeout(TIMEOUT),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const raw = await res.json();
    const universe = raw?.[0]?.universe ?? [];
    const ctxs = raw?.[1] ?? [];
    const rates: FundingRow[] = [];
    for (let i = 0; i < universe.length; i++) {
      const name = universe[i]?.name;
      const funding = parseFloat(ctxs[i]?.funding ?? "");
      if (!name || !Number.isFinite(funding)) continue;
      rates.push({
        coin: name,
        hourlyRate: funding,
        annualizedPct: funding * 24 * 365 * 100,
      });
    }
    // Return ALL coins sorted by absolute annualized rate
    return rates.sort((a, b) => Math.abs(b.annualizedPct) - Math.abs(a.annualizedPct));
  } catch {
    return [];
  }
}

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
    return { name: "HLP (Hyperliquid Vault)", apr: data.apr };
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
      `${PHILIDOR_VAULTS}?limit=50&sortBy=apr_net&sortOrder=desc&minTvl=100000`,
      { signal: AbortSignal.timeout(TIMEOUT), cache: "no-store" },
    );
    if (!res.ok) return [];
    const body: { data?: RawPhilidorVault[] } = await res.json();
    if (!Array.isArray(body.data)) return [];
    return body.data
      .filter((v) => typeof v.apr_net === "number" && typeof v.total_score === "number")
      .map((v) => ({
        protocol: String(v.protocol_name ?? ""),
        asset: String(v.asset_symbol ?? ""),
        chain: String(v.chain_name ?? ""),
        apy: v.apr_net as number,
        riskScore: v.total_score as number,
        riskTier: String(v.risk_tier ?? ""),
        tvlUsd: typeof v.tvl_usd === "number" ? v.tvl_usd : 0,
      }));
  } catch {
    return [];
  }
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
    lines.push("\n### Perp Funding Rates (Hyperliquid) — yield for delta-neutral / cost for directional");
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

/* ---------- Handler ---------- */

export async function GET() {
  // Fetch ALL sources in parallel — each is independently null-safe
  const [defiLlama, funding, hlp, lighterVaults, philidor] = await Promise.all([
    fetchDefiLlama(),
    fetchFundingRates(),
    fetchHlpVault(),
    fetchLighterVaults(),
    fetchPhilidorVaults(),
  ]);

  const vaults: VaultYield[] = [
    hlp,
    ...lighterVaults,
  ].filter((v): v is VaultYield => v !== null);

  const ctx: YieldContext = {
    lending: defiLlama.lending,
    staking: defiLlama.staking,
    funding,
    vaults,
    riskScoredVaults: philidor,
    fetchedAt: new Date().toISOString(),
    summary: "",
  };
  ctx.summary = buildSummary(ctx);

  return NextResponse.json(ctx);
}
