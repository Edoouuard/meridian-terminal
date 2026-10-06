/**
 * mcp/providers/lifi.ts — LI.FI MCP provider.
 *
 * Second cross-chain router / fallback / comparison layer.
 * LI.FI aggregates 30+ bridges and DEX aggregators, providing
 * competitive routing as a fallback when deBridge is down or
 * when comparing quotes for best execution.
 *
 * LI.FI MCP endpoint: https://mcp.li.fi/sse (or env override).
 */

import { callMcpTool } from "../client";
import type {
  McpProviderId,
  McpProviderStatus,
  RouteQuote,
  RouteRequest,
  RouteExecution,
  RouteStep,
  UnsignedTx,
} from "../types";
import type { Address } from "viem";

const LIFI_MCP_URL = process.env.LIFI_MCP_URL || "https://mcp.li.fi/sse";
const PROVIDER_ID: McpProviderId = "lifi";
const SERVER_NAME = "lifi";

// ─── Health check ────────────────────────────────────────────────────

let lastHealthCheck: McpProviderStatus = {
  id: PROVIDER_ID,
  name: "LI.FI",
  healthy: false,
  latencyMs: null,
  lastChecked: 0,
};

export async function checkHealth(): Promise<McpProviderStatus> {
  const start = Date.now();
  try {
    await callMcpTool(LIFI_MCP_URL, SERVER_NAME, "ping", {}, 5000);
    lastHealthCheck = {
      id: PROVIDER_ID,
      name: "LI.FI",
      healthy: true,
      latencyMs: Date.now() - start,
      lastChecked: Date.now(),
    };
  } catch {
    lastHealthCheck = {
      id: PROVIDER_ID,
      name: "LI.FI",
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

// ─── Quote ───────────────────────────────────────────────────────────

interface LiFiStepRaw {
  type: "swap" | "cross" | "lifi";
  tool: string;
  action: {
    fromToken: { symbol: string; address: string };
    toToken: { symbol: string; address: string };
    fromChainId: number;
    toChainId: number;
  };
  estimate: {
    toAmount: string;
    executionDuration: number;
    gasCosts: { amountUSD: string }[];
    feeCosts: { amountUSD: string }[];
  };
}

interface LiFiQuoteRaw {
  id: string;
  type: string;
  action: {
    fromToken: { symbol: string; address: string; decimals: number; name: string; chainId: number };
    toToken: { symbol: string; address: string; decimals: number; name: string; chainId: number };
    fromAmount: string;
  };
  estimate: {
    toAmount: string;
    toAmountUSD: string;
    executionDuration: number;
    gasCosts: { amountUSD: string }[];
    feeCosts: { amountUSD: string }[];
  };
  includedSteps: LiFiStepRaw[];
  transactionRequest?: {
    to: string;
    data: string;
    value: string;
    gasLimit: string;
    chainId: number;
  };
}

/**
 * Get a cross-chain or same-chain swap quote from LI.FI.
 * Returns a normalized RouteQuote or null on failure.
 */
export async function getQuote(request: RouteRequest): Promise<RouteQuote | null> {
  try {
    const result = await callMcpTool(LIFI_MCP_URL, SERVER_NAME, "get_quote", {
      fromChain: request.fromChainId,
      toChain: request.toChainId,
      fromToken: request.fromToken,
      toToken: request.toToken,
      fromAmount: request.fromAmount,
      fromAddress: request.userAddress,
      slippage: request.slippage ?? 0.005,
    });

    const raw = parseResult<LiFiQuoteRaw>(result);
    if (!raw?.estimate) return null;

    const gasCostsUsd = raw.estimate.gasCosts?.reduce(
      (sum, g) => sum + parseFloat(g.amountUSD || "0"),
      0,
    ) ?? 0;
    const feeCostsUsd = raw.estimate.feeCosts?.reduce(
      (sum, f) => sum + parseFloat(f.amountUSD || "0"),
      0,
    ) ?? 0;

    const steps: RouteStep[] = (raw.includedSteps ?? []).map((s) => ({
      type: s.type === "cross" ? "bridge" as const : "swap" as const,
      provider: s.tool,
      fromToken: s.action.fromToken.symbol,
      toToken: s.action.toToken.symbol,
      fromChainId: s.action.fromChainId,
      toChainId: s.action.toChainId,
      estimatedTimeSeconds: s.estimate.executionDuration,
    }));

    return {
      provider: PROVIDER_ID,
      fromToken: {
        address: request.fromToken,
        symbol: raw.action.fromToken.symbol,
        decimals: raw.action.fromToken.decimals,
        chainId: request.fromChainId,
        name: raw.action.fromToken.name,
      },
      toToken: {
        address: request.toToken,
        symbol: raw.action.toToken.symbol,
        decimals: raw.action.toToken.decimals,
        chainId: request.toChainId,
        name: raw.action.toToken.name,
      },
      fromAmount: request.fromAmount,
      toAmount: raw.estimate.toAmount,
      toAmountUsd: parseFloat(raw.estimate.toAmountUSD || "0"),
      estimatedFeesUsd: gasCostsUsd + feeCostsUsd,
      estimatedTimeSeconds: raw.estimate.executionDuration ?? 60,
      routeData: raw,
      steps,
      slippage: request.slippage ?? 0.005,
    };
  } catch (err) {
    console.warn("[lifi] getQuote failed:", err);
    return null;
  }
}

// ─── Build transaction ───────────────────────────────────────────────

/**
 * Build the unsigned transaction(s) to execute a LI.FI route.
 * LI.FI typically returns the tx in the quote itself, but we call
 * a dedicated build endpoint for fresh data.
 */
export async function buildTransaction(
  request: RouteRequest,
  quoteData: LiFiQuoteRaw,
): Promise<RouteExecution | null> {
  try {
    // LI.FI embeds tx in the quote — use it if fresh, otherwise re-fetch
    if (quoteData.transactionRequest) {
      const tx = quoteData.transactionRequest;
      return {
        provider: PROVIDER_ID,
        transactions: [
          {
            to: tx.to as Address,
            data: tx.data as `0x${string}`,
            value: tx.value ?? "0",
            chainId: tx.chainId ?? request.fromChainId,
            gasLimit: tx.gasLimit,
          },
        ],
        approvals: [],
      };
    }

    // Re-fetch with build step
    const result = await callMcpTool(LIFI_MCP_URL, SERVER_NAME, "build_tx", {
      routeId: quoteData.id,
      fromAddress: request.userAddress,
    });

    const txData = parseResult<{
      transactionRequest: { to: string; data: string; value: string; gasLimit: string; chainId: number };
      approvalRequest?: { to: string; data: string; value: string; chainId: number };
    }>(result);

    if (!txData?.transactionRequest) return null;

    const transactions: UnsignedTx[] = [
      {
        to: txData.transactionRequest.to as Address,
        data: txData.transactionRequest.data as `0x${string}`,
        value: txData.transactionRequest.value ?? "0",
        chainId: txData.transactionRequest.chainId ?? request.fromChainId,
        gasLimit: txData.transactionRequest.gasLimit,
      },
    ];

    const approvals: UnsignedTx[] = [];
    if (txData.approvalRequest) {
      approvals.push({
        to: txData.approvalRequest.to as Address,
        data: txData.approvalRequest.data as `0x${string}`,
        value: "0",
        chainId: txData.approvalRequest.chainId ?? request.fromChainId,
      });
    }

    return { provider: PROVIDER_ID, transactions, approvals };
  } catch (err) {
    console.warn("[lifi] buildTransaction failed:", err);
    return null;
  }
}

// ─── Route status (cross-chain tracking) ─────────────────────────────

export interface LiFiRouteStatus {
  status: "PENDING" | "DONE" | "FAILED" | "NOT_FOUND";
  substatus?: string;
  sending?: { txHash: string; chainId: number };
  receiving?: { txHash: string; chainId: number };
}

export async function getRouteStatus(txHash: string, fromChainId: number): Promise<LiFiRouteStatus | null> {
  try {
    const result = await callMcpTool(LIFI_MCP_URL, SERVER_NAME, "get_status", {
      txHash,
      bridge: "any",
      fromChain: fromChainId,
    });
    return parseResult<LiFiRouteStatus>(result);
  } catch (err) {
    console.warn("[lifi] getRouteStatus failed:", err);
    return null;
  }
}

// ─── Supported chains ────────────────────────────────────────────────

export async function getSupportedChains(): Promise<{ id: number; name: string }[]> {
  // Try MCP first, fall back to REST API
  try {
    const result = await callMcpTool(LIFI_MCP_URL, SERVER_NAME, "get_chains", {});
    const chains = parseResult<{ id: number; name: string }[]>(result);
    if (chains && chains.length > 0) return chains;
  } catch { /* fall through to REST */ }

  try {
    const res = await fetch(`${LIFI_REST_URL}/chains`, {
      signal: AbortSignal.timeout(8000),
      headers: LIFI_HEADERS,
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.chains ?? []).map((c: { id: number; name: string }) => ({ id: c.id, name: c.name }));
  } catch {
    return [];
  }
}

// ─── Token resolution ────────────────────────────────────────────────

export interface LiFiToken {
  address: string;
  symbol: string;
  decimals: number;
  chainId: number;
  name: string;
  logoURI?: string;
  priceUSD?: string;
}

/**
 * Resolve tokens on a given chain. Useful for finding the correct
 * token address when building bridge/swap requests.
 */
export async function getTokens(chainId: number): Promise<LiFiToken[]> {
  try {
    const result = await callMcpTool(LIFI_MCP_URL, SERVER_NAME, "get_tokens", {
      chains: [chainId],
    });
    const data = parseResult<{ tokens: Record<string, LiFiToken[]> }>(result);
    return data?.tokens?.[String(chainId)] ?? [];
  } catch { /* fall through to REST */ }

  try {
    const res = await fetch(`${LIFI_REST_URL}/tokens?chains=${chainId}`, {
      signal: AbortSignal.timeout(8000),
      headers: LIFI_HEADERS,
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.tokens?.[String(chainId)] ?? [];
  } catch {
    return [];
  }
}

/**
 * Find a specific token by symbol on a chain.
 */
export async function findToken(symbol: string, chainId: number): Promise<LiFiToken | null> {
  const tokens = await getTokens(chainId);
  const needle = symbol.trim().toUpperCase();
  return tokens.find((t) => t.symbol.toUpperCase() === needle) ?? null;
}

// ─── Same-chain swap (LI.FI as DEX aggregator) ──────────────────────

/**
 * Get a same-chain swap quote from LI.FI. LI.FI aggregates 30+ DEXes
 * (1inch, Paraswap, 0x, etc.) so it often beats a single Uniswap pool.
 * Same interface as cross-chain getQuote but with fromChainId === toChainId.
 */
export { getQuote as getSwapQuote };

// ─── REST API fallback ───────────────────────────────────────────────

const LIFI_REST_URL = process.env.LIFI_REST_URL || "https://li.quest/v1";
const LIFI_API_KEY = process.env.LIFI_API_KEY || "";
const LIFI_HEADERS: Record<string, string> = {
  ...(LIFI_API_KEY ? { "x-lifi-api-key": LIFI_API_KEY } : {}),
};

/**
 * REST API fallback for quotes when the MCP SSE server is unreachable.
 * Uses the same LI.FI v1 API directly.
 */
export async function getQuoteViaRest(request: RouteRequest): Promise<RouteQuote | null> {
  try {
    const params = new URLSearchParams({
      fromChain: String(request.fromChainId),
      toChain: String(request.toChainId),
      fromToken: request.fromToken,
      toToken: request.toToken,
      fromAmount: request.fromAmount,
      fromAddress: request.userAddress,
      slippage: String(request.slippage ?? 0.005),
    });

    const res = await fetch(`${LIFI_REST_URL}/quote?${params}`, {
      signal: AbortSignal.timeout(15000),
      headers: LIFI_HEADERS,
    });
    if (!res.ok) return null;

    const raw: LiFiQuoteRaw = await res.json();
    if (!raw?.estimate) return null;

    const gasCostsUsd = raw.estimate.gasCosts?.reduce(
      (sum, g) => sum + parseFloat(g.amountUSD || "0"), 0,
    ) ?? 0;
    const feeCostsUsd = raw.estimate.feeCosts?.reduce(
      (sum, f) => sum + parseFloat(f.amountUSD || "0"), 0,
    ) ?? 0;

    const steps: RouteStep[] = (raw.includedSteps ?? []).map((s) => ({
      type: s.type === "cross" ? "bridge" as const : "swap" as const,
      provider: s.tool,
      fromToken: s.action.fromToken.symbol,
      toToken: s.action.toToken.symbol,
      fromChainId: s.action.fromChainId,
      toChainId: s.action.toChainId,
      estimatedTimeSeconds: s.estimate.executionDuration,
    }));

    return {
      provider: PROVIDER_ID,
      fromToken: {
        address: request.fromToken,
        symbol: raw.action.fromToken.symbol,
        decimals: raw.action.fromToken.decimals,
        chainId: request.fromChainId,
        name: raw.action.fromToken.name,
      },
      toToken: {
        address: request.toToken,
        symbol: raw.action.toToken.symbol,
        decimals: raw.action.toToken.decimals,
        chainId: request.toChainId,
        name: raw.action.toToken.name,
      },
      fromAmount: request.fromAmount,
      toAmount: raw.estimate.toAmount,
      toAmountUsd: parseFloat(raw.estimate.toAmountUSD || "0"),
      estimatedFeesUsd: gasCostsUsd + feeCostsUsd,
      estimatedTimeSeconds: raw.estimate.executionDuration ?? 30,
      routeData: raw,
      steps,
      slippage: request.slippage ?? 0.005,
    };
  } catch (err) {
    console.warn("[lifi] getQuoteViaRest failed:", err);
    return null;
  }
}

/**
 * Enhanced getQuote: tries MCP first, falls back to REST API.
 */
export async function getQuoteWithFallback(request: RouteRequest): Promise<RouteQuote | null> {
  const mcpQuote = await getQuote(request);
  if (mcpQuote) return mcpQuote;
  return getQuoteViaRest(request);
}

/**
 * REST API fallback for building transactions.
 */
export async function buildTransactionViaRest(
  request: RouteRequest,
  quoteData: LiFiQuoteRaw,
): Promise<RouteExecution | null> {
  // LI.FI embeds the tx in the quote response
  if (quoteData.transactionRequest) {
    const tx = quoteData.transactionRequest;
    return {
      provider: PROVIDER_ID,
      transactions: [{
        to: tx.to as Address,
        data: tx.data as `0x${string}`,
        value: tx.value ?? "0",
        chainId: tx.chainId ?? request.fromChainId,
        gasLimit: tx.gasLimit,
      }],
      approvals: [],
    };
  }

  // If no embedded tx, re-quote via REST to get one
  try {
    const params = new URLSearchParams({
      fromChain: String(request.fromChainId),
      toChain: String(request.toChainId),
      fromToken: request.fromToken,
      toToken: request.toToken,
      fromAmount: request.fromAmount,
      fromAddress: request.userAddress,
      slippage: String(request.slippage ?? 0.005),
    });

    const res = await fetch(`${LIFI_REST_URL}/quote?${params}`, {
      signal: AbortSignal.timeout(15000),
      headers: LIFI_HEADERS,
    });
    if (!res.ok) return null;

    const freshQuote: LiFiQuoteRaw = await res.json();
    if (!freshQuote?.transactionRequest) return null;

    const tx = freshQuote.transactionRequest;
    return {
      provider: PROVIDER_ID,
      transactions: [{
        to: tx.to as Address,
        data: tx.data as `0x${string}`,
        value: tx.value ?? "0",
        chainId: tx.chainId ?? request.fromChainId,
        gasLimit: tx.gasLimit,
      }],
      approvals: [],
    };
  } catch (err) {
    console.warn("[lifi] buildTransactionViaRest failed:", err);
    return null;
  }
}

/**
 * Enhanced buildTransaction: tries MCP first, falls back to REST API.
 */
export async function buildTransactionWithFallback(
  request: RouteRequest,
  quoteData: LiFiQuoteRaw,
): Promise<RouteExecution | null> {
  const mcpResult = await buildTransaction(request, quoteData);
  if (mcpResult) return mcpResult;
  return buildTransactionViaRest(request, quoteData);
}

/**
 * REST API fallback for route status tracking.
 */
export async function getRouteStatusViaRest(
  txHash: string,
  fromChainId: number,
  toChainId: number,
): Promise<LiFiRouteStatus | null> {
  try {
    const params = new URLSearchParams({
      txHash,
      fromChain: String(fromChainId),
      toChain: String(toChainId),
    });
    const res = await fetch(`${LIFI_REST_URL}/status?${params}`, {
      signal: AbortSignal.timeout(10000),
      headers: LIFI_HEADERS,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Enhanced status tracking: tries MCP first, falls back to REST.
 */
export async function getRouteStatusWithFallback(
  txHash: string,
  fromChainId: number,
  toChainId?: number,
): Promise<LiFiRouteStatus | null> {
  const mcpResult = await getRouteStatus(txHash, fromChainId);
  if (mcpResult && mcpResult.status !== "NOT_FOUND") return mcpResult;
  if (toChainId) return getRouteStatusViaRest(txHash, fromChainId, toChainId);
  return mcpResult;
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
