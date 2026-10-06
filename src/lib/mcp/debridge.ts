/**
 * mcp/debridge.ts — deBridge MCP integration.
 *
 * Connects to deBridge's official agent MCP server (DLN — deBridge Liquidity
 * Network) for cross-chain and same-chain swap/bridge routing:
 * - Supported chains + token discovery
 * - Cross-chain order creation (unsigned tx data)
 * - Same-chain swap (unsigned tx data)
 *
 * Transport: Streamable HTTP — deBridge does not expose an SSE endpoint.
 * No authentication is required for the hosted endpoint.
 *
 * Non-custodial: every tool here returns unsigned transaction data (or
 * read-only data). Signing always happens client-side via wagmi/viem, same
 * as every other protocol module in this codebase.
 *
 * Field names for create_tx / transaction_same_chain_swap follow deBridge's
 * own public DLN REST API convention (dln.debridge.finance) — the MCP
 * tool's exact input schema isn't published in detail anywhere, so these
 * are deBridge's own well-documented field names. Every function here
 * fails closed (returns null/empty) on any mismatch or upstream error
 * rather than guessing — the router (mcp/router.ts) falls back to LI.FI
 * whenever this module does.
 */

import { callMcpTool, parseMcpToolResult } from "./client";

const DEBRIDGE_MCP_URL = process.env.DEBRIDGE_MCP_URL || "https://agents.debridge.com/mcp";
const SERVER_NAME = "debridge";
const HTTP_TRANSPORT = { transport: "http" as const };

// ─── Types ───────────────────────────────────────────────────────────

export interface DebridgeChain {
  chainId: number;
  name: string;
}

export interface DebridgeToken {
  chainId: number;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

/** Unsigned transaction data — the same shape every MCP/protocol adapter in this codebase returns. */
export interface DebridgeTxData {
  to: string;
  data: string;
  value?: string;
  chainId: number;
}

export interface DebridgeCrossChainOrderInput {
  srcChainId: number;
  srcTokenAddress: string;
  srcAmount: string;
  dstChainId: number;
  dstTokenAddress: string;
  senderAddress: string;
  /** Defaults to senderAddress when omitted. */
  recipientAddress?: string;
  slippageBps?: number;
}

export interface DebridgeCrossChainOrder {
  tx: DebridgeTxData | null;
  estimatedDstAmount?: string;
  estimatedFeeUsd?: number;
  estimatedTimeSeconds?: number;
}

export interface DebridgeSameChainSwapInput {
  chainId: number;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  senderAddress: string;
  slippageBps?: number;
}

// ─── Read operations ─────────────────────────────────────────────────

/** Chains deBridge currently supports. Returns [] on failure (fail closed, like every mcp/ module). */
export async function fetchDebridgeSupportedChains(): Promise<DebridgeChain[]> {
  try {
    const result = await callMcpTool(DEBRIDGE_MCP_URL, SERVER_NAME, "get_supported_chains", {}, HTTP_TRANSPORT);
    return parseMcpToolResult<DebridgeChain[]>(result) ?? [];
  } catch (err) {
    console.warn("[mcp/debridge] fetchDebridgeSupportedChains failed:", err);
    return [];
  }
}

/** Search deBridge's token list on a given chain by symbol/name/address substring. */
export async function searchDebridgeTokens(chainId: number, query: string): Promise<DebridgeToken[]> {
  try {
    const result = await callMcpTool(DEBRIDGE_MCP_URL, SERVER_NAME, "search_tokens", { chainId, query }, HTTP_TRANSPORT);
    return parseMcpToolResult<DebridgeToken[]>(result) ?? [];
  } catch (err) {
    console.warn("[mcp/debridge] searchDebridgeTokens failed:", err);
    return [];
  }
}

// ─── Unsigned transaction building ───────────────────────────────────

/**
 * Build an unsigned cross-chain DLN order transaction. Returns null on
 * failure — the router (mcp/router.ts) falls back to LI.FI when this does.
 */
export async function createDebridgeCrossChainTx(input: DebridgeCrossChainOrderInput): Promise<DebridgeCrossChainOrder | null> {
  try {
    const result = await callMcpTool(
      DEBRIDGE_MCP_URL,
      SERVER_NAME,
      "create_tx",
      {
        srcChainId: input.srcChainId,
        srcChainTokenIn: input.srcTokenAddress,
        srcChainTokenInAmount: input.srcAmount,
        dstChainId: input.dstChainId,
        dstChainTokenOut: input.dstTokenAddress,
        dstChainTokenOutRecipient: input.recipientAddress ?? input.senderAddress,
        senderAddress: input.senderAddress,
        srcChainOrderAuthorityAddress: input.senderAddress,
        dstChainOrderAuthorityAddress: input.recipientAddress ?? input.senderAddress,
        ...(input.slippageBps !== undefined ? { slippageBps: input.slippageBps } : {}),
      },
      HTTP_TRANSPORT,
    );
    return parseMcpToolResult<DebridgeCrossChainOrder>(result);
  } catch (err) {
    console.warn("[mcp/debridge] createDebridgeCrossChainTx failed:", err);
    return null;
  }
}

/** Build an unsigned same-chain swap transaction via deBridge's DEX aggregation. */
export async function createDebridgeSameChainSwapTx(input: DebridgeSameChainSwapInput): Promise<DebridgeTxData | null> {
  try {
    const result = await callMcpTool(
      DEBRIDGE_MCP_URL,
      SERVER_NAME,
      "transaction_same_chain_swap",
      {
        chainId: input.chainId,
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
        amountIn: input.amountIn,
        senderAddress: input.senderAddress,
        ...(input.slippageBps !== undefined ? { slippageBps: input.slippageBps } : {}),
      },
      HTTP_TRANSPORT,
    );
    return parseMcpToolResult<DebridgeTxData>(result);
  } catch (err) {
    console.warn("[mcp/debridge] createDebridgeSameChainSwapTx failed:", err);
    return null;
  }
}
