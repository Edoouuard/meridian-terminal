import { NextResponse } from "next/server";

/**
 * GET /api/yield-context
 *
 * Aggregates live yield data from ALL sources in parallel:
 * - DefiLlama yields API → lending APY (Aave, Compound, Morpho, Spark, Fluid, etc.)
 * - DefiLlama yields API → staking APY (Lido, Rocket Pool, ether.fi, etc.)
 * - Hyperliquid info API → perp funding rates (= yield for delta-neutral)
 * - Hyperliquid vaultDetails → HLP vault APR
 * - Lighter publicPoolsMetadata → LLP vault APR
 * - Philidor API → Morpho vault APY + risk scores
 *
 * Returns a compact text summary for injection into the LLM strategy prompt.
 * Cached 10 min (revalidate). Never throws — returns partial data on failures.
 */

export const revalidate = 600;

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
  morpho: PhilidorVault[];
  fetchedAt: string;
  summary: string;
}

/* ---------- Fetchers ---------- */

const LENDING_PROJECTS: Record<string, string> = {
  "aave-v3": "Aave v3",
  "compound-v3": "Compound III",
  morpho: "Morpho",
  "morpho-blue": "Morpho Blue",
  spark: "Spark",
  fluid: "Fluid",
};

const STAKING_PROJECTS: Record<string, string> = {
  lido: "Lido",
  "rocket-pool": "Rocket Pool",
  "ether.fi-stake": "ether.fi",
  stakewise: "StakeWise",
  "frax-ether": "Frax Ether",
};

const KEY_ASSETS = new Set(["USDC", "USDT", "DAI", "WETH", "ETH", "WBTC", "STETH", "WSTETH", "GHO", "LUSD", "FRAX", "CBBTC"]);

async function fetchDefiLlama(): Promise<{ lending: YieldRow[]; staking: YieldRow[] }> {
  try {
    const res = await fetch(DEFILLAMA_YIELDS, {
      signal: AbortSignal.timeout(TIMEOUT),
      next: { revalidate: 600 },
    });
    if (!res.ok) return { lending: [], staking: [] };
    const body: { data?: DefiLlamaPool[] } = await res.json();
    const pools = body.data ?? [];

    // Lending yields
    const lendingMap = new Map<string, YieldRow>();
    for (const p of pools) {
      if (!p.project || !(p.project in LENDING_PROJECTS)) continue;
      const sym = (p.symbol ?? "").toUpperCase();
      if (!KEY_ASSETS.has(sym)) continue;
      const apy = p.apyBase ?? p.apy;
      if (typeof apy !== "number" || !Number.isFinite(apy) || apy <= 0) continue;
      if ((p.tvlUsd ?? 0) < 100_000) continue;
      const key = `${p.project}:${sym}:${p.chain}`;
      const existing = lendingMap.get(key);
      if (!existing || (p.tvlUsd ?? 0) > existing.tvlUsd) {
        lendingMap.set(key, {
          protocol: LENDING_PROJECTS[p.project],
          asset: sym,
          chain: p.chain ?? "?",
          apy,
          tvlUsd: p.tvlUsd ?? 0,
          kind: "lending",
        });
      }
    }
    const lending = Array.from(lendingMap.values())
      .sort((a, b) => b.apy - a.apy)
      .slice(0, 30);

    // Staking yields
    const stakingMap = new Map<string, YieldRow>();
    for (const p of pools) {
      if (!p.project || !(p.project in STAKING_PROJECTS)) continue;
      if (p.chain !== "Ethereum") continue;
      const apy = p.apyBase ?? p.apy;
      if (typeof apy !== "number" || !Number.isFinite(apy)) continue;
      const existing = stakingMap.get(p.project);
      if (!existing || (p.tvlUsd ?? 0) > existing.tvlUsd) {
        stakingMap.set(p.project, {
          protocol: STAKING_PROJECTS[p.project],
          asset: p.symbol ?? "ETH",
          chain: "Ethereum",
          apy,
          tvlUsd: p.tvlUsd ?? 0,
          kind: "staking",
        });
      }
    }
    const staking = Array.from(stakingMap.values()).sort((a, b) => b.apy - a.apy);

    return { lending, staking };
  } catch {
    return { lending: [], staking: [] };
  }
}

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
      if (!name || !Number.isFinite(funding) || funding === 0) continue;
      rates.push({
        coin: name,
        hourlyRate: funding,
        annualizedPct: funding * 24 * 365 * 100,
      });
    }
    return rates
      .sort((a, b) => Math.abs(b.annualizedPct) - Math.abs(a.annualizedPct))
      .slice(0, 15);
  } catch {
    return [];
  }
}

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
    return { name: "HLP (Hyperliquid)", apr: data.apr };
  } catch {
    return null;
  }
}

async function fetchLighterVault(): Promise<VaultYield | null> {
  try {
    const res = await fetch(LIGHTER_POOLS, {
      signal: AbortSignal.timeout(TIMEOUT),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    const pools = Array.isArray(data) ? data : Array.isArray(data?.pools) ? data.pools : Array.isArray(data?.data) ? data.data : [];
    const llp = pools.find((p: Record<string, unknown>) => /\bllp\b/i.test(String(p.name ?? "")) || /\bllp\b/i.test(String(p.symbol ?? ""))) ?? pools[0];
    if (!llp) return null;
    const raw = llp.apr ?? llp.apy ?? llp.annualized_return ?? llp.annualizedReturn;
    const n = typeof raw === "number" ? raw : parseFloat(String(raw));
    if (!Number.isFinite(n)) return null;
    const pct = n > 0 && n < 1 ? n * 100 : n;
    return { name: "LLP (Lighter)", apr: pct };
  } catch {
    return null;
  }
}

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
      `${PHILIDOR_VAULTS}?limit=20&sortBy=apr_net&sortOrder=desc&minTvl=500000`,
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
      }))
      .slice(0, 15);
  } catch {
    return [];
  }
}

/* ---------- Build text summary ---------- */

function buildSummary(ctx: Omit<YieldContext, "summary" | "fetchedAt">): string {
  const lines: string[] = ["## LIVE YIELD DATA (real-time, use these numbers — do NOT guess APY)"];

  if (ctx.lending.length > 0) {
    lines.push("\n### Lending Yields (DefiLlama)");
    for (const r of ctx.lending) {
      lines.push(`- ${r.protocol} ${r.asset} on ${r.chain}: ${r.apy.toFixed(2)}% APY ($${(r.tvlUsd / 1e6).toFixed(1)}M TVL)`);
    }
  }

  if (ctx.staking.length > 0) {
    lines.push("\n### ETH Staking Yields");
    for (const r of ctx.staking) {
      lines.push(`- ${r.protocol}: ${r.apy.toFixed(2)}% APY ($${(r.tvlUsd / 1e9).toFixed(1)}B TVL)`);
    }
  }

  if (ctx.vaults.length > 0) {
    lines.push("\n### Protocol Vaults");
    for (const v of ctx.vaults) {
      lines.push(`- ${v.name}: ${v.apr.toFixed(2)}% APR`);
    }
  }

  if (ctx.morpho.length > 0) {
    lines.push("\n### Top Morpho/DeFi Vaults (Philidor risk-scored)");
    for (const v of ctx.morpho) {
      lines.push(`- ${v.protocol} ${v.asset} on ${v.chain}: ${v.apy.toFixed(2)}% APY (risk ${v.riskScore.toFixed(1)}/10 ${v.riskTier}, $${(v.tvlUsd / 1e6).toFixed(1)}M TVL)`);
    }
  }

  if (ctx.funding.length > 0) {
    lines.push("\n### Perp Funding Rates (Hyperliquid) — yield for delta-neutral strategies");
    for (const f of ctx.funding) {
      const sign = f.annualizedPct >= 0 ? "+" : "";
      lines.push(`- ${f.coin}: ${sign}${f.annualizedPct.toFixed(1)}% annualized (${sign}${(f.hourlyRate * 100).toFixed(4)}%/hr)`);
    }
  }

  if (ctx.lending.length === 0 && ctx.staking.length === 0 && ctx.funding.length === 0) {
    lines.push("\n(No live yield data available — use your best knowledge of typical rates)");
  }

  return lines.join("\n");
}

/* ---------- Handler ---------- */

export async function GET() {
  const [defiLlama, funding, hlp, lighter, morpho] = await Promise.all([
    fetchDefiLlama(),
    fetchFundingRates(),
    fetchHlpVault(),
    fetchLighterVault(),
    fetchPhilidorVaults(),
  ]);

  const vaults: VaultYield[] = [hlp, lighter].filter((v): v is VaultYield => v !== null);

  const ctx: YieldContext = {
    lending: defiLlama.lending,
    staking: defiLlama.staking,
    funding,
    vaults,
    morpho,
    fetchedAt: new Date().toISOString(),
    summary: "",
  };
  ctx.summary = buildSummary(ctx);

  return NextResponse.json(ctx);
}
