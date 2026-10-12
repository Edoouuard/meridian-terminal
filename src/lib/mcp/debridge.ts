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
 * Input schemas (verified against the live server's tools/list): chain ids
 * are STRINGS ("42161"), amounts are base-unit strings, and the server
 * rejects arguments outside its schema. Every function here fails closed
 * (returns null/empty) on any upstream error — the router (mcp/router.ts)
 * falls back to LI.FI whenever this module does.
 */

import { callMcpTool, parseMcpToolResult } from "./client";

const DEBRIDGE_MCP_URL = process.env.DEBRIDGE_MCP_URL || "https://agents.debridge.com/mcp";
const SERVER_NAME = "debridge";
/**
 * deBridge's hosted server throttles bursts: past a few concurrent requests
 * it stops answering for ~30s, even single calls. Keep at most 2 calls in
 * flight per server instance, and give up after 10s so a slow deBridge never
 * holds back a LI.FI quote that is already in hand (the router waits for both).
 */
const HTTP_TRANSPORT = { transport: "http" as const, timeoutMs: 10_000 };
const MAX_IN_FLIGHT = 2;
let inFlight = 0;
const waiting: (() => void)[] = [];

async function callDebridge(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => waiting.push(resolve));
  inFlight++;
  try {
    return await callMcpTool(DEBRIDGE_MCP_URL, SERVER_NAME, toolName, args, HTTP_TRANSPORT);
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

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
}

export interface DebridgeCrossChainOrder {
  tx: DebridgeTxData | null;
  orderId?: string;
  /** Destination-token amount the order is expected to deliver, in base units. */
  estimatedDstAmount?: string;
  /** USD value of estimatedDstAmount, as estimated by deBridge. */
  estimatedDstAmountUsd?: number;
  estimatedTimeSeconds?: number;
}

export interface DebridgeSameChainSwapInput {
  chainId: number;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  senderAddress: string;
  /** Defaults to senderAddress when omitted. */
  recipientAddress?: string;
  slippageBps?: number;
}

export interface DebridgeSameChainSwap {
  tx: DebridgeTxData | null;
  /** Expected output, in base units. */
  estimatedAmountOut?: string;
  /** USD value of estimatedAmountOut, as estimated by deBridge. */
  estimatedAmountOutUsd?: number;
  /** Guaranteed minimum output after slippage, in base units. */
  minAmountOut?: string;
}

// ─── Raw response shapes ─────────────────────────────────────────────

interface RawTx { to: string; data: string; value?: string }

interface RawCreateTx {
  tx?: RawTx;
  orderId?: string;
  estimation?: {
    dstChainTokenOut?: {
      amount?: string;
      recommendedAmount?: string;
      approximateUsdValue?: number;
      recommendedApproximateUsdValue?: number;
    };
  };
  order?: { approximateFulfillmentDelay?: number };
}

interface RawSameChainSwap {
  tx?: RawTx;
  tokenOut?: { amount?: string; minAmount?: string; approximateUsdValue?: number };
}

function normalizeTx(raw: RawTx | undefined, chainId: number): DebridgeTxData | null {
  if (!raw?.to || !raw.data) return null;
  return { to: raw.to, data: raw.data, value: raw.value ?? "0", chainId };
}

// ─── Read operations ─────────────────────────────────────────────────

/** Chains deBridge currently supports. Returns [] on failure (fail closed, like every mcp/ module). */
export async function fetchDebridgeSupportedChains(): Promise<DebridgeChain[]> {
  try {
    const result = await callDebridge("get_supported_chains", {});
    const raw = parseMcpToolResult<{ chainId: string | number; chainNames?: string[] }[]>(result) ?? [];
    return raw
      .map((c) => ({ chainId: Number(c.chainId), name: c.chainNames?.[0] ?? String(c.chainId) }))
      .filter((c) => Number.isFinite(c.chainId));
  } catch (err) {
    console.warn("[mcp/debridge] fetchDebridgeSupportedChains failed:", err);
    return [];
  }
}

/** Search deBridge's token list on a given chain by symbol/name/address substring. */
export async function searchDebridgeTokens(chainId: number, query: string): Promise<DebridgeToken[]> {
  try {
    const result = await callDebridge("search_tokens", { chainId: String(chainId), query });
    const raw = parseMcpToolResult<{ results?: { address: string; symbol: string; names?: string[]; decimals: number; chainId: string | number }[] }>(result);
    return (raw?.results ?? []).map((t) => ({
      chainId: Number(t.chainId),
      address: t.address,
      symbol: t.symbol,
      name: t.names?.[0] ?? t.symbol,
      decimals: t.decimals,
    }));
  } catch (err) {
    console.warn("[mcp/debridge] searchDebridgeTokens failed:", err);
    return [];
  }
}

// ─── Unsigned transaction building ───────────────────────────────────

/**
 * Build an unsigned cross-chain DLN order transaction. Returns null on
 * failure. The returned tx's `value` includes deBridge's fixed protocol fee
 * (paid in the source chain's native token) — never strip it.
 */
export async function createDebridgeCrossChainTx(input: DebridgeCrossChainOrderInput): Promise<DebridgeCrossChainOrder | null> {
  try {
    const recipient = input.recipientAddress ?? input.senderAddress;
    const result = await callDebridge(
      "create_tx",
      {
        srcChainId: String(input.srcChainId),
        srcChainTokenIn: input.srcTokenAddress,
        srcChainTokenInAmount: input.srcAmount,
        dstChainId: String(input.dstChainId),
        dstChainTokenOut: input.dstTokenAddress,
        dstChainTokenOutRecipient: recipient,
        // The sender can cancel/patch the order on the source chain; the
        // recipient controls it on the destination chain.
        srcChainOrderAuthorityAddress: input.senderAddress,
        dstChainOrderAuthorityAddress: recipient,
      },
    );
    const raw = parseMcpToolResult<RawCreateTx>(result);
    if (!raw) return null;
    const out = raw.estimation?.dstChainTokenOut;
    return {
      tx: normalizeTx(raw.tx, input.srcChainId),
      orderId: raw.orderId,
      estimatedDstAmount: out?.recommendedAmount ?? out?.amount,
      estimatedDstAmountUsd: out?.recommendedApproximateUsdValue ?? out?.approximateUsdValue,
      estimatedTimeSeconds: raw.order?.approximateFulfillmentDelay,
    };
  } catch (err) {
    console.warn("[mcp/debridge] createDebridgeCrossChainTx failed:", err);
    return null;
  }
}

/** Build an unsigned same-chain swap transaction via deBridge's DEX aggregation. */
export async function createDebridgeSameChainSwapTx(input: DebridgeSameChainSwapInput): Promise<DebridgeSameChainSwap | null> {
  try {
    const result = await callDebridge(
      "transaction_same_chain_swap",
      {
        chainId: String(input.chainId),
        tokenIn: input.tokenIn,
        tokenInAmount: input.amountIn,
        tokenOut: input.tokenOut,
        tokenOutRecipient: input.recipientAddress ?? input.senderAddress,
        senderAddress: input.senderAddress,
        // deBridge takes slippage in percent ("0.5" = 0.5%); "auto" lets it pick.
        slippage: input.slippageBps !== undefined ? String(input.slippageBps / 100) : "auto",
      },
    );
    const raw = parseMcpToolResult<RawSameChainSwap>(result);
    if (!raw) return null;
    return {
      tx: normalizeTx(raw.tx, input.chainId),
      estimatedAmountOut: raw.tokenOut?.amount,
      estimatedAmountOutUsd: raw.tokenOut?.approximateUsdValue,
      minAmountOut: raw.tokenOut?.minAmount,
    };
  } catch (err) {
    console.warn("[mcp/debridge] createDebridgeSameChainSwapTx failed:", err);
    return null;
  }
}
