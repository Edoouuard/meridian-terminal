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
 * Tool contract (from deBridge's own skill docs, debridge-finance/debridge-skills):
 * - EVERY argument is a string — numeric chain IDs are rejected.
 * - Chain IDs are deBridge IDs, which differ from EVM IDs for some chains
 *   (Gnosis 100 → 100000002, Sonic 146 → 100000014, Mantle 5000 → 100000023…).
 * - create_tx(srcChainId, srcChainTokenIn, srcChainTokenInAmount, dstChainId,
 *   dstChainTokenOut, dstChainTokenOutRecipient, srcChainOrderAuthorityAddress,
 *   dstChainOrderAuthorityAddress) → { tx, approveTx?, orderId, estimation }
 * - transaction_same_chain_swap(chainId, tokenIn, tokenInAmount, tokenOut,
 *   tokenOutRecipient, slippage?, senderAddress?) → { tx, tokenOut: { amount } }
 *
 * When the MCP server is unreachable, the same calls go to deBridge's public
 * DLN REST API (same parameter names), so routing keeps working.
 *
 * Non-custodial: every tool here returns unsigned transaction data (or
 * read-only data). Signing always happens client-side via wagmi/viem.
 * Every function fails closed (returns null/empty) — the router
 * (mcp/router.ts) falls back to LI.FI whenever this module does.
 */

import { callMcpTool, parseMcpToolResult } from "./client";

const DEBRIDGE_MCP_URL = process.env.DEBRIDGE_MCP_URL || "https://agents.debridge.com/mcp";
const DLN_API_URL = process.env.DEBRIDGE_DLN_API_URL || "https://dln.debridge.finance/v1.0";
const SERVER_NAME = "debridge";
const HTTP_TRANSPORT = { transport: "http" as const };

/** EVM chain ID → deBridge-internal chain ID, where they differ. */
const EVM_TO_DEBRIDGE_CHAIN: Record<number, number> = {
  100: 100000002, // Gnosis
  146: 100000014, // Sonic
  2741: 100000017, // Abstract
  5000: 100000023, // Mantle
  80094: 100000020, // Berachain
  245022934: 100000001, // Neon
};

export function toDebridgeChainId(evmChainId: number): string {
  return String(EVM_TO_DEBRIDGE_CHAIN[evmChainId] ?? evmChainId);
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
  /** Accepted for API symmetry; DLN cross-chain orders price slippage into the quote. */
  slippageBps?: number;
}

export interface DebridgeCrossChainOrder {
  kind: "cross-chain";
  tx: DebridgeTxData | null;
  /** ERC-20 approval to send before `tx`, when the server reports one. */
  approveTx?: DebridgeTxData | null;
  orderId?: string;
  estimatedDstAmount?: string;
  estimatedFeeUsd?: number;
  estimatedTimeSeconds?: number;
  /** Raw provider response, for display/debugging. */
  raw?: unknown;
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
  kind: "same-chain";
  tx: DebridgeTxData | null;
  estimatedAmountOut?: string;
  minAmountOut?: string;
  raw?: unknown;
}

// ─── Response normalization (pure, unit-tested) ──────────────────────

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "bigint" ? String(v) : undefined;
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Some MCP servers wrap payloads as { data } or { result }; unwrap one level. */
function unwrap(v: unknown): unknown {
  if (isRec(v) && !("tx" in v)) {
    if (isRec(v.data)) return v.data;
    if (isRec(v.result)) return v.result;
  }
  return v;
}

function normalizeTx(v: unknown, chainId: number): DebridgeTxData | null {
  if (!isRec(v)) return null;
  const to = str(v.to);
  const data = str(v.data);
  if (!to || !data) return null;
  return { to, data, value: str(v.value) ?? "0", chainId };
}

export function normalizeCreateTxResponse(payload: unknown, srcChainId: number): DebridgeCrossChainOrder | null {
  const raw = unwrap(payload);
  if (!isRec(raw)) return null;
  const est = isRec(raw.estimation) ? raw.estimation : {};
  const dstOut = isRec(est.dstChainTokenOut) ? est.dstChainTokenOut : {};
  const order = isRec(raw.order) ? raw.order : {};
  const costs = Array.isArray(est.costsDetails) ? est.costsDetails : [];
  const feeUsd = costs.reduce((sum: number, c) => {
    if (!isRec(c)) return sum;
    const payload = isRec(c.payload) ? c.payload : {};
    return sum + (num(payload.feeApproximateUsdValue) ?? num(c.feesUsd) ?? 0);
  }, 0);
  return {
    kind: "cross-chain",
    tx: normalizeTx(raw.tx, srcChainId),
    approveTx: normalizeTx(raw.approveTx, srcChainId),
    orderId: str(raw.orderId),
    estimatedDstAmount: str(dstOut.recommendedAmount) ?? str(dstOut.amount) ?? str(raw.estimatedDstAmount),
    estimatedFeeUsd: feeUsd > 0 ? feeUsd : undefined,
    estimatedTimeSeconds: num(order.approximateFulfillmentDelay) ?? num(raw.estimatedTimeSeconds),
    raw,
  };
}

export function normalizeSameChainSwapResponse(payload: unknown, chainId: number): DebridgeSameChainSwap | null {
  const raw = unwrap(payload);
  if (!isRec(raw)) return null;
  const tokenOut = isRec(raw.tokenOut) ? raw.tokenOut : {};
  return {
    kind: "same-chain",
    tx: normalizeTx(raw.tx, chainId),
    estimatedAmountOut: str(tokenOut.amount),
    minAmountOut: str(tokenOut.minAmount),
    raw,
  };
}

/** Normalize get_supported_chains, which may come back as an array or wrapped in { chains }. */
export function normalizeSupportedChains(payload: unknown): DebridgeChain[] {
  const raw = unwrap(payload);
  const list = Array.isArray(raw) ? raw : isRec(raw) && Array.isArray(raw.chains) ? raw.chains : [];
  return list
    .map((c): DebridgeChain | null => {
      if (typeof c === "number") return { chainId: c, name: String(c) };
      if (!isRec(c)) return null;
      const chainId = num(c.chainId) ?? num(c.id);
      if (chainId === undefined) return null;
      return { chainId, name: str(c.chainName) ?? str(c.name) ?? String(chainId) };
    })
    .filter((c): c is DebridgeChain => c !== null);
}

// ─── Transport helpers ───────────────────────────────────────────────

async function callDebridge(toolName: string, args: Record<string, string>): Promise<unknown> {
  return parseMcpToolResult<unknown>(await callMcpTool(DEBRIDGE_MCP_URL, SERVER_NAME, toolName, args, HTTP_TRANSPORT));
}

async function callDlnRest(path: string, params: Record<string, string>): Promise<unknown> {
  const res = await fetch(`${DLN_API_URL}${path}?${new URLSearchParams(params)}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`DLN REST ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ─── Read operations ─────────────────────────────────────────────────

/** Chains deBridge currently supports. Returns [] on failure (fail closed, like every mcp/ module). */
export async function fetchDebridgeSupportedChains(): Promise<DebridgeChain[]> {
  try {
    return normalizeSupportedChains(await callDebridge("get_supported_chains", {}));
  } catch (err) {
    console.warn("[mcp/debridge] fetchDebridgeSupportedChains failed:", err);
    return [];
  }
}

/** Search deBridge's token list on a given chain by symbol/name/address substring. */
export async function searchDebridgeTokens(chainId: number, query: string): Promise<DebridgeToken[]> {
  try {
    const raw = unwrap(await callDebridge("search_tokens", { query, chainId: toDebridgeChainId(chainId) }));
    const list = Array.isArray(raw) ? raw : isRec(raw) && Array.isArray(raw.tokens) ? raw.tokens : [];
    return list as DebridgeToken[];
  } catch (err) {
    console.warn("[mcp/debridge] searchDebridgeTokens failed:", err);
    return [];
  }
}

// ─── Unsigned transaction building ───────────────────────────────────

/**
 * Build an unsigned cross-chain DLN order transaction. Tries the MCP server,
 * then the DLN REST API. Returns null on failure — the router falls back to LI.FI.
 */
export async function createDebridgeCrossChainTx(input: DebridgeCrossChainOrderInput): Promise<DebridgeCrossChainOrder | null> {
  const recipient = input.recipientAddress ?? input.senderAddress;
  const args: Record<string, string> = {
    srcChainId: toDebridgeChainId(input.srcChainId),
    srcChainTokenIn: input.srcTokenAddress,
    srcChainTokenInAmount: input.srcAmount,
    dstChainId: toDebridgeChainId(input.dstChainId),
    dstChainTokenOut: input.dstTokenAddress,
    dstChainTokenOutRecipient: recipient,
    srcChainOrderAuthorityAddress: input.senderAddress,
    dstChainOrderAuthorityAddress: recipient,
  };

  try {
    const order = normalizeCreateTxResponse(await callDebridge("create_tx", args), input.srcChainId);
    if (order?.tx) return order;
    console.warn("[mcp/debridge] create_tx returned no tx, trying DLN REST");
  } catch (err) {
    console.warn("[mcp/debridge] create_tx via MCP failed, trying DLN REST:", err);
  }

  try {
    const order = normalizeCreateTxResponse(
      await callDlnRest("/dln/order/create-tx", { ...args, dstChainTokenOutAmount: "auto", senderAddress: input.senderAddress }),
      input.srcChainId,
    );
    return order?.tx ? order : null;
  } catch (err) {
    console.warn("[mcp/debridge] createDebridgeCrossChainTx failed:", err);
    return null;
  }
}

/** Build an unsigned same-chain swap transaction via deBridge's DEX aggregation (MCP, then REST). */
export async function createDebridgeSameChainSwapTx(input: DebridgeSameChainSwapInput): Promise<DebridgeSameChainSwap | null> {
  const args: Record<string, string> = {
    chainId: toDebridgeChainId(input.chainId),
    tokenIn: input.tokenIn,
    tokenInAmount: input.amountIn,
    tokenOut: input.tokenOut,
    tokenOutRecipient: input.recipientAddress ?? input.senderAddress,
    senderAddress: input.senderAddress,
    // deBridge takes slippage as a percent string, or "auto".
    slippage: input.slippageBps !== undefined ? String(input.slippageBps / 100) : "auto",
  };

  try {
    const swap = normalizeSameChainSwapResponse(await callDebridge("transaction_same_chain_swap", args), input.chainId);
    if (swap?.tx) return swap;
    console.warn("[mcp/debridge] transaction_same_chain_swap returned no tx, trying DLN REST");
  } catch (err) {
    console.warn("[mcp/debridge] same-chain swap via MCP failed, trying DLN REST:", err);
  }

  try {
    const swap = normalizeSameChainSwapResponse(await callDlnRest("/chain/transaction", args), input.chainId);
    return swap?.tx ? swap : null;
  } catch (err) {
    console.warn("[mcp/debridge] createDebridgeSameChainSwapTx failed:", err);
    return null;
  }
}
