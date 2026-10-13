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

/** All chains LI.FI currently routes across (MCP, then REST). Returns [] on failure. */
export async function fetchLifiChains(): Promise<LifiChain[]> {
  try {
    const chains = normalizeLifiChains(parseMcpToolResult<unknown>(await callLifiTool("get-chains", {})));
    if (chains.length > 0) return chains;
  } catch (err) {
    console.warn("[mcp/lifi] get-chains failed, trying REST:", err);
  }
  try {
    const res = await fetch(`${LIFI_REST_URL}/chains`, { signal: AbortSignal.timeout(8000), headers: authHeaders() });
    return res.ok ? normalizeLifiChains(await res.json()) : [];
  } catch {
    return [];
  }
}

/** Every token LI.FI knows on a chain (MCP, then REST). Returns [] on failure. */
export async function fetchLifiTokens(chainId: number): Promise<LifiToken[]> {
  const pick = (payload: unknown): LifiToken[] => {
    const tokens = isRec(payload) && isRec(payload.tokens) ? payload.tokens[String(chainId)] : undefined;
    return Array.isArray(tokens) ? (tokens as LifiToken[]) : [];
  };
  try {
    const tokens = pick(unwrap(parseMcpToolResult<unknown>(await callLifiTool("get-tokens", { chains: [String(chainId)] }))));
    if (tokens.length > 0) return tokens;
  } catch (err) {
    console.warn("[mcp/lifi] get-tokens failed, trying REST:", err);
  }
  try {
    const res = await fetch(`${LIFI_REST_URL}/tokens?chains=${chainId}`, { signal: AbortSignal.timeout(8000), headers: authHeaders() });
    return res.ok ? pick(await res.json()) : [];
  } catch {
    return [];
  }
}

export interface LifiRouteStatus {
  status: "PENDING" | "DONE" | "FAILED" | "NOT_FOUND" | string;
  substatus?: string;
  sending?: { txHash: string; chainId: number };
  receiving?: { txHash: string; chainId: number };
}

/** Cross-chain transfer status for a source tx hash (MCP, then REST). Returns null on failure. */
export async function getLifiRouteStatus(txHash: string, fromChainId: number, toChainId?: number): Promise<LifiRouteStatus | null> {
  let mcp: LifiRouteStatus | null = null;
  try {
    const args: Record<string, unknown> = { txHash, fromChain: String(fromChainId) };
    if (toChainId) args.toChain = String(toChainId);
    const v = unwrap(parseMcpToolResult<unknown>(await callLifiTool("get-status", args)));
    if (isRec(v) && typeof v.status === "string") mcp = v as unknown as LifiRouteStatus;
  } catch (err) {
    console.warn("[mcp/lifi] get-status failed:", err);
  }
  if ((mcp && mcp.status !== "NOT_FOUND") || !toChainId) return mcp;
  try {
    const params = new URLSearchParams({ txHash, fromChain: String(fromChainId), toChain: String(toChainId) });
    const res = await fetch(`${LIFI_REST_URL}/status?${params}`, { signal: AbortSignal.timeout(10_000), headers: authHeaders() });
    return res.ok ? ((await res.json()) as LifiRouteStatus) : mcp;
  } catch {
    return mcp;
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

// ─── Earn vaults ─────────────────────────────────────────────────────
//
// LI.FI's MCP `get-earn-*` tools are currently broken upstream: they proxy to
// li.quest/v1/earn/* which 404s ("Cannot GET /v1/earn/vaults", verified
// 2026-10). The live Earn Data API is https://earn.li.fi/v1/vaults and
// REQUIRES an `x-lifi-api-key` (free, from the LI.FI Partner Portal). We try
// the MCP tool first (so an upstream fix is picked up automatically), then
// the REST API when LIFI_API_KEY is set.

const LIFI_EARN_URL = process.env.LIFI_EARN_URL || "https://earn.li.fi/v1";

export interface LifiEarnVault {
  address: string;
  chainId: number;
  name: string;
  protocol: string;
  /** Underlying deposit token symbol(s), "/"-joined for multi-asset vaults. */
  asset: string;
  /** Total APY as a fraction (0.0534 = 5.34%). */
  apy: number;
  tvlUsd: number;
  tags: string[];
  /** Depositable via LI.FI Composer. */
  isTransactional: boolean;
}

/** Normalize Earn API `{ data: NormalizedVault[] }` (or a bare array). Pure — exported for tests. */
export function normalizeLifiEarnVaults(payload: unknown): LifiEarnVault[] {
  const raw = isRec(payload) && Array.isArray(payload.data) ? payload.data : unwrap(payload);
  const list = Array.isArray(raw) ? raw : isRec(raw) && Array.isArray(raw.vaults) ? raw.vaults : [];
  const toNum = (v: unknown): number => {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    return Number.isFinite(n) ? n : 0;
  };
  return list.flatMap((v): LifiEarnVault[] => {
    if (!isRec(v) || typeof v.address !== "string") return [];
    const analytics = isRec(v.analytics) ? v.analytics : {};
    const apy = isRec(analytics.apy) ? analytics.apy : {};
    const tvl = isRec(analytics.tvl) ? analytics.tvl : {};
    const protocol = isRec(v.protocol) ? v.protocol : {};
    const tokens = Array.isArray(v.underlyingTokens) ? v.underlyingTokens : [];
    const symbols = tokens.map((t) => (isRec(t) && typeof t.symbol === "string" ? t.symbol : "")).filter(Boolean);
    return [{
      address: v.address,
      chainId: toNum(v.chainId),
      name: typeof v.name === "string" ? v.name : v.address,
      protocol: typeof protocol.name === "string" ? protocol.name : "Unknown",
      asset: symbols.length > 0 ? symbols.join("/") : "?",
      // The live Earn API reports APY in percent (5.82 = 5.82%), verified
      // 2026-10-13 against Morpho/Aave USDC on Base; normalize to a fraction.
      apy: toNum(apy.total ?? apy.base) / 100,
      tvlUsd: toNum(tvl.usd),
      tags: Array.isArray(v.tags) ? v.tags.filter((t): t is string => typeof t === "string") : [],
      isTransactional: v.isTransactional === true,
    }];
  });
}

export interface LifiEarnVaultQuery {
  asset?: string;
  chainId?: number;
  protocol?: string;
  minTvlUsd?: number;
  limit?: number;
}

let warnedMissingEarnKey = false;

/** Earn vaults sorted by APY (desc). Returns [] on failure — never throws. */
export async function fetchLifiEarnVaults(query: LifiEarnVaultQuery = {}): Promise<LifiEarnVault[]> {
  const params: Record<string, string> = { sortBy: "apy", sortDirection: "desc", limit: String(query.limit ?? 30) };
  if (query.asset) params.asset = query.asset;
  if (query.chainId) params.chainId = String(query.chainId);
  if (query.protocol) params.protocol = query.protocol;

  try {
    const vaults = normalizeLifiEarnVaults(parseMcpToolResult<unknown>(await callLifiTool("get-earn-vaults", params)));
    if (vaults.length > 0) return vaults;
  } catch {
    // Expected while LI.FI's MCP earn tools 404 upstream — fall through to REST.
  }

  const key = process.env.LIFI_API_KEY;
  if (!key) {
    if (!warnedMissingEarnKey) {
      warnedMissingEarnKey = true;
      console.warn("[mcp/lifi] Earn vaults unavailable: LI.FI's MCP earn tools are down and earn.li.fi requires LIFI_API_KEY");
    }
    return [];
  }

  try {
    const rest = new URLSearchParams(params);
    if (query.minTvlUsd) rest.set("minTvlUsd", String(query.minTvlUsd));
    const res = await fetch(`${LIFI_EARN_URL}/vaults?${rest}`, {
      signal: AbortSignal.timeout(10_000),
      headers: { "x-lifi-api-key": key },
    });
    if (!res.ok) throw new Error(`earn.li.fi /vaults → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return normalizeLifiEarnVaults(await res.json());
  } catch (err) {
    console.warn("[mcp/lifi] fetchLifiEarnVaults failed:", err);
    return [];
  }
}
