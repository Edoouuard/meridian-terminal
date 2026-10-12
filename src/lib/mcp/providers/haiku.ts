/**
 * mcp/providers/haiku.ts — Portfolio data provider.
 *
 * Originally connected to Haiku MCP (mcp.haiku.trade) but that endpoint
 * no longer exists as a hosted service. This module now aggregates
 * portfolio data from LI.FI MCP (native balances, token prices, earn vaults)
 * and Aave MCP (positions, markets, activity) behind the same interface.
 *
 * Overlap with on-chain reads: useLivePortfolio already reads native
 * balances on every supported chain and Aave v3 positions in each chain's
 * main pool (lib/onchain.ts LENDING_POOLS_BY_CHAIN). `fetchPositions`
 * therefore only returns positions in Aave markets that list doesn't cover
 * (e.g. Aave's Lido / EtherFi / Horizon markets on Ethereum), so the page can
 * add them to the portfolio value without counting anything twice.
 */

import { callMcpTool, parseMcpToolResult } from "../client";
import { fetchAavePositions, fetchAaveReserves, isAaveReserveExecutable, isAaveReserveSuppliable } from "../aave";
import { LENDING_POOLS_BY_CHAIN } from "@/lib/onchain";
import type {
  McpProviderId,
  McpProviderStatus,
  ChainBalance,
  YieldPosition,
  YieldOpportunity,
  TokenInfo,
} from "../types";
import type { Address } from "viem";

const LIFI_MCP_URL = process.env.LIFI_MCP_URL || "https://mcp.li.quest/mcp";
const AAVE_MCP_URL = process.env.AAVE_MCP_URL || "https://mcp.aave.com";
const PROVIDER_ID: McpProviderId = "haiku";
const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";

// Major chains for portfolio scanning
const PORTFOLIO_CHAINS = [1, 10, 56, 137, 8453, 42161, 43114, 324, 59144, 534352];

// ─── Health check ────────────────────────────────────────────────────

let lastHealthCheck: McpProviderStatus = {
  id: PROVIDER_ID,
  name: "Portfolio (LI.FI)",
  healthy: false,
  latencyMs: null,
  lastChecked: 0,
};

export async function checkHealth(): Promise<McpProviderStatus> {
  const start = Date.now();
  try {
    await callMcpTool(LIFI_MCP_URL, "lifi", "health-check", {}, 8000);
    lastHealthCheck = {
      id: PROVIDER_ID,
      name: "Portfolio (LI.FI)",
      healthy: true,
      latencyMs: Date.now() - start,
      lastChecked: Date.now(),
    };
  } catch {
    lastHealthCheck = {
      id: PROVIDER_ID,
      name: "Portfolio (LI.FI)",
      healthy: false,
      latencyMs: Date.now() - start,
      lastChecked: Date.now(),
    };
  }
  return lastHealthCheck;
}

export function getStatus(): McpProviderStatus {
  return lastHealthCheck;
}

// ─── Portfolio reads ─────────────────────────────────────────────────

/** Native gas-token price on a chain, from LI.FI's token metadata. */
async function fetchNativePriceUsd(chainId: number): Promise<number | null> {
  try {
    const result = await callMcpTool(LIFI_MCP_URL, "lifi", "get-token", {
      chain: String(chainId),
      token: NATIVE_TOKEN,
    }, 8000);
    const price = parseFloat(parseMcpToolResult<{ priceUSD?: string }>(result)?.priceUSD ?? "");
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

/**
 * Fetch native token balances across major chains via LI.FI MCP.
 * Overlaps useLivePortfolio's own native-balance reads — informational only,
 * never add it to the on-chain portfolio value.
 */
export async function fetchBalances(userAddress: Address): Promise<ChainBalance[]> {
  const chainResults = await Promise.all(
    PORTFOLIO_CHAINS.map(async (chainId) => {
      try {
        const result = await callMcpTool(LIFI_MCP_URL, "lifi", "get-native-token-balance", {
          address: userAddress,
          chain: String(chainId),
        }, 8000);
        // { address, balance, chainId, decimals, tokenSymbol } — balance in base units.
        const parsed = parseMcpToolResult<{ balance?: string; decimals?: number; tokenSymbol?: string }>(result);
        if (!parsed?.balance || !/^\d+$/.test(parsed.balance) || BigInt(parsed.balance) === 0n) return null;
        const priceUsd = await fetchNativePriceUsd(chainId);
        return { chainId, parsed, priceUsd };
      } catch {
        return null;
      }
    }),
  );

  const results: ChainBalance[] = [];
  for (const r of chainResults) {
    if (!r || r.priceUsd === null) continue;
    const { chainId, parsed, priceUsd } = r;
    const decimals = parsed.decimals ?? 18;
    const balanceNum = Number(BigInt(parsed.balance!)) / 10 ** decimals;
    const balanceUsd = balanceNum * priceUsd;
    if (balanceUsd < 0.01) continue;

    results.push({
      chainId,
      chainName: CHAIN_NAMES[chainId] ?? `Chain ${chainId}`,
      tokens: [{
        token: {
          address: NATIVE_TOKEN as Address,
          symbol: parsed.tokenSymbol ?? "ETH",
          decimals,
          chainId,
          priceUsd,
        },
        balance: parsed.balance!,
        balanceUsd,
      }],
      totalUsd: balanceUsd,
    });
  }

  return results;
}

/** True when useLivePortfolio already reads this Aave market on-chain. */
function isTrackedOnChain(chainId: number, market: string): boolean {
  return (LENDING_POOLS_BY_CHAIN[chainId] ?? []).some((p) => p.pool.toLowerCase() === market.toLowerCase());
}

/**
 * Fetch Aave v3 positions (via Aave MCP) in the markets useLivePortfolio does
 * NOT read on-chain. Supplies are positive `depositedUsd`, borrows negative,
 * so summing `depositedUsd` gives the net value those markets add.
 */
export async function fetchPositions(userAddress: Address): Promise<YieldPosition[]> {
  const positions = await fetchAavePositions(userAddress);
  const out: YieldPosition[] = [];
  for (const p of positions) {
    if (isTrackedOnChain(p.chainId, p.market)) continue;
    const protocol = `Aave v3 (${p.marketName})`;
    for (const s of p.supplies) {
      if (s.balanceUsd > 0.01) {
        out.push({ protocol, chainId: p.chainId, type: "lending", asset: s.symbol, depositedUsd: s.balanceUsd, apy: s.apy });
      }
    }
    for (const b of p.borrows) {
      if (b.balanceUsd > 0.01) {
        out.push({ protocol, chainId: p.chainId, type: "lending", asset: `${b.symbol} debt`, depositedUsd: -b.balanceUsd, apy: -b.apy });
      }
    }
  }
  return out;
}

/**
 * Fetch yield opportunities via LI.FI earn vaults + Aave v3 markets.
 * APYs are in percent (4.23 = 4.23%).
 */
export async function fetchYieldOpportunities(opts?: {
  asset?: string;
  minApy?: number;
  chainIds?: number[];
  /** Include Aave v3 reserves (default true). */
  includeAave?: boolean;
}): Promise<YieldOpportunity[]> {
  const opportunities: YieldOpportunity[] = [];

  // LI.FI earn vaults. LI.FI's hosted MCP currently answers HTTP 404 for this
  // tool (an upstream bug) — failures are caught and the Aave rows still load.
  try {
    const args: Record<string, unknown> = {
      sortBy: "apy",
      sortDirection: "desc",
      limit: 30,
    };
    if (opts?.asset) args.asset = opts.asset;
    if (opts?.chainIds?.[0]) args.chainId = String(opts.chainIds[0]);

    const result = await callMcpTool(LIFI_MCP_URL, "lifi", "get-earn-vaults", args, 10000);
    const vaults = parseMcpToolResult<{
      address: string;
      chainId: number;
      protocol?: string;
      asset?: string;
      apy?: number;
      tvl?: number;
    }[]>(result);

    if (Array.isArray(vaults)) {
      for (const v of vaults) {
        const apy = (v.apy ?? 0) * 100; // fraction → percent
        if (opts?.minApy && apy < opts.minApy) continue;
        opportunities.push({
          protocol: v.protocol ?? "Unknown",
          chainId: v.chainId,
          asset: v.asset ?? "?",
          type: "vault",
          apy,
          tvlUsd: v.tvl ?? 0,
        });
      }
    }
  } catch (err) {
    console.warn("[haiku] LI.FI earn vaults unavailable:", err instanceof Error ? err.message : err);
  }

  // Aave v3 markets as yield opportunities (only reserves that accept deposits now).
  if (opts?.includeAave === false) return opportunities.sort((a, b) => b.apy - a.apy);
  const chainIds = opts?.chainIds?.length ? opts.chainIds : PORTFOLIO_CHAINS;
  const reservesPerChain = await Promise.all(chainIds.map((id) => fetchAaveReserves(id)));
  const assetFilter = opts?.asset?.toUpperCase();
  for (const reserves of reservesPerChain) {
    for (const r of reserves) {
      if (!isAaveReserveExecutable(r) || !isAaveReserveSuppliable(r) || r.supplyApyPct <= 0) continue;
      if (opts?.minApy && r.supplyApyPct < opts.minApy) continue;
      if (assetFilter && r.symbol.toUpperCase() !== assetFilter) continue;
      opportunities.push({
        protocol: "Aave v3",
        chainId: r.chainId,
        asset: r.symbol,
        type: "lending",
        apy: r.supplyApyPct,
        tvlUsd: r.totalSuppliedUsd,
      });
    }
  }

  return opportunities.sort((a, b) => b.apy - a.apy);
}

/**
 * Resolve token info via LI.FI MCP.
 */
export async function resolveToken(symbol: string, chainId: number): Promise<TokenInfo | null> {
  try {
    const result = await callMcpTool(LIFI_MCP_URL, "lifi", "get-token", {
      chain: String(chainId),
      token: symbol,
    }, 8000);
    const token = parseMcpToolResult<{
      address: string;
      symbol: string;
      decimals: number;
      name: string;
      priceUSD?: string;
    }>(result);
    if (!token?.address) return null;
    return {
      address: token.address as Address,
      symbol: token.symbol,
      decimals: token.decimals,
      chainId,
      name: token.name,
      priceUsd: token.priceUSD ? parseFloat(token.priceUSD) : undefined,
    };
  } catch (err) {
    console.warn("[haiku] resolveToken failed:", err);
    return null;
  }
}

// ─── Trade history ───────────────────────────────────────────────────

export interface TradeRecord {
  txHash: string;
  chainId: number;
  /** Unix time in milliseconds. */
  timestamp: number;
  action: string;
  protocol: string;
  tokenIn: string;
  tokenOut?: string;
  amountIn: string;
  amountOut?: string;
  valueUsd: number;
}

interface RawActivityItem {
  __typename?: string;
  txHash: string;
  timestamp: string;
  amount?: { value: string; usd: string };
  reserve?: { symbol: string; token: string };
  enabled?: boolean;
}

/** "UserSupplyTransaction" → "supply"; collateral toggles get an explicit label. */
function activityAction(item: RawActivityItem): string {
  const name = item.__typename ?? "";
  if (name === "UserUsageAsCollateralTransaction") return item.enabled ? "enable collateral" : "disable collateral";
  const m = name.match(/^User(\w+?)Transaction$/);
  return m ? m[1].toLowerCase() : name || "activity";
}

/**
 * Fetch Aave v3 activity via Aave MCP get_user_activity. Aave reads v3
 * history one chain at a time — without `chainId` this is Ethereum.
 */
export async function fetchTradeHistory(
  userAddress: Address,
  opts?: { chainId?: number; limit?: number },
): Promise<TradeRecord[]> {
  try {
    const args: Record<string, unknown> = { user: userAddress };
    if (opts?.chainId) args.chainId = opts.chainId;
    const result = await callMcpTool(AAVE_MCP_URL, "aave", "get_user_activity", args, 10000);
    const v3 = parseMcpToolResult<{ data?: { v3?: { chainsCovered?: number[]; items?: RawActivityItem[] } } }>(result)?.data?.v3;
    if (!v3?.items) return [];
    const chainId = opts?.chainId ?? v3.chainsCovered?.[0] ?? 1;

    return v3.items
      .map((a) => ({
        txHash: a.txHash,
        chainId,
        timestamp: Date.parse(a.timestamp) || 0,
        action: activityAction(a),
        protocol: "Aave v3",
        tokenIn: a.reserve?.symbol ?? "?",
        amountIn: a.amount?.value ?? "0",
        valueUsd: parseFloat(a.amount?.usd ?? "0") || 0,
      }))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, opts?.limit ?? 50);
  } catch (err) {
    console.warn("[haiku] fetchTradeHistory failed:", err);
    return [];
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum", 10: "Optimism", 56: "BNB Chain", 100: "Gnosis",
  137: "Polygon", 146: "Sonic", 250: "Fantom", 324: "zkSync Era",
  1088: "Metis", 5000: "Mantle", 8453: "Base", 42161: "Arbitrum",
  42220: "Celo", 43114: "Avalanche", 59144: "Linea", 534352: "Scroll",
};
