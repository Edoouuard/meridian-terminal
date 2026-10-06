/**
 * mcp/providers/lifi.ts — LI.FI MCP provider.
 *
 * Second cross-chain router / fallback / comparison layer.
 * LI.FI aggregates 30+ bridges and DEX aggregators, providing
 * competitive routing as a fallback when deBridge is down or
 * when comparing quotes for best execution.
 *
 * LI.FI MCP endpoint: https://mcp.li.quest/mcp (Streamable HTTP).
 *
 * Available tools (25):
 *   - health-check, get-chains, get-tokens, get-token, get-token-balance,
 *     get-token-balances, get-native-token-balance, get-allowance,
 *     get-quote, get-quote-with-calls, get-routes, get-status,
 *     get-step-transaction, get-connections, get-tools,
 *     get-chain-by-id, get-chain-by-name, get-gas-prices, get-gas-suggestion,
 *     get-earn-chains, get-earn-protocols, get-earn-vaults, get-earn-vault,
 *     get-earn-portfolio, test-api-key
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

const LIFI_MCP_URL = process.env.LIFI_MCP_URL || "https://mcp.li.quest/mcp";
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
    await callMcpTool(LIFI_MCP_URL, SERVER_NAME, "health-check", {}, 8000);
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
    const result = await callMcpTool(LIFI_MCP_URL, SERVER_NAME, "get-quote", {
      fromChain: String(request.fromChainId),
      toChain: String(request.toChainId),
      fromToken: request.fromToken,
      toToken: request.toToken,
      fromAmount: request.fromAmount,
      fromAddress: request.userAddress,
      slippage: String(request.slippage ?? 0.005),
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
 * LI.FI typically returns the tx in the quote itself.
 */
export async function buildTransaction(
  request: RouteRequest,
  quoteData: LiFiQuoteRaw,
): Promise<RouteExecution | null> {
  try {
    // LI.FI embeds tx in the quote — use it if available
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

    // If no embedded tx, use get-step-transaction
    if (quoteData.includedSteps?.length > 0) {
      const result = await callMcpTool(LIFI_MCP_URL, SERVER_NAME, "get-step-transaction", {
        step: quoteData.includedSteps[0],
      });
      const txData = parseResult<{
        transactionRequest: { to: string; data: string; value: string; gasLimit: string; chainId: number };
      }>(result);
      if (txData?.transactionRequest) {
        const tx = txData.transactionRequest;
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
    }

    // Last resort: re-quote via REST
    return buildTransactionViaRest(request, quoteData);
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

export async function getRouteStatus(txHash: string, fromChainId: number, toChainId?: number): Promise<LiFiRouteStatus | null> {
  try {
    const args: Record<string, unknown> = {
      txHash,
      fromChain: String(fromChainId),
    };
    if (toChainId) args.toChain = String(toChainId);
    const result = await callMcpTool(LIFI_MCP_URL, SERVER_NAME, "get-status", args);
    return parseResult<LiFiRouteStatus>(result);
  } catch (err) {
    console.warn("[lifi] getRouteStatus failed:", err);
    return null;
  }
}

// ─── Supported chains ────────────────────────────────────────────────

export async function getSupportedChains(): Promise<{ id: number; name: string }[]> {
  try {
    const result = await callMcpTool(LIFI_MCP_URL, SERVER_NAME, "get-chains", {});
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

export async function getTokens(chainId: number): Promise<LiFiToken[]> {
  try {
    const result = await callMcpTool(LIFI_MCP_URL, SERVER_NAME, "get-tokens", {
      chains: [String(chainId)],
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

export async function findToken(symbol: string, chainId: number): Promise<LiFiToken | null> {
  // Try MCP get-token first (more targeted)
  try {
    const result = await callMcpTool(LIFI_MCP_URL, SERVER_NAME, "get-token", {
      chain: String(chainId),
      token: symbol,
    });
    const token = parseResult<LiFiToken>(result);
    if (token) return token;
  } catch { /* fallback */ }

  const tokens = await getTokens(chainId);
  const needle = symbol.trim().toUpperCase();
  return tokens.find((t) => t.symbol.toUpperCase() === needle) ?? null;
}

// ─── Earn / Yield (new LI.FI tools) ────────────────────────────────

export interface LiFiEarnVault {
  address: string;
  chainId: number;
  protocol: string;
  asset: string;
  apy: number;
  tvl: number;
  tags: string[];
}

export async function getEarnVaults(opts?: {
  asset?: string;
  chainId?: number;
  protocol?: string;
  limit?: number;
}): Promise<LiFiEarnVault[]> {
  try {
    const args: Record<string, unknown> = {};
    if (opts?.asset) args.asset = opts.asset;
    if (opts?.chainId) args.chainId = String(opts.chainId);
    if (opts?.protocol) args.protocol = opts.protocol;
    if (opts?.limit) args.limit = opts.limit;
    args.sortBy = "apy";
    args.sortDirection = "desc";
    const result = await callMcpTool(LIFI_MCP_URL, SERVER_NAME, "get-earn-vaults", args);
    return parseResult<LiFiEarnVault[]>(result) ?? [];
  } catch (err) {
    console.warn("[lifi] getEarnVaults failed:", err);
    return [];
  }
}

export async function getEarnPortfolio(walletAddress: string): Promise<unknown> {
  try {
    const result = await callMcpTool(LIFI_MCP_URL, SERVER_NAME, "get-earn-portfolio", {
      walletAddress,
    });
    return parseResult<unknown>(result);
  } catch (err) {
    console.warn("[lifi] getEarnPortfolio failed:", err);
    return null;
  }
}

// ─── Token balances (replaces part of Haiku) ────────────────────────

export async function getTokenBalances(walletAddress: string, chainId: number, tokenAddresses: string[]): Promise<unknown> {
  try {
    const result = await callMcpTool(LIFI_MCP_URL, SERVER_NAME, "get-token-balances", {
      walletAddress,
      chain: String(chainId),
      tokenAddresses,
    });
    return parseResult<unknown>(result);
  } catch (err) {
    console.warn("[lifi] getTokenBalances failed:", err);
    return null;
  }
}

export async function getNativeBalance(address: string, chainId: number): Promise<string | null> {
  try {
    const result = await callMcpTool(LIFI_MCP_URL, SERVER_NAME, "get-native-token-balance", {
      address,
      chain: String(chainId),
    });
    return parseResult<string>(result);
  } catch {
    return null;
  }
}

// ─── Same-chain swap alias ──────────────────────────────────────────

export { getQuote as getSwapQuote };

// ─── REST API fallback ───────────────────────────────────────────────

const LIFI_REST_URL = process.env.LIFI_REST_URL || "https://li.quest/v1";
const LIFI_API_KEY = process.env.LIFI_API_KEY || "";
const LIFI_HEADERS: Record<string, string> = {
  ...(LIFI_API_KEY ? { "x-lifi-api-key": LIFI_API_KEY } : {}),
};

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

export async function getQuoteWithFallback(request: RouteRequest): Promise<RouteQuote | null> {
  const mcpQuote = await getQuote(request);
  if (mcpQuote) return mcpQuote;
  return getQuoteViaRest(request);
}

export async function buildTransactionViaRest(
  request: RouteRequest,
  quoteData: LiFiQuoteRaw,
): Promise<RouteExecution | null> {
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

export async function buildTransactionWithFallback(
  request: RouteRequest,
  quoteData: LiFiQuoteRaw,
): Promise<RouteExecution | null> {
  const mcpResult = await buildTransaction(request, quoteData);
  if (mcpResult) return mcpResult;
  return buildTransactionViaRest(request, quoteData);
}

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

export async function getRouteStatusWithFallback(
  txHash: string,
  fromChainId: number,
  toChainId?: number,
): Promise<LiFiRouteStatus | null> {
  const mcpResult = await getRouteStatus(txHash, fromChainId, toChainId);
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
