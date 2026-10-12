/**
 * mcp/providers/debridge.ts — deBridge MCP provider.
 *
 * Primary cross-chain router: swap + bridge in a single transaction.
 * deBridge DLN (Deswap Liquidity Network) enables any-to-any token
 * transfers across chains with MEV-protection and guaranteed rates.
 *
 * deBridge MCP endpoint: https://agents.debridge.com/mcp (Streamable HTTP).
 *
 * Available tools:
 *   - get_instructions
 *   - search_tokens(query, chainId?, name?, limit?)
 *   - get_supported_chains
 *   - create_tx(srcChainId, srcChainTokenIn, srcChainTokenInAmount, dstChainId,
 *               dstChainTokenOut, dstChainTokenOutRecipient, srcChainOrderAuthorityAddress,
 *               dstChainOrderAuthorityAddress, ...)
 *   - transaction_same_chain_swap(chainId, tokenIn, tokenInAmount, tokenOut,
 *               tokenOutRecipient, slippage?, senderAddress?, ...)
 */

import { callMcpTool } from "../client";
import type {
  McpProviderId,
  McpProviderStatus,
  RouteQuote,
  RouteRequest,
  RouteExecution,
  RouteStep,
} from "../types";
import type { Address } from "viem";

const DEBRIDGE_MCP_URL = process.env.DEBRIDGE_MCP_URL || "https://agents.debridge.com/mcp";
const PROVIDER_ID: McpProviderId = "debridge";
const SERVER_NAME = "debridge";

// ─── Health check ────────────────────────────────────────────────────

let lastHealthCheck: McpProviderStatus = {
  id: PROVIDER_ID,
  name: "deBridge",
  healthy: false,
  latencyMs: null,
  lastChecked: 0,
};

export async function checkHealth(): Promise<McpProviderStatus> {
  const start = Date.now();
  try {
    await callMcpTool(DEBRIDGE_MCP_URL, SERVER_NAME, "get_supported_chains", {}, 8000);
    lastHealthCheck = {
      id: PROVIDER_ID,
      name: "deBridge",
      healthy: true,
      latencyMs: Date.now() - start,
      lastChecked: Date.now(),
    };
  } catch {
    lastHealthCheck = {
      id: PROVIDER_ID,
      name: "deBridge",
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

// ─── Supported chains ────────────────────────────────────────────────

export async function getSupportedChains(): Promise<number[]> {
  try {
    const result = await callMcpTool(DEBRIDGE_MCP_URL, SERVER_NAME, "get_supported_chains", {});
    // The server lists chain ids as strings: [{ chainId: "42161", chainNames: [...] }].
    const parsed = parseResult<{ chainId: string | number }[]>(result);
    if (!parsed) return [];
    return parsed.map((c) => Number(c.chainId)).filter((id) => Number.isFinite(id));
  } catch (err) {
    console.warn("[debridge] getSupportedChains failed:", err);
    return [];
  }
}

// ─── Token search ────────────────────────────────────────────────────

export interface DeBridgeToken {
  address: string;
  symbol: string;
  decimals: number;
  name: string;
  chainId: number;
}

export async function searchTokens(query: string, chainId?: number): Promise<DeBridgeToken[]> {
  try {
    const args: Record<string, unknown> = { query };
    if (chainId) args.chainId = String(chainId);
    const result = await callMcpTool(DEBRIDGE_MCP_URL, SERVER_NAME, "search_tokens", args);
    const parsed = parseResult<{ results?: { address: string; symbol: string; names?: string[]; decimals: number; chainId: string | number }[] }>(result);
    return (parsed?.results ?? []).map((t) => ({
      address: t.address,
      symbol: t.symbol,
      decimals: t.decimals,
      name: t.names?.[0] ?? t.symbol,
      chainId: Number(t.chainId),
    }));
  } catch (err) {
    console.warn("[debridge] searchTokens failed:", err);
    return [];
  }
}

// ─── Quote (cross-chain) ────────────────────────────────────────────

interface DeBridgeCreateTxResult {
  tx?: { to: string; data: string; value: string };
  estimation?: {
    srcChainTokenIn?: { amount: string; symbol: string; decimals: number; name: string; address: string };
    dstChainTokenOut?: { amount: string; symbol: string; decimals: number; name: string; address: string; recommendedAmount?: string };
  };
  /** Same-chain swap result shape (transaction_same_chain_swap). */
  tokenIn?: { amount: string; symbol: string; decimals: number; name: string; address: string };
  tokenOut?: { amount: string; symbol: string; decimals: number; name: string; address: string; approximateUsdValue?: number };
  order?: { approximateFulfillmentDelay?: number };
  orderId?: string;
  fixFee?: string;
  protocolFeeApproximateUsdValue?: number;
}

/**
 * Get a cross-chain swap/bridge quote + tx from deBridge DLN.
 * The new `create_tx` tool returns both quote and unsigned tx in one call.
 */
export async function getQuote(request: RouteRequest): Promise<RouteQuote | null> {
  try {
    const result = await callMcpTool(DEBRIDGE_MCP_URL, SERVER_NAME, "create_tx", {
      srcChainId: String(request.fromChainId),
      srcChainTokenIn: request.fromToken,
      srcChainTokenInAmount: request.fromAmount,
      dstChainId: String(request.toChainId),
      dstChainTokenOut: request.toToken,
      dstChainTokenOutRecipient: request.userAddress,
      srcChainOrderAuthorityAddress: request.userAddress,
      dstChainOrderAuthorityAddress: request.userAddress,
    });

    const raw = parseResult<DeBridgeCreateTxResult>(result);
    if (!raw) return null;

    const est = raw.estimation;
    // Protocol fee only — the fixed native fee (fixFee) is part of tx.value.
    const totalFeesUsd = raw.protocolFeeApproximateUsdValue ?? 0;
    const etaSeconds = raw.order?.approximateFulfillmentDelay;

    const isCrossChain = request.fromChainId !== request.toChainId;

    const steps: RouteStep[] = [{
      type: isCrossChain ? "bridge" : "swap",
      provider: "deBridge DLN",
      fromToken: est?.srcChainTokenIn?.symbol ?? "?",
      toToken: est?.dstChainTokenOut?.symbol ?? "?",
      fromChainId: request.fromChainId,
      toChainId: request.toChainId,
      estimatedTimeSeconds: etaSeconds,
    }];

    return {
      provider: PROVIDER_ID,
      fromToken: {
        address: request.fromToken,
        symbol: est?.srcChainTokenIn?.symbol ?? "?",
        decimals: est?.srcChainTokenIn?.decimals ?? 18,
        chainId: request.fromChainId,
        name: est?.srcChainTokenIn?.name,
      },
      toToken: {
        address: request.toToken,
        symbol: est?.dstChainTokenOut?.symbol ?? "?",
        decimals: est?.dstChainTokenOut?.decimals ?? 18,
        chainId: request.toChainId,
        name: est?.dstChainTokenOut?.name,
      },
      fromAmount: request.fromAmount,
      toAmount: est?.dstChainTokenOut?.amount ?? "0",
      toAmountUsd: 0, // filled by the router from price feeds
      estimatedFeesUsd: totalFeesUsd,
      estimatedTimeSeconds: etaSeconds ?? (isCrossChain ? 120 : 30),
      routeData: raw,
      steps,
      slippage: request.slippage ?? 0.005,
    };
  } catch (err) {
    console.warn("[debridge] getQuote failed:", err);
    return null;
  }
}

// ─── Same-chain swap ────────────────────────────────────────────────

export async function getSameChainSwapQuote(request: RouteRequest): Promise<RouteQuote | null> {
  try {
    const result = await callMcpTool(DEBRIDGE_MCP_URL, SERVER_NAME, "transaction_same_chain_swap", {
      chainId: String(request.fromChainId),
      tokenIn: request.fromToken,
      tokenInAmount: request.fromAmount,
      tokenOut: request.toToken,
      tokenOutRecipient: request.userAddress,
      senderAddress: request.userAddress,
      slippage: ((request.slippage ?? 0.005) * 100).toString(), // percent
    });

    const raw = parseResult<DeBridgeCreateTxResult>(result);
    if (!raw) return null;

    const tokenIn = raw.tokenIn;
    const tokenOut = raw.tokenOut;

    return {
      provider: PROVIDER_ID,
      fromToken: {
        address: request.fromToken,
        symbol: tokenIn?.symbol ?? "?",
        decimals: tokenIn?.decimals ?? 18,
        chainId: request.fromChainId,
      },
      toToken: {
        address: request.toToken,
        symbol: tokenOut?.symbol ?? "?",
        decimals: tokenOut?.decimals ?? 18,
        chainId: request.toChainId,
      },
      fromAmount: request.fromAmount,
      toAmount: tokenOut?.amount ?? "0",
      toAmountUsd: tokenOut?.approximateUsdValue ?? 0,
      estimatedFeesUsd: raw.protocolFeeApproximateUsdValue ?? 0,
      estimatedTimeSeconds: 30,
      routeData: raw,
      steps: [{
        type: "swap",
        provider: "deBridge",
        fromToken: tokenIn?.symbol ?? "?",
        toToken: tokenOut?.symbol ?? "?",
        fromChainId: request.fromChainId,
        toChainId: request.toChainId,
      }],
      slippage: request.slippage ?? 0.005,
    };
  } catch (err) {
    console.warn("[debridge] getSameChainSwapQuote failed:", err);
    return null;
  }
}

// ─── Build transaction ───────────────────────────────────────────────

/**
 * Build the unsigned transaction(s) to execute a deBridge route.
 * With the new API, `create_tx` already returns the tx — we just extract it.
 */
export async function buildTransaction(
  request: RouteRequest,
  quoteData: DeBridgeCreateTxResult,
): Promise<RouteExecution | null> {
  try {
    // create_tx already returns the tx in the quote
    if (quoteData.tx) {
      return {
        provider: PROVIDER_ID,
        transactions: [{
          to: quoteData.tx.to as Address,
          data: quoteData.tx.data as `0x${string}`,
          value: quoteData.tx.value ?? "0",
          chainId: request.fromChainId,
        }],
        approvals: [],
      };
    }

    // If no tx in quote, re-call create_tx
    const result = await callMcpTool(DEBRIDGE_MCP_URL, SERVER_NAME, "create_tx", {
      srcChainId: String(request.fromChainId),
      srcChainTokenIn: request.fromToken,
      srcChainTokenInAmount: request.fromAmount,
      dstChainId: String(request.toChainId),
      dstChainTokenOut: request.toToken,
      dstChainTokenOutRecipient: request.userAddress,
      srcChainOrderAuthorityAddress: request.userAddress,
      dstChainOrderAuthorityAddress: request.userAddress,
    });

    const raw = parseResult<DeBridgeCreateTxResult>(result);
    if (!raw?.tx) return null;

    return {
      provider: PROVIDER_ID,
      transactions: [{
        to: raw.tx.to as Address,
        data: raw.tx.data as `0x${string}`,
        value: raw.tx.value ?? "0",
        chainId: request.fromChainId,
      }],
      approvals: [],
    };
  } catch (err) {
    console.warn("[debridge] buildTransaction failed:", err);
    return null;
  }
}

// ─── Order status (cross-chain tracking) ─────────────────────────────

export interface DeBridgeOrderStatus {
  orderId: string;
  status: "created" | "fulfilled" | "claimable" | "claimed" | "cancelled";
  srcTxHash?: string;
  dstTxHash?: string;
}

export async function getOrderStatus(orderId: string): Promise<DeBridgeOrderStatus | null> {
  // deBridge MCP doesn't have a status tool — use REST API fallback
  try {
    const res = await fetch(
      `https://stats-api.dln.trade/api/Orders/${orderId}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    const data = await res.json();
    return {
      orderId,
      status: mapDlnOrderState(data.state),
      srcTxHash: data.createdSrcEventMetadata?.transactionHash?.stringValue,
      dstTxHash: data.fulfilledDstEventMetadata?.transactionHash?.stringValue,
    };
  } catch (err) {
    console.warn("[debridge] getOrderStatus failed:", err);
    return null;
  }
}

/**
 * DLN stats API states (PascalCase: "Created", "Fulfilled", "SentUnlock",
 * "ClaimedUnlock", "OrderCancelled", "SentOrderCancel", "ClaimedOrderCancel")
 * → the lifecycle Meridian tracks. Once fulfilled, the user has their funds on
 * the destination chain; the unlock states are the taker settling afterwards.
 */
export function mapDlnOrderState(state: unknown): DeBridgeOrderStatus["status"] {
  switch (String(state ?? "").toLowerCase()) {
    case "fulfilled":
    case "sentunlock":
      return "fulfilled";
    case "claimedunlock":
      return "claimed";
    case "ordercancelled":
    case "sentordercancel":
    case "claimedordercancel":
      return "cancelled";
    default:
      return "created";
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function parseResult<T>(content: unknown): T | null {
  if (!content) return null;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && "type" in block) {
        if (block.type === "text" && "text" in block) {
          try { return JSON.parse(block.text as string) as T; } catch {
            // If it's not JSON, return the text as-is for string results
            return null;
          }
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
