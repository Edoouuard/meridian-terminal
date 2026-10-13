/**
 * mcp/router.ts — Meridian's cross-chain swap/bridge routing layer.
 *
 * Queries deBridge (DLN) and LI.FI in parallel for any cross-chain or
 * same-chain swap, then picks the better quote. deBridge is purpose-built
 * for cross-chain intents; LI.FI is the fallback / cross-check and the
 * primary route for anything deBridge doesn't support (it aggregates 27+
 * other bridges + 31+ DEXes). Never signs or broadcasts — returns an
 * unsigned `RouteQuote` for the transaction-policy engine + wallet layer.
 */

import { createDebridgeCrossChainTx, createDebridgeSameChainSwapTx } from "./debridge";
import { getLifiQuote } from "./lifi";
import { isTrustedDebridgeEntrypoint, isTrustedLifiEntrypoint } from "./routerAllowlist";
import type { RouteRequest as TypesRouteRequest, McpProviderStatus } from "./types";

export type RouteProvider = "debridge" | "lifi";

export interface RouteRequest {
  fromChainId: number;
  toChainId: number;
  fromTokenAddress: string;
  toTokenAddress: string;
  fromAmount: string;
  fromAddress: string;
  toAddress?: string;
  slippageBps?: number;
}

/** Unsigned transaction data, normalized the same way across every router/protocol adapter in this codebase. */
export interface RouteTx {
  to: string;
  data: string;
  value?: string;
  chainId: number;
}

export interface RouteQuote {
  provider: RouteProvider;
  tx: RouteTx;
  /** Destination-token amount estimate, in base units, when the provider reports one. */
  toAmountEstimate?: string;
  etaSeconds?: number;
  /** deBridge order id (cross-chain), for status tracking via /api/bridge?action=status. */
  orderId?: string;
  /** ERC-20 approval the provider says must be sent before `tx`, when it reports one. */
  approvalTx?: RouteTx;
}

/**
 * True when the quote's `to` is a verified entrypoint (routerAllowlist.ts).
 * execution.ts refuses to sign anything else, so surfacing such a quote as
 * "best" would only fail later at signing time — drop it here instead and
 * let the other provider win.
 */
export function isSignableQuote(q: RouteQuote): boolean {
  const trusted = q.provider === "lifi" ? isTrustedLifiEntrypoint : isTrustedDebridgeEntrypoint;
  return trusted(q.tx.chainId, q.tx.to);
}

/** Parse a base-unit amount string to a bigint, or null when it isn't one — never throws. */
function toBaseUnits(amount: string | undefined): bigint | null {
  if (!amount) return null;
  try {
    return BigInt(amount);
  } catch {
    return null;
  }
}

/**
 * Pick the best quote among already-fetched candidates: whichever reports
 * the higher destination-amount estimate. When estimates aren't comparable
 * (one or more candidates report none, or report something unparseable),
 * fetch order wins instead of guessing — fetch order already prefers
 * deBridge for cross-chain (see getBestRoute). Pure — no network, fully
 * unit-testable.
 */
export function selectBestRoute(quotes: RouteQuote[]): { best: RouteQuote | null; alternatives: RouteQuote[] } {
  if (quotes.length === 0) return { best: null, alternatives: [] };

  const withAmounts = quotes.map((q) => ({ quote: q, amount: toBaseUnits(q.toAmountEstimate) }));
  const comparable = withAmounts.every((w) => w.amount !== null);

  const sorted = comparable
    ? [...withAmounts]
        .sort((a, b) => {
          if (a.amount! > b.amount!) return -1;
          if (a.amount! < b.amount!) return 1;
          return 0;
        })
        .map((w) => w.quote)
    : quotes;

  return { best: sorted[0], alternatives: sorted.slice(1) };
}

/**
 * Fetch quotes from both routers (whichever apply — a same-chain swap only
 * queries deBridge's same-chain tool plus LI.FI's quote; a cross-chain
 * request queries deBridge's DLN order and LI.FI's quote, in parallel) and
 * return the best one plus the rest as fallbacks. Never signs or broadcasts.
 */
export async function getBestRoute(req: RouteRequest): Promise<{ best: RouteQuote | null; alternatives: RouteQuote[] }> {
  const isSameChain = req.fromChainId === req.toChainId;

  const [debridgeResult, lifiResult] = await Promise.allSettled([
    isSameChain
      ? createDebridgeSameChainSwapTx({
          chainId: req.fromChainId,
          tokenIn: req.fromTokenAddress,
          tokenOut: req.toTokenAddress,
          amountIn: req.fromAmount,
          senderAddress: req.fromAddress,
          slippageBps: req.slippageBps,
        })
      : createDebridgeCrossChainTx({
          srcChainId: req.fromChainId,
          srcTokenAddress: req.fromTokenAddress,
          srcAmount: req.fromAmount,
          dstChainId: req.toChainId,
          dstTokenAddress: req.toTokenAddress,
          senderAddress: req.fromAddress,
          recipientAddress: req.toAddress,
          slippageBps: req.slippageBps,
        }),
    getLifiQuote({
      fromChain: req.fromChainId,
      toChain: req.toChainId,
      fromToken: req.fromTokenAddress,
      toToken: req.toTokenAddress,
      fromAddress: req.fromAddress,
      fromAmount: req.fromAmount,
      toAddress: req.toAddress,
      slippage: req.slippageBps !== undefined ? req.slippageBps / 10000 : undefined,
    }),
  ]);

  const quotes: RouteQuote[] = [];

  if (debridgeResult.status === "fulfilled" && debridgeResult.value?.tx) {
    const value = debridgeResult.value;
    if (value.kind === "same-chain") {
      quotes.push({ provider: "debridge", tx: value.tx!, toAmountEstimate: value.estimatedAmountOut });
    } else {
      quotes.push({
        provider: "debridge",
        tx: value.tx!,
        toAmountEstimate: value.estimatedDstAmount,
        etaSeconds: value.estimatedTimeSeconds,
        orderId: value.orderId,
        ...(value.approveTx ? { approvalTx: value.approveTx } : {}),
      });
    }
  }

  if (lifiResult.status === "fulfilled" && lifiResult.value?.transactionRequest) {
    const value = lifiResult.value;
    const tx = value.transactionRequest!;
    quotes.push({
      provider: "lifi",
      tx: { to: tx.to, data: tx.data, value: tx.value, chainId: Number.isFinite(tx.chainId) ? tx.chainId : req.fromChainId },
      toAmountEstimate: value.estimate?.toAmount || undefined,
      etaSeconds: value.estimate?.executionDuration,
    });
  }

  const signable = quotes.filter((q) => {
    if (isSignableQuote(q)) return true;
    console.warn(`[mcp/router] dropping ${q.provider} quote: ${q.tx.to} is not an allowlisted entrypoint on chain ${q.tx.chainId}`);
    return false;
  });

  return selectBestRoute(signable);
}

// ─── Compatibility layer ──────────────────────────────────────────────
// The orchestrator and API routes use the old-style `RouteRequest` from
// mcp/types.ts (with `fromToken`, `userAddress`) and expect these names.
// We bridge them to the new internal `RouteRequest` (with `fromTokenAddress`,
// `fromAddress`) so both systems work.

/** Result type expected by orchestrator / api/bridge. */
export interface RouteComparison {
  best: RouteQuote;
  alternatives: RouteQuote[];
  slippage?: number;
}

function adaptRequest(req: TypesRouteRequest): RouteRequest {
  return {
    fromChainId: req.fromChainId,
    toChainId: req.toChainId,
    fromTokenAddress: req.fromToken,
    toTokenAddress: req.toToken,
    fromAmount: req.fromAmount,
    fromAddress: req.userAddress,
    slippageBps: req.slippage !== undefined ? Math.round(req.slippage * 10000) : undefined,
  };
}

/** Compatibility wrapper: find best route using types.ts RouteRequest shape. */
export async function findBestRoute(req: TypesRouteRequest): Promise<RouteComparison | null> {
  const result = await getBestRoute(adaptRequest(req));
  if (!result.best) return null;
  return { best: result.best, alternatives: result.alternatives, slippage: req.slippage };
}

/** Compatibility wrapper: plan route returns comparison + execution data. */
export async function planRoute(req: TypesRouteRequest): Promise<RouteComparison | null> {
  return findBestRoute(req);
}

// ─── Provider health tracking ─────────────────────────────────────────

interface ProviderHealth {
  id: string;
  name: string;
  healthy: boolean;
  latencyMs: number | null;
  lastChecked: number;
}

const providerHealth: Record<string, ProviderHealth> = {
  debridge: { id: "debridge", name: "deBridge", healthy: false, latencyMs: null, lastChecked: 0 },
  lifi: { id: "lifi", name: "LI.FI", healthy: false, latencyMs: null, lastChecked: 0 },
};

const DEBRIDGE_MCP_URL = process.env.DEBRIDGE_MCP_URL || "https://agents.debridge.com/mcp";
const LIFI_MCP_URL = process.env.LIFI_MCP_URL || "https://mcp.li.quest/mcp";

/**
 * Health = the MCP handshake + tools/list succeed and the tool the router
 * depends on is advertised. Independent of any payload shape, so a schema
 * change in a data tool can't make a working server look down (or vice versa).
 */
async function probe(id: RouteProvider, name: string, url: string, requiredTool: string, headers?: Record<string, string>): Promise<void> {
  const start = Date.now();
  try {
    const { listMcpTools } = await import("./client");
    const { tools } = await listMcpTools(url, id, { transport: "http", timeoutMs: 8000, headers });
    const healthy = tools.some((t) => t.name === requiredTool);
    if (!healthy) console.warn(`[mcp/router] ${name} MCP is up but does not expose ${requiredTool}`);
    providerHealth[id] = { id, name, healthy, latencyMs: Date.now() - start, lastChecked: Date.now() };
  } catch (err) {
    console.warn(`[mcp/router] ${name} health check failed:`, err);
    providerHealth[id] = { id, name, healthy: false, latencyMs: Date.now() - start, lastChecked: Date.now() };
  }
}

/** Run health checks on both routing providers. */
export async function checkAllProviders(): Promise<McpProviderStatus[]> {
  const lifiKey = process.env.LIFI_API_KEY;
  await Promise.allSettled([
    probe("debridge", "deBridge", DEBRIDGE_MCP_URL, "create_tx"),
    probe("lifi", "LI.FI", LIFI_MCP_URL, "get-quote", lifiKey ? { "x-lifi-api-key": lifiKey } : undefined),
  ]);
  return getAllProviderStatus();
}

/** Return cached provider health status (no network calls). */
export function getAllProviderStatus(): McpProviderStatus[] {
  return Object.values(providerHealth).map((p) => ({
    id: p.id as McpProviderStatus["id"],
    name: p.name,
    healthy: p.healthy,
    latencyMs: p.latencyMs,
    lastChecked: p.lastChecked,
  }));
}
