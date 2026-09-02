/**
 * philidor.ts — Philidor DeFi Vault Risk Analytics integration.
 *
 * Philidor (https://api.philidor.io/v1) is the free, no-key REST API that
 * backs the "Philidor DeFi Vault Risk Analytics" MCP server
 * (github.com/Philidor-Labs/philidor-mcp, mcp.philidor.io). An MCP server is
 * a thin JSON-RPC wrapper meant for an AI agent host to call over the MCP
 * protocol (initialize + tool-call handshake) — a browser-facing Next.js
 * route gets the identical data calling Philidor's REST API directly, with
 * none of that per-request session overhead. Same free source, right shape
 * for this codebase (mirrors the DefiLlama/CoinGecko direct-REST pattern
 * already used in src/app/api/chains and src/app/api/prices).
 *
 * Scores 700+ vaults across Aave, Morpho, Spark, Compound, Yearn, Beefy,
 * Uniswap, and more with a published 0-10 risk score / Prime-Core-Edge tier
 * (40% asset quality, 40% platform code maturity, 20% governance). Pure fetch
 * helpers here: null-safe, no throws, so callers can always fall back.
 */

export const PHILIDOR_API_URL = "https://api.philidor.io/v1";
const TIMEOUT_MS = 8000;

export type RiskTier = "Prime" | "Core" | "Edge";

export interface VaultRisk {
  id: string;
  name: string;
  protocol: string;
  chain: string;
  assetSymbol: string;
  tvlUsd: number;
  aprNet: number;
  riskScore: number;
  riskTier: RiskTier;
  isAudited: boolean;
}

/**
 * Meridian protocol display name -> Philidor protocol id, limited to the
 * lending/vault protocols Philidor actually scores (from GET /v1/protocols).
 * Directional-only venues (Hyperliquid, Extended, Variational) and non-vault
 * protocols (Lido, Pendle) have no Philidor entry and are deliberately absent.
 */
export const PHILIDOR_PROTOCOL_ID: Record<string, string> = {
  Aave: "aave",
  Morpho: "morpho",
  Compound: "compound",
  Spark: "spark",
  Uniswap: "uniswap",
  Yearn: "yearn",
  Beefy: "beefy",
};

interface RawVault {
  id?: unknown;
  name?: unknown;
  protocol_name?: unknown;
  chain_name?: unknown;
  asset_symbol?: unknown;
  tvl_usd?: unknown;
  apr_net?: unknown;
  total_score?: unknown;
  risk_tier?: unknown;
  is_audited?: unknown;
}

function isRiskTier(v: unknown): v is RiskTier {
  return v === "Prime" || v === "Core" || v === "Edge";
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Normalize one raw Philidor vault row. Returns null when the fields a risk
 * display actually needs (id, name, score, tier) are missing or malformed,
 * rather than rendering a half-populated card.
 */
export function normalizeVault(raw: RawVault): VaultRisk | null {
  if (typeof raw.id !== "string" || !raw.id) return null;
  if (typeof raw.name !== "string" || !raw.name) return null;
  if (typeof raw.total_score !== "number" || !Number.isFinite(raw.total_score)) return null;
  if (!isRiskTier(raw.risk_tier)) return null;

  return {
    id: raw.id,
    name: raw.name,
    protocol: typeof raw.protocol_name === "string" ? raw.protocol_name : "",
    chain: typeof raw.chain_name === "string" ? raw.chain_name : "",
    assetSymbol: typeof raw.asset_symbol === "string" ? raw.asset_symbol : "",
    tvlUsd: num(raw.tvl_usd),
    aprNet: num(raw.apr_net),
    riskScore: raw.total_score,
    riskTier: raw.risk_tier,
    isAudited: raw.is_audited === true,
  };
}

export interface SearchVaultsParams {
  /** Comma-separated Philidor protocol ids (see PHILIDOR_PROTOCOL_ID), e.g. "aave,morpho". */
  protocol?: string;
  /** Comma-separated asset symbols, e.g. "USDC,WETH". */
  asset?: string;
  /** Comma-separated chain display names, e.g. "Ethereum,Base". */
  chain?: string;
  riskTier?: string;
  minTvl?: number;
  /** 1-50, defaults to 20. */
  limit?: number;
  sortBy?: "tvl_usd" | "apr_net" | "total_score" | "name";
  sortOrder?: "asc" | "desc";
}

/**
 * Search Philidor vaults. Returns null on any network/parse failure so
 * callers fall back gracefully (never throws).
 */
export async function searchVaults(params: SearchVaultsParams = {}): Promise<VaultRisk[] | null> {
  const qs = new URLSearchParams();
  if (params.protocol) qs.set("protocol", params.protocol);
  if (params.asset) qs.set("asset", params.asset);
  if (params.chain) qs.set("chain", params.chain);
  if (params.riskTier) qs.set("riskTier", params.riskTier);
  if (params.minTvl) qs.set("minTvl", String(params.minTvl));
  qs.set("limit", String(params.limit && params.limit > 0 ? Math.min(Math.round(params.limit), 50) : 20));
  qs.set("sortBy", params.sortBy ?? "total_score");
  qs.set("sortOrder", params.sortOrder ?? "desc");

  try {
    const res = await fetch(`${PHILIDOR_API_URL}/vaults?${qs.toString()}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: RawVault[] };
    if (!Array.isArray(body.data)) return null;
    const rows = body.data.map(normalizeVault).filter((v): v is VaultRisk => v !== null);
    return rows;
  } catch {
    return null;
  }
}
