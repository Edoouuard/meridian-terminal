/**
 * mcp/providers/debridge.ts — deBridge MCP provider.
 *
 * Primary cross-chain router: swap + bridge in a single transaction.
 * deBridge DLN (Deswap Liquidity Network) enables any-to-any token
 * transfers across chains with MEV-protection and guaranteed rates.
 *
 * deBridge MCP endpoint: https://mcp.debridge.finance/sse (or env override).
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

const DEBRIDGE_MCP_URL = process.env.DEBRIDGE_MCP_URL || "https://mcp.debridge.finance/sse";
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
    await callMcpTool(DEBRIDGE_MCP_URL, SERVER_NAME, "ping", {}, 5000);
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
    return parseResult<number[]>(result) ?? [];
  } catch (err) {
    console.warn("[debridge] getSupportedChains failed:", err);
    return [];
  }
}

// ─── Quote ───────────────────────────────────────────────────────────

interface DeBridgeQuoteRaw {
  estimation: {
    srcChainTokenIn: { amount: string; tokenAddress: string; decimals: number; symbol: string; name: string };
    srcChainTokenOut?: { amount: string };
    dstChainTokenOut: { amount: string; tokenAddress: string; decimals: number; symbol: string; name: string; recommendedAmount: string };
    costsDetails: { feesUsd: number; estimatedGasUsd: number }[];
  };
  tx?: { to: string; data: string; value: string };
  orderId?: string;
  estimatedTimeSeconds?: number;
}

/**
 * Get a cross-chain swap/bridge quote from deBridge DLN.
 * Returns a normalized RouteQuote or null on failure.
 */
export async function getQuote(request: RouteRequest): Promise<RouteQuote | null> {
  try {
    const result = await callMcpTool(DEBRIDGE_MCP_URL, SERVER_NAME, "get_quote", {
      srcChainId: request.fromChainId,
      dstChainId: request.toChainId,
      srcTokenAddress: request.fromToken,
      dstTokenAddress: request.toToken,
      srcAmount: request.fromAmount,
      senderAddress: request.userAddress,
      slippage: (request.slippage ?? 0.005) * 10000, // deBridge uses bps
    });

    const raw = parseResult<DeBridgeQuoteRaw>(result);
    if (!raw?.estimation) return null;

    const est = raw.estimation;
    const totalFeesUsd = est.costsDetails?.reduce(
      (sum, c) => sum + (c.feesUsd ?? 0) + (c.estimatedGasUsd ?? 0),
      0,
    ) ?? 0;

    const isCrossChain = request.fromChainId !== request.toChainId;

    const steps: RouteStep[] = [];
    if (isCrossChain) {
      steps.push({
        type: "bridge",
        provider: "deBridge DLN",
        fromToken: est.srcChainTokenIn.symbol,
        toToken: est.dstChainTokenOut.symbol,
        fromChainId: request.fromChainId,
        toChainId: request.toChainId,
        estimatedTimeSeconds: raw.estimatedTimeSeconds,
      });
    } else {
      steps.push({
        type: "swap",
        provider: "deBridge",
        fromToken: est.srcChainTokenIn.symbol,
        toToken: est.dstChainTokenOut.symbol,
        fromChainId: request.fromChainId,
        toChainId: request.toChainId,
      });
    }

    return {
      provider: PROVIDER_ID,
      fromToken: {
        address: request.fromToken,
        symbol: est.srcChainTokenIn.symbol,
        decimals: est.srcChainTokenIn.decimals,
        chainId: request.fromChainId,
        name: est.srcChainTokenIn.name,
      },
      toToken: {
        address: request.toToken,
        symbol: est.dstChainTokenOut.symbol,
        decimals: est.dstChainTokenOut.decimals,
        chainId: request.toChainId,
        name: est.dstChainTokenOut.name,
      },
      fromAmount: request.fromAmount,
      toAmount: est.dstChainTokenOut.amount,
      toAmountUsd: 0, // filled by the router from price feeds
      estimatedFeesUsd: totalFeesUsd,
      estimatedTimeSeconds: raw.estimatedTimeSeconds ?? (isCrossChain ? 120 : 30),
      routeData: raw,
      steps,
      slippage: request.slippage ?? 0.005,
    };
  } catch (err) {
    console.warn("[debridge] getQuote failed:", err);
    return null;
  }
}

// ─── Build transaction ───────────────────────────────────────────────

/**
 * Build the unsigned transaction(s) to execute a deBridge route.
 * The quote must have been obtained from `getQuote` first.
 */
export async function buildTransaction(
  request: RouteRequest,
  quoteData: DeBridgeQuoteRaw,
): Promise<RouteExecution | null> {
  try {
    const result = await callMcpTool(DEBRIDGE_MCP_URL, SERVER_NAME, "build_tx", {
      srcChainId: request.fromChainId,
      dstChainId: request.toChainId,
      srcTokenAddress: request.fromToken,
      dstTokenAddress: request.toToken,
      srcAmount: request.fromAmount,
      senderAddress: request.userAddress,
      slippage: (request.slippage ?? 0.005) * 10000,
      orderId: quoteData.orderId,
    });

    const txData = parseResult<{ tx: { to: string; data: string; value: string }; approveTo?: string; approveData?: string }>(result);
    if (!txData?.tx) return null;

    const transactions: UnsignedTx[] = [
      {
        to: txData.tx.to as Address,
        data: txData.tx.data as `0x${string}`,
        value: txData.tx.value ?? "0",
        chainId: request.fromChainId,
      },
    ];

    const approvals: UnsignedTx[] = [];
    if (txData.approveTo && txData.approveData) {
      approvals.push({
        to: request.fromToken,
        data: txData.approveData as `0x${string}`,
        value: "0",
        chainId: request.fromChainId,
      });
    }

    return { provider: PROVIDER_ID, transactions, approvals };
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
  try {
    const result = await callMcpTool(DEBRIDGE_MCP_URL, SERVER_NAME, "get_order_status", {
      orderId,
    });
    return parseResult<DeBridgeOrderStatus>(result);
  } catch (err) {
    console.warn("[debridge] getOrderStatus failed:", err);
    return null;
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
