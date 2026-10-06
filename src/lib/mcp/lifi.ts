/**
 * mcp/lifi.ts — LI.FI MCP integration.
 *
 * Connects to LI.FI's official MCP server for cross-chain and same-chain
 * swap routing across 58+ chains, 27+ bridges and 31+ DEXes. In Meridian's
 * routing layer this is the second router: a fallback and cross-check
 * against deBridge, and the primary route for anything deBridge doesn't
 * support (see mcp/router.ts).
 *
 * Transport: Streamable HTTP. An API key is optional — it raises the
 * public rate limit from 200 req/2h to 200 req/min. Set LIFI_API_KEY to
 * use one; omit it and the integration still works, just rate-limited.
 *
 * Non-custodial: every tool is read-only and returns an unsigned
 * `transactionRequest`. Signing always happens client-side via wagmi/viem.
 */

import { callMcpTool, parseMcpToolResult } from "./client";

const LIFI_MCP_URL = process.env.LIFI_MCP_URL || "https://mcp.li.quest/mcp";
const SERVER_NAME = "lifi";

function authHeaders(): Record<string, string> | undefined {
  const key = process.env.LIFI_API_KEY;
  return key ? { "x-lifi-api-key": key } : undefined;
}

function callLifiTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  return callMcpTool(LIFI_MCP_URL, SERVER_NAME, toolName, args, { transport: "http", headers: authHeaders() });
}

// ─── Types ───────────────────────────────────────────────────────────

export interface LifiChain {
  id: number;
  key: string;
  name: string;
}

export interface LifiToken {
  address: string;
  symbol: string;
  decimals: number;
  chainId: number;
  priceUSD?: string;
}

/** Unsigned transaction request — the same shape every MCP/protocol adapter in this codebase returns. */
export interface LifiTxRequest {
  to: string;
  data: string;
  value?: string;
  chainId: number;
  gasLimit?: string;
}

export interface LifiQuoteInput {
  fromChain: number | string;
  toChain: number | string;
  fromToken: string;
  toToken: string;
  fromAddress: string;
  fromAmount: string;
  toAddress?: string;
  /** 0..1 (e.g. 0.005 for 0.5%). */
  slippage?: number;
}

export interface LifiQuote {
  transactionRequest: LifiTxRequest | null;
  estimate?: {
    toAmount: string;
    executionDuration: number;
  };
  tool?: string;
}

// ─── Read operations ─────────────────────────────────────────────────

/** All chains LI.FI currently routes across. Returns [] on failure. */
export async function fetchLifiChains(): Promise<LifiChain[]> {
  try {
    const result = await callLifiTool("get-chains", {});
    return parseMcpToolResult<LifiChain[]>(result) ?? [];
  } catch (err) {
    console.warn("[mcp/lifi] fetchLifiChains failed:", err);
    return [];
  }
}

/** Token metadata (address/decimals/price) for a symbol on a chain. Returns null on failure. */
export async function fetchLifiToken(chain: string | number, token: string): Promise<LifiToken | null> {
  try {
    const result = await callLifiTool("get-token", { chain, token });
    return parseMcpToolResult<LifiToken>(result);
  } catch (err) {
    console.warn("[mcp/lifi] fetchLifiToken failed:", err);
    return null;
  }
}

/** Current cross-chain transfer status for a bridge tx hash. Returns null on failure. */
export async function getLifiStatus(
  txHash: string,
  opts?: { bridge?: string; fromChain?: number | string; toChain?: number | string },
): Promise<unknown | null> {
  try {
    const result = await callLifiTool("get-status", { txHash, ...opts });
    return parseMcpToolResult<unknown>(result);
  } catch (err) {
    console.warn("[mcp/lifi] getLifiStatus failed:", err);
    return null;
  }
}

/** Current ERC-20 allowance for a (owner, spender) pair, read live by the LI.FI server. Returns null on failure. */
export async function getLifiAllowance(input: {
  chain: string | number;
  tokenAddress: string;
  ownerAddress: string;
  spenderAddress: string;
}): Promise<string | null> {
  try {
    const result = await callLifiTool("get-allowance", input);
    const parsed = parseMcpToolResult<{ allowance?: string } | string>(result);
    if (typeof parsed === "string") return parsed;
    return parsed?.allowance ?? null;
  } catch (err) {
    console.warn("[mcp/lifi] getLifiAllowance failed:", err);
    return null;
  }
}

// ─── Unsigned transaction building ───────────────────────────────────

/**
 * The best single route + an unsigned transactionRequest for a swap/bridge.
 * Returns null on failure — the router (mcp/router.ts) falls back to
 * deBridge when this does.
 */
export async function getLifiQuote(input: LifiQuoteInput): Promise<LifiQuote | null> {
  try {
    const result = await callLifiTool("get-quote", {
      fromChain: input.fromChain,
      toChain: input.toChain,
      fromToken: input.fromToken,
      toToken: input.toToken,
      fromAddress: input.fromAddress,
      fromAmount: input.fromAmount,
      ...(input.toAddress ? { toAddress: input.toAddress } : {}),
      ...(input.slippage !== undefined ? { slippage: input.slippage } : {}),
    });
    return parseMcpToolResult<LifiQuote>(result);
  } catch (err) {
    console.warn("[mcp/lifi] getLifiQuote failed:", err);
    return null;
  }
}
