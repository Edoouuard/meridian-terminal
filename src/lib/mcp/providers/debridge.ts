/**
 * mcp/providers/debridge.ts — deBridge MCP provider.
 *
 * Primary cross-chain router: swap + bridge in a single transaction.
 * deBridge DLN (deBridge Liquidity Network) enables any-to-any token
 * transfers across chains.
 *
 * deBridge MCP endpoint: https://agents.debridge.com/mcp (Streamable HTTP).
 *
 * All MCP calls (argument names/types, deBridge chain IDs, response
 * normalization, DLN REST fallback) live in ../debridge.ts — this module
 * only adapts them to the provider-level RouteQuote / RouteExecution shapes,
 * so there is a single implementation of the deBridge tool contract.
 */

import { listMcpTools } from "../client";
import {
  createDebridgeCrossChainTx,
  createDebridgeSameChainSwapTx,
  fetchDebridgeSupportedChains,
  searchDebridgeTokens,
  type DebridgeTxData,
} from "../debridge";
import type {
  McpProviderId,
  McpProviderStatus,
  RouteQuote,
  RouteRequest,
  RouteExecution,
  UnsignedTx,
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
  let healthy = false;
  try {
    const { tools } = await listMcpTools(DEBRIDGE_MCP_URL, SERVER_NAME, { transport: "http", timeoutMs: 8000 });
    healthy = tools.some((t) => t.name === "create_tx");
  } catch (err) {
    console.warn("[debridge] health check failed:", err);
  }
  lastHealthCheck = { id: PROVIDER_ID, name: "deBridge", healthy, latencyMs: Date.now() - start, lastChecked: Date.now() };
  return lastHealthCheck;
}

export function getStatus(): McpProviderStatus {
  return lastHealthCheck;
}

// ─── Supported chains / tokens ───────────────────────────────────────

export async function getSupportedChains(): Promise<number[]> {
  return (await fetchDebridgeSupportedChains()).map((c) => c.chainId);
}

export interface DeBridgeToken {
  address: string;
  symbol: string;
  decimals: number;
  name: string;
  chainId: number;
}

export async function searchTokens(query: string, chainId?: number): Promise<DeBridgeToken[]> {
  if (!chainId) return [];
  return searchDebridgeTokens(chainId, query);
}

// ─── Quotes ──────────────────────────────────────────────────────────

function toUnsigned(tx: DebridgeTxData): UnsignedTx {
  return { to: tx.to as Address, data: tx.data as `0x${string}`, value: tx.value ?? "0", chainId: tx.chainId };
}

function baseQuote(request: RouteRequest, toAmount: string, routeData: unknown, isCrossChain: boolean, etaSeconds?: number, feesUsd?: number): RouteQuote {
  return {
    provider: PROVIDER_ID,
    fromToken: { address: request.fromToken, symbol: "?", decimals: 18, chainId: request.fromChainId },
    toToken: { address: request.toToken, symbol: "?", decimals: 18, chainId: request.toChainId },
    fromAmount: request.fromAmount,
    toAmount,
    toAmountUsd: 0, // filled by the router from price feeds
    estimatedFeesUsd: feesUsd ?? 0,
    estimatedTimeSeconds: etaSeconds ?? (isCrossChain ? 120 : 30),
    routeData,
    steps: [{
      type: isCrossChain ? "bridge" : "swap",
      provider: isCrossChain ? "deBridge DLN" : "deBridge",
      fromToken: request.fromToken,
      toToken: request.toToken,
      fromChainId: request.fromChainId,
      toChainId: request.toChainId,
      estimatedTimeSeconds: etaSeconds,
    }],
    slippage: request.slippage ?? 0.005,
  };
}

/** Get a cross-chain swap/bridge quote + tx from deBridge DLN (create_tx returns both). */
export async function getQuote(request: RouteRequest): Promise<RouteQuote | null> {
  if (request.fromChainId === request.toChainId) return getSameChainSwapQuote(request);
  const order = await createDebridgeCrossChainTx({
    srcChainId: request.fromChainId,
    srcTokenAddress: request.fromToken,
    srcAmount: request.fromAmount,
    dstChainId: request.toChainId,
    dstTokenAddress: request.toToken,
    senderAddress: request.userAddress,
  });
  if (!order?.tx) return null;
  return baseQuote(request, order.estimatedDstAmount ?? "0", order, true, order.estimatedTimeSeconds, order.estimatedFeeUsd);
}

export async function getSameChainSwapQuote(request: RouteRequest): Promise<RouteQuote | null> {
  const swap = await createDebridgeSameChainSwapTx({
    chainId: request.fromChainId,
    tokenIn: request.fromToken,
    tokenOut: request.toToken,
    amountIn: request.fromAmount,
    senderAddress: request.userAddress,
    slippageBps: request.slippage !== undefined ? Math.round(request.slippage * 10000) : undefined,
  });
  if (!swap?.tx) return null;
  return baseQuote(request, swap.estimatedAmountOut ?? "0", swap, false);
}

// ─── Build transaction ───────────────────────────────────────────────

/**
 * Build the unsigned transaction(s) to execute a deBridge route. The quote
 * already carries the tx; a fresh one is requested only if it doesn't.
 */
export async function buildTransaction(
  request: RouteRequest,
  quoteData: { tx?: DebridgeTxData | null; approveTx?: DebridgeTxData | null } | null,
): Promise<RouteExecution | null> {
  let data = quoteData;
  if (!data?.tx) {
    const fresh = await getQuote(request);
    data = (fresh?.routeData as typeof quoteData) ?? null;
  }
  if (!data?.tx) return null;
  return {
    provider: PROVIDER_ID,
    transactions: [toUnsigned(data.tx)],
    approvals: data.approveTx ? [toUnsigned(data.approveTx)] : [],
  };
}

// ─── Order status (cross-chain tracking) ─────────────────────────────

export interface DeBridgeOrderStatus {
  orderId: string;
  /** Raw DLN status: None | Created | Fulfilled | SentUnlock | ClaimedUnlock | Cancelled … */
  status: string;
  /** True once funds are delivered on the destination chain. */
  delivered: boolean;
  srcTxHash?: string;
  dstTxHash?: string;
}

export async function getOrderStatus(orderId: string): Promise<DeBridgeOrderStatus | null> {
  // deBridge MCP has no status tool — use the DLN stats API (per deBridge's monitoring docs).
  try {
    const res = await fetch(`https://stats-api.dln.trade/api/Orders/${encodeURIComponent(orderId)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const status: string = data.status ?? data.state ?? "None";
    const hash = (v: unknown): string | undefined =>
      typeof v === "string" ? v : v && typeof v === "object" && "stringValue" in v ? String((v as { stringValue: unknown }).stringValue) : undefined;
    return {
      orderId,
      status,
      delivered: ["Fulfilled", "SentUnlock", "ClaimedUnlock"].includes(status),
      srcTxHash: hash(data.createdSrcEventMetadata?.transactionHash) ?? hash(data.creationTxHash),
      dstTxHash: hash(data.fulfilledDstEventMetadata?.transactionHash) ?? hash(data.fulfillTxHash),
    };
  } catch (err) {
    console.warn("[debridge] getOrderStatus failed:", err);
    return null;
  }
}
