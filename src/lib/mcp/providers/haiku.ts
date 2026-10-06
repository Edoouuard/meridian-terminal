/**
 * mcp/providers/haiku.ts — Portfolio data provider.
 *
 * Originally connected to Haiku MCP (mcp.haiku.trade) but that endpoint
 * no longer exists as a hosted service. This module now aggregates
 * portfolio data from LI.FI MCP (token balances, earn vaults) and
 * Aave MCP (positions) to provide the same interface.
 *
 * Fallback: uses LI.FI REST + Aave MCP for all reads.
 */

import { callMcpTool } from "../client";
import type {
  McpProviderId,
  McpProviderStatus,
  ChainBalance,
  TokenBalance,
  YieldPosition,
  YieldOpportunity,
  TokenInfo,
} from "../types";
import type { Address } from "viem";

const LIFI_MCP_URL = process.env.LIFI_MCP_URL || "https://mcp.li.quest/mcp";
const AAVE_MCP_URL = process.env.AAVE_MCP_URL || "https://mcp.aave.com";
const PROVIDER_ID: McpProviderId = "haiku";
const SERVER_NAME = "haiku-via-lifi";

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

/**
 * Fetch native token balances across major chains via LI.FI MCP.
 */
export async function fetchBalances(userAddress: Address): Promise<ChainBalance[]> {
  const results: ChainBalance[] = [];

  // Fetch native balances in parallel across chains
  const chainResults = await Promise.allSettled(
    PORTFOLIO_CHAINS.map(async (chainId) => {
      try {
        const result = await callMcpTool(LIFI_MCP_URL, "lifi", "get-native-token-balance", {
          address: userAddress,
          chain: String(chainId),
        }, 8000);
        return { chainId, result };
      } catch {
        return { chainId, result: null };
      }
    }),
  );

  for (const r of chainResults) {
    if (r.status !== "fulfilled" || !r.value.result) continue;
    const { chainId } = r.value;
    const parsed = parseResult<{ amount?: string; symbol?: string; decimals?: number; priceUSD?: string }>(r.value.result);
    if (!parsed?.amount || parsed.amount === "0") continue;

    const balance = parsed.amount;
    const priceUsd = parseFloat(parsed.priceUSD ?? "0");
    const decimals = parsed.decimals ?? 18;
    const balanceNum = parseFloat(balance) / Math.pow(10, decimals);
    const balanceUsd = balanceNum * priceUsd;

    if (balanceUsd < 0.01) continue;

    results.push({
      chainId,
      chainName: CHAIN_NAMES[chainId] ?? `Chain ${chainId}`,
      tokens: [{
        token: {
          address: "0x0000000000000000000000000000000000000000" as Address,
          symbol: parsed.symbol ?? "ETH",
          decimals,
          chainId,
          priceUsd,
        },
        balance,
        balanceUsd,
      }],
      totalUsd: balanceUsd,
    });
  }

  return results;
}

/**
 * Fetch DeFi positions via Aave MCP (other protocols not available without Haiku).
 */
export async function fetchPositions(userAddress: Address): Promise<YieldPosition[]> {
  try {
    const result = await callMcpTool(AAVE_MCP_URL, "aave", "get_user_positions", {
      user: userAddress,
    }, 10000);
    const positions = parseResult<{
      chainId: number;
      supplies?: { symbol: string; balanceUsd: number; apy: number }[];
      borrows?: { symbol: string; balanceUsd: number; apy: number }[];
    }[]>(result);

    if (!positions) return [];

    const yieldPositions: YieldPosition[] = [];
    for (const pos of positions) {
      for (const s of pos.supplies ?? []) {
        if (s.balanceUsd > 0.01) {
          yieldPositions.push({
            protocol: "Aave",
            chainId: pos.chainId,
            type: "lending",
            asset: s.symbol,
            depositedUsd: s.balanceUsd,
            apy: s.apy,
          });
        }
      }
    }
    return yieldPositions;
  } catch (err) {
    console.warn("[haiku] fetchPositions failed:", err);
    return [];
  }
}

/**
 * Fetch yield opportunities via LI.FI earn vaults + Aave markets.
 */
export async function fetchYieldOpportunities(opts?: {
  asset?: string;
  minApy?: number;
  chainIds?: number[];
}): Promise<YieldOpportunity[]> {
  const opportunities: YieldOpportunity[] = [];

  // LI.FI earn vaults
  try {
    const args: Record<string, unknown> = {
      sortBy: "apy",
      sortDirection: "desc",
      limit: 30,
    };
    if (opts?.asset) args.asset = opts.asset;
    if (opts?.chainIds?.[0]) args.chainId = String(opts.chainIds[0]);

    const result = await callMcpTool(LIFI_MCP_URL, "lifi", "get-earn-vaults", args, 10000);
    const vaults = parseResult<{
      address: string;
      chainId: number;
      protocol?: string;
      asset?: string;
      apy?: number;
      tvl?: number;
      tags?: string[];
    }[]>(result);

    if (vaults) {
      for (const v of vaults) {
        const apy = v.apy ?? 0;
        if (opts?.minApy && apy < opts.minApy / 100) continue;
        opportunities.push({
          protocol: v.protocol ?? "Unknown",
          chainId: v.chainId,
          asset: v.asset ?? "?",
          type: "vault",
          apy: apy * 100, // normalize to percentage
          tvlUsd: v.tvl ?? 0,
        });
      }
    }
  } catch (err) {
    console.warn("[haiku] LI.FI earn vaults fetch failed:", err);
  }

  // Aave markets as yield opportunities
  try {
    const result = await callMcpTool(AAVE_MCP_URL, "aave", "get_markets", {}, 10000);
    const markets = parseResult<{
      chainId: number;
      reserves?: {
        symbol: string;
        supplyAPY?: number;
        borrowAPY?: number;
        totalSupply?: number;
        ltv?: number;
      }[];
    }[]>(result);

    if (markets) {
      for (const m of markets) {
        for (const r of m.reserves ?? []) {
          const apy = (r.supplyAPY ?? 0) * 100;
          if (opts?.minApy && apy < opts.minApy) continue;
          opportunities.push({
            protocol: "Aave",
            chainId: m.chainId,
            asset: r.symbol,
            type: "lending",
            apy,
            tvlUsd: r.totalSupply ?? 0,
          });
        }
      }
    }
  } catch (err) {
    console.warn("[haiku] Aave markets fetch failed:", err);
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
    const token = parseResult<{
      address: string;
      symbol: string;
      decimals: number;
      name: string;
      priceUSD?: string;
    }>(result);
    if (!token) return null;
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
  timestamp: number;
  action: string;
  protocol: string;
  tokenIn: string;
  tokenOut?: string;
  amountIn: string;
  amountOut?: string;
  valueUsd: number;
}

/**
 * Fetch trade history via Aave MCP user_activity.
 * Other protocols' history not available without Haiku.
 */
export async function fetchTradeHistory(
  userAddress: Address,
  opts?: { chainId?: number; limit?: number },
): Promise<TradeRecord[]> {
  try {
    const args: Record<string, unknown> = { user: userAddress };
    if (opts?.chainId) args.chainId = opts.chainId;
    const result = await callMcpTool(AAVE_MCP_URL, "aave", "get_user_activity", args, 10000);
    const activities = parseResult<{
      txHash: string;
      chainId: number;
      timestamp: number;
      action: string;
      reserve?: string;
      amount?: string;
      amountUSD?: number;
    }[]>(result);

    if (!activities) return [];

    return activities.slice(0, opts?.limit ?? 50).map((a) => ({
      txHash: a.txHash,
      chainId: a.chainId,
      timestamp: a.timestamp,
      action: a.action,
      protocol: "Aave",
      tokenIn: a.reserve ?? "?",
      amountIn: a.amount ?? "0",
      valueUsd: a.amountUSD ?? 0,
    }));
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

function parseResult<T>(content: unknown): T | null {
  if (!content) return null;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && "type" in block) {
        if (block.type === "text" && "text" in block) {
          try { return JSON.parse(block.text as string) as T; } catch { return null; }
        }
      }
    }
    return null;
  }
  if (typeof content === "string") {
    try { return JSON.parse(content) as T; } catch { return null; }
  }
  return content as T;
}
