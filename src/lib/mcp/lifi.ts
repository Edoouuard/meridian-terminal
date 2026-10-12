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
    /** Spender that needs an ERC-20 allowance before the tx (ERC-20 input only). */
    approvalAddress?: string;
  };
  tool?: string;
}

// ─── Response normalization ─────────────────────────────────────────

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** MCP servers sometimes wrap payloads as { data } / { result }; unwrap one level. */
function unwrap(v: unknown): unknown {
  if (isRec(v)) {
    if ("data" in v && (isRec(v.data) || Array.isArray(v.data))) return v.data;
    if ("result" in v && (isRec(v.result) || Array.isArray(v.result))) return v.result;
  }
  return v;
}

/** get-chains may return an array or LI.FI's REST shape { chains: [...] }. Pure — exported for tests. */
export function normalizeLifiChains(payload: unknown): LifiChain[] {
  const raw = unwrap(payload);
  const list = Array.isArray(raw) ? raw : isRec(raw) && Array.isArray(raw.chains) ? raw.chains : [];
  return list.filter((c): c is LifiChain => isRec(c) && typeof c.id === "number");
}

/** get-quote returns LI.FI's REST quote object (possibly wrapped). Pure — exported for tests. */
export function normalizeLifiQuote(payload: unknown): LifiQuote | null {
  const raw = unwrap(payload);
  if (!isRec(raw)) return null;
  const quote = isRec(raw.quote) ? raw.quote : raw;
  const txr = isRec(quote.transactionRequest) ? quote.transactionRequest : null;
  const est = isRec(quote.estimate) ? quote.estimate : null;
  const action = isRec(quote.action) ? quote.action : {};
  const transactionRequest: LifiTxRequest | null =
    txr && typeof txr.to === "string" && typeof txr.data === "string"
      ? {
          to: txr.to,
          data: txr.data,
          value: typeof txr.value === "string" ? txr.value : undefined,
          chainId: typeof txr.chainId === "number" ? txr.chainId : Number(action.fromChainId),
          gasLimit: typeof txr.gasLimit === "string" ? txr.gasLimit : undefined,
        }
      : null;
  return {
    transactionRequest,
    estimate: est
      ? {
          toAmount: String(est.toAmount ?? ""),
          executionDuration: Number(est.executionDuration ?? 0),
          approvalAddress: typeof est.approvalAddress === "string" ? est.approvalAddress : undefined,
        }
      : undefined,
    tool: typeof quote.tool === "string" ? quote.tool : undefined,
  };
}

// ─── Read operations ─────────────────────────────────────────────────

/** All chains LI.FI currently routes across. Returns [] on failure. */
export async function fetchLifiChains(): Promise<LifiChain[]> {
  try {
    return normalizeLifiChains(parseMcpToolResult<unknown>(await callLifiTool("get-chains", {})));
  } catch (err) {
    console.warn("[mcp/lifi] fetchLifiChains failed:", err);
    return [];
  }
}

/** Token metadata (address/decimals/price) for a symbol on a chain. Returns null on failure. */
export async function fetchLifiToken(chain: string | number, token: string): Promise<LifiToken | null> {
  try {
    const result = await callLifiTool("get-token", { chain: String(chain), token });
    return unwrap(parseMcpToolResult<unknown>(result)) as LifiToken | null;
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
    return unwrap(parseMcpToolResult<unknown>(result));
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
    const parsed = unwrap(parseMcpToolResult<unknown>(result));
    if (typeof parsed === "string" || typeof parsed === "number") return String(parsed);
    return isRec(parsed) && parsed.allowance !== undefined ? String(parsed.allowance) : null;
  } catch (err) {
    console.warn("[mcp/lifi] getLifiAllowance failed:", err);
    return null;
  }
}

// ─── Unsigned transaction building ───────────────────────────────────

const LIFI_REST_URL = process.env.LIFI_REST_URL || "https://li.quest/v1";

async function getLifiQuoteViaRest(params: Record<string, string>): Promise<LifiQuote | null> {
  const res = await fetch(`${LIFI_REST_URL}/quote?${new URLSearchParams(params)}`, {
    signal: AbortSignal.timeout(15_000),
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`LI.FI REST /quote → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return normalizeLifiQuote(await res.json());
}

/**
 * The best single route + an unsigned transactionRequest for a swap/bridge.
 * Tries the MCP server, then LI.FI's REST API (same parameters). Returns null
 * on failure — the router (mcp/router.ts) falls back to deBridge when this does.
 */
export async function getLifiQuote(input: LifiQuoteInput): Promise<LifiQuote | null> {
  const params: Record<string, string> = {
    fromChain: String(input.fromChain),
    toChain: String(input.toChain),
    fromToken: input.fromToken,
    toToken: input.toToken,
    fromAddress: input.fromAddress,
    fromAmount: input.fromAmount,
    ...(input.toAddress ? { toAddress: input.toAddress } : {}),
    ...(input.slippage !== undefined ? { slippage: String(input.slippage) } : {}),
  };

  try {
    const quote = normalizeLifiQuote(parseMcpToolResult<unknown>(await callLifiTool("get-quote", params)));
    if (quote?.transactionRequest) return quote;
    console.warn("[mcp/lifi] get-quote returned no transactionRequest, trying REST");
  } catch (err) {
    console.warn("[mcp/lifi] get-quote via MCP failed, trying REST:", err);
  }

  try {
    return await getLifiQuoteViaRest(params);
  } catch (err) {
    console.warn("[mcp/lifi] getLifiQuote failed:", err);
    return null;
  }
}
