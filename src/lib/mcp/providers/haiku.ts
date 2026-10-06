/**
 * mcp/providers/haiku.ts — Haiku MCP provider.
 *
 * Aggregates multi-chain portfolio data: token balances, DeFi positions,
 * yield opportunities, and trade history. Acts as the unified data layer
 * that feeds the portfolio + risk engine and the orchestrator's context.
 *
 * Haiku MCP endpoint: https://mcp.haiku.trade/sse (or env override).
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

const HAIKU_MCP_URL = process.env.HAIKU_MCP_URL || "https://mcp.haiku.trade/sse";
const PROVIDER_ID: McpProviderId = "haiku";
const SERVER_NAME = "haiku";

// ─── Health check ────────────────────────────────────────────────────

let lastHealthCheck: McpProviderStatus = {
  id: PROVIDER_ID,
  name: "Haiku",
  healthy: false,
  latencyMs: null,
  lastChecked: 0,
};

export async function checkHealth(): Promise<McpProviderStatus> {
  const start = Date.now();
  try {
    await callMcpTool(HAIKU_MCP_URL, SERVER_NAME, "ping", {}, 5000);
    lastHealthCheck = {
      id: PROVIDER_ID,
      name: "Haiku",
      healthy: true,
      latencyMs: Date.now() - start,
      lastChecked: Date.now(),
    };
  } catch {
    lastHealthCheck = {
      id: PROVIDER_ID,
      name: "Haiku",
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
 * Fetch token balances across all supported chains for a wallet address.
 * Returns per-chain breakdown with USD valuations.
 */
export async function fetchBalances(userAddress: Address): Promise<ChainBalance[]> {
  try {
    const result = await callMcpTool(HAIKU_MCP_URL, SERVER_NAME, "get_balances", {
      address: userAddress,
    });
    return parseResult<ChainBalance[]>(result) ?? [];
  } catch (err) {
    console.warn("[haiku] fetchBalances failed:", err);
    return [];
  }
}

/**
 * Fetch all active DeFi positions (lending, staking, LP, vaults) for a wallet.
 */
export async function fetchPositions(userAddress: Address): Promise<YieldPosition[]> {
  try {
    const result = await callMcpTool(HAIKU_MCP_URL, SERVER_NAME, "get_positions", {
      address: userAddress,
    });
    return parseResult<YieldPosition[]>(result) ?? [];
  } catch (err) {
    console.warn("[haiku] fetchPositions failed:", err);
    return [];
  }
}

/**
 * Fetch the best yield opportunities across protocols and chains.
 * Optionally filter by asset symbol or minimum APY.
 */
export async function fetchYieldOpportunities(opts?: {
  asset?: string;
  minApy?: number;
  chainIds?: number[];
}): Promise<YieldOpportunity[]> {
  try {
    const result = await callMcpTool(HAIKU_MCP_URL, SERVER_NAME, "get_yield_opportunities", {
      ...(opts?.asset && { asset: opts.asset }),
      ...(opts?.minApy && { minApy: opts.minApy }),
      ...(opts?.chainIds && { chainIds: opts.chainIds }),
    });
    return parseResult<YieldOpportunity[]>(result) ?? [];
  } catch (err) {
    console.warn("[haiku] fetchYieldOpportunities failed:", err);
    return [];
  }
}

/**
 * Resolve token info (address, decimals, price) for a symbol on a given chain.
 */
export async function resolveToken(symbol: string, chainId: number): Promise<TokenInfo | null> {
  try {
    const result = await callMcpTool(HAIKU_MCP_URL, SERVER_NAME, "resolve_token", {
      symbol,
      chainId,
    });
    return parseResult<TokenInfo>(result);
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

export async function fetchTradeHistory(
  userAddress: Address,
  opts?: { chainId?: number; limit?: number },
): Promise<TradeRecord[]> {
  try {
    const result = await callMcpTool(HAIKU_MCP_URL, SERVER_NAME, "get_trade_history", {
      address: userAddress,
      ...(opts?.chainId && { chainId: opts.chainId }),
      limit: opts?.limit ?? 50,
    });
    return parseResult<TradeRecord[]>(result) ?? [];
  } catch (err) {
    console.warn("[haiku] fetchTradeHistory failed:", err);
    return [];
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

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
