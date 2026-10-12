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

import { callMcpTool, listMcpTools, parseMcpToolResult as parseResult } from "../client";
import { fetchAavePositions, fetchAaveReserves } from "../aave";
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
const LIFI_HEADERS = process.env.LIFI_API_KEY ? { "x-lifi-api-key": process.env.LIFI_API_KEY } : undefined;
const PROVIDER_ID: McpProviderId = "haiku";

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
    const { tools } = await listMcpTools(LIFI_MCP_URL, "lifi", { timeoutMs: 8000, headers: LIFI_HEADERS });
    if (!tools.some((t) => t.name === "get-token")) throw new Error("LI.FI MCP does not expose get-token");
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
        }, { timeoutMs: 8000, headers: LIFI_HEADERS });
        return { chainId, result };
      } catch {
        return { chainId, result: null };
      }
    }),
  );

  for (const r of chainResults) {
    if (r.status !== "fulfilled" || !r.value.result) continue;
    const { chainId } = r.value;
    const parsed = unwrapPayload(parseResult<unknown>(r.value.result)) as
      { amount?: string; balance?: string; symbol?: string; decimals?: number; priceUSD?: string; token?: { symbol?: string; decimals?: number; priceUSD?: string } } | null;
    if (parsed && !parsed.amount && parsed.balance) parsed.amount = parsed.balance;
    if (parsed?.token) {
      parsed.symbol ??= parsed.token.symbol;
      parsed.decimals ??= parsed.token.decimals;
      parsed.priceUSD ??= parsed.token.priceUSD;
    }
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
  const positions = await fetchAavePositions(userAddress);
  return positions.flatMap((pos) =>
    pos.supplies
      .filter((s) => s.balanceUsd > 0.01)
      .map((s): YieldPosition => ({
        protocol: "Aave",
        chainId: pos.chainId,
        type: "lending",
        asset: s.symbol,
        depositedUsd: s.balanceUsd,
        apy: s.apy * 100,
      })),
  );
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

    const result = await callMcpTool(LIFI_MCP_URL, "lifi", "get-earn-vaults", args, { timeoutMs: 10000, headers: LIFI_HEADERS });
    const vaultsRaw = unwrapPayload(parseResult<unknown>(result));
    const vaults = (Array.isArray(vaultsRaw)
      ? vaultsRaw
      : vaultsRaw && typeof vaultsRaw === "object" && Array.isArray((vaultsRaw as { vaults?: unknown }).vaults)
        ? (vaultsRaw as { vaults: unknown[] }).vaults
        : null) as {
      address: string;
      chainId: number;
      protocol?: string;
      asset?: string;
      apy?: number;
      tvl?: number;
      tags?: string[];
    }[] | null;

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

  // Aave v3 markets as yield opportunities (parallel per chain)
  const aaveChains = opts?.chainIds?.length ? opts.chainIds : PORTFOLIO_CHAINS;
  const symbols = opts?.asset ? [opts.asset] : undefined;
  const perChain = await Promise.all(aaveChains.map((chainId) => fetchAaveReserves(chainId, symbols)));
  aaveChains.forEach((chainId, i) => {
    for (const r of perChain[i]) {
      const apy = r.supplyAPY * 100;
      if (opts?.minApy && apy < opts.minApy) continue;
      opportunities.push({ protocol: "Aave", chainId, asset: r.symbol, type: "lending", apy, tvlUsd: r.totalSupply });
    }
  });

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
    }, { timeoutMs: 8000, headers: LIFI_HEADERS });
    const token = unwrapPayload(parseResult<unknown>(result)) as {
      address: string;
      symbol: string;
      decimals: number;
      name: string;
      priceUSD?: string;
    } | null;
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
    const args: Record<string, unknown> = { user: userAddress, version: "v3", chainId: opts?.chainId ?? 1 };
    const result = await callMcpTool(AAVE_MCP_URL, "aave", "get_user_activity", args, 10000);
    const parsed = parseResult<{ data?: { v3?: { items?: Record<string, unknown>[] } } }>(result);
    const items = parsed?.data?.v3?.items ?? [];

    const val = (v: unknown, key: "value" | "usd"): string | undefined => {
      if (typeof v === "string" || typeof v === "number") return key === "value" ? String(v) : undefined;
      if (v && typeof v === "object" && key in v) return String((v as Record<string, unknown>)[key]);
      return undefined;
    };

    return items.slice(0, opts?.limit ?? 50).map((a) => {
      const reserve = a.reserve as { symbol?: string } | undefined;
      const amount = a.amount ?? a.collateral ?? a.debt;
      const ts = a.timestamp;
      return {
        txHash: String(a.txHash ?? ""),
        chainId: Number(a.chainId ?? opts?.chainId ?? 1),
        timestamp: typeof ts === "number" ? ts : Math.floor(new Date(String(ts)).getTime() / 1000) || 0,
        action: String(a.__typename ?? "activity").replace(/^User|Transaction$/g, ""),
        protocol: "Aave",
        tokenIn: reserve?.symbol ?? "?",
        amountIn: val(amount, "value") ?? "0",
        valueUsd: Number(val(amount, "usd") ?? 0) || 0,
      };
    });
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

/** LI.FI/Aave MCP payloads may be wrapped as { data } / { result }; unwrap one level. */
function unwrapPayload(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (o.data !== undefined && typeof o.data === "object") return o.data;
    if (o.result !== undefined && typeof o.result === "object") return o.result;
  }
  return v;
}

