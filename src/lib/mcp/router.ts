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
import { getLifiQuote, type LifiQuote } from "./lifi";
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
  /** USD value of toAmountEstimate, as estimated by the provider. */
  toAmountUsd?: number;
  /**
   * Native-token fee the tx charges on top of the swapped amount (base units),
   * e.g. deBridge's fixed DLN fee. "0" when there is none.
   */
  nativeFeeWei?: string;
  /**
   * What the user ends up with in USD after native fees (toAmountUsd minus
   * nativeFeeWei priced in USD). Only set when every input was known.
   */
  netUsdEstimate?: number;
  etaSeconds?: number;
  /** deBridge DLN order id — what /api/bridge?action=status tracks. */
  orderId?: string;
}

const NATIVE_TOKEN_ADDRESSES = new Set([
  "0x0000000000000000000000000000000000000000",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
]);

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
 * Pick the best quote among already-fetched candidates.
 *
 * When every candidate carries a net USD estimate (output value minus any
 * native fee charged on top), the highest net value wins — this is the only
 * comparison that accounts for deBridge's fixed fee. Otherwise the higher
 * destination-amount estimate wins. When neither is comparable across all
 * candidates, fetch order wins instead of guessing. Ties keep fetch order.
 * Pure — no network, fully unit-testable.
 */
export function selectBestRoute(quotes: RouteQuote[]): { best: RouteQuote | null; alternatives: RouteQuote[] } {
  if (quotes.length === 0) return { best: null, alternatives: [] };

  let sorted = quotes;
  if (quotes.every((q) => typeof q.netUsdEstimate === "number" && Number.isFinite(q.netUsdEstimate))) {
    sorted = [...quotes].sort((a, b) => b.netUsdEstimate! - a.netUsdEstimate!);
  } else {
    const withAmounts = quotes.map((q) => ({ quote: q, amount: toBaseUnits(q.toAmountEstimate) }));
    if (withAmounts.every((w) => w.amount !== null)) {
      sorted = [...withAmounts]
        .sort((a, b) => {
          if (a.amount! > b.amount!) return -1;
          if (a.amount! < b.amount!) return 1;
          return 0;
        })
        .map((w) => w.quote);
    }
  }

  return { best: sorted[0], alternatives: sorted.slice(1) };
}

/** Native fee a tx charges beyond the swapped amount: its value, minus fromAmount when the input itself is native. */
export function nativeFeeOf(tx: RouteTx, fromTokenAddress: string, fromAmount: string): bigint {
  const value = toBaseUnits(tx.value) ?? 0n;
  const spent = NATIVE_TOKEN_ADDRESSES.has(fromTokenAddress.toLowerCase()) ? toBaseUnits(fromAmount) ?? 0n : 0n;
  return value > spent ? value - spent : 0n;
}

/** Source-chain native token price in USD, read off a LI.FI quote's gas costs (they're priced in it). */
function nativePriceFromLifi(quote: LifiQuote | null | undefined): number | null {
  for (const gas of quote?.estimate?.gasCosts ?? []) {
    if (gas.token && NATIVE_TOKEN_ADDRESSES.has(gas.token.address.toLowerCase())) {
      const price = parseFloat(gas.token.priceUSD ?? "");
      if (Number.isFinite(price) && price > 0) return price;
    }
  }
  return null;
}

function parseUsd(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Native-token gas tokens on every chain Meridian routes through use 18 decimals. */
const NATIVE_DECIMALS = 18;

/**
 * Fetch quotes from both routers (whichever apply — a same-chain swap only
 * queries deBridge's same-chain tool plus LI.FI's quote; a cross-chain
 * request queries deBridge's DLN order and LI.FI's quote, in parallel) and
 * return the best one plus the rest as fallbacks. Never signs or broadcasts.
 *
 * A quote whose `to` isn't a verified entrypoint (routerAllowlist.ts) is
 * dropped here — execution would refuse to sign it anyway, so offering it
 * would only hide a usable alternative.
 */
export async function getBestRoute(req: RouteRequest): Promise<{ best: RouteQuote | null; alternatives: RouteQuote[] }> {
  const isSameChain = req.fromChainId === req.toChainId;

  const debridgePromise: Promise<RouteQuote | null> = isSameChain
    ? createDebridgeSameChainSwapTx({
        chainId: req.fromChainId,
        tokenIn: req.fromTokenAddress,
        tokenOut: req.toTokenAddress,
        amountIn: req.fromAmount,
        senderAddress: req.fromAddress,
        recipientAddress: req.toAddress,
        slippageBps: req.slippageBps,
      }).then((r) => (r?.tx
        ? { provider: "debridge", tx: r.tx, toAmountEstimate: r.estimatedAmountOut, toAmountUsd: r.estimatedAmountOutUsd }
        : null))
    : createDebridgeCrossChainTx({
        srcChainId: req.fromChainId,
        srcTokenAddress: req.fromTokenAddress,
        srcAmount: req.fromAmount,
        dstChainId: req.toChainId,
        dstTokenAddress: req.toTokenAddress,
        senderAddress: req.fromAddress,
        recipientAddress: req.toAddress,
      }).then((r) => (r?.tx
        ? {
            provider: "debridge",
            tx: r.tx,
            toAmountEstimate: r.estimatedDstAmount,
            toAmountUsd: r.estimatedDstAmountUsd,
            etaSeconds: r.estimatedTimeSeconds,
            orderId: r.orderId,
          }
        : null));

  const lifiPromise = getLifiQuote({
    fromChain: req.fromChainId,
    toChain: req.toChainId,
    fromToken: req.fromTokenAddress,
    toToken: req.toTokenAddress,
    fromAddress: req.fromAddress,
    fromAmount: req.fromAmount,
    toAddress: req.toAddress,
    slippage: req.slippageBps !== undefined ? req.slippageBps / 10000 : undefined,
  });

  const [debridgeResult, lifiResult] = await Promise.allSettled([debridgePromise, lifiPromise]);
  const lifiQuote = lifiResult.status === "fulfilled" ? lifiResult.value : null;

  const candidates: RouteQuote[] = [];
  if (debridgeResult.status === "fulfilled" && debridgeResult.value) candidates.push(debridgeResult.value);
  if (lifiQuote?.transactionRequest) {
    const tx = lifiQuote.transactionRequest;
    candidates.push({
      provider: "lifi",
      tx: { to: tx.to, data: tx.data, value: tx.value, chainId: tx.chainId ?? req.fromChainId },
      toAmountEstimate: lifiQuote.estimate?.toAmount,
      toAmountUsd: parseUsd(lifiQuote.estimate?.toAmountUSD),
      etaSeconds: lifiQuote.estimate?.executionDuration,
    });
  }

  const nativePrice = nativePriceFromLifi(lifiQuote);
  const quotes = candidates
    .filter((q) => {
      const trusted = q.provider === "lifi" ? isTrustedLifiEntrypoint : isTrustedDebridgeEntrypoint;
      if (q.tx.chainId !== req.fromChainId || !trusted(req.fromChainId, q.tx.to)) {
        console.warn(`[mcp/router] dropping ${q.provider} quote: ${q.tx.to} on chain ${q.tx.chainId} is not a verified entrypoint`);
        return false;
      }
      return true;
    })
    .map((q) => {
      const fee = nativeFeeOf(q.tx, req.fromTokenAddress, req.fromAmount);
      const feeUsd = fee === 0n ? 0 : nativePrice !== null ? (Number(fee) / 10 ** NATIVE_DECIMALS) * nativePrice : undefined;
      return {
        ...q,
        nativeFeeWei: fee.toString(),
        ...(q.toAmountUsd !== undefined && feeUsd !== undefined ? { netUsdEstimate: q.toAmountUsd - feeUsd } : {}),
      };
    });

  return selectBestRoute(quotes);
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

/** Build unsigned tx data from a route — the tx is already in the quote. */
export function buildRouteExecution(quote: RouteQuote): RouteTx | null {
  return quote.tx ?? null;
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

/** Run health checks on both routing providers. */
export async function checkAllProviders(): Promise<McpProviderStatus[]> {
  await Promise.allSettled([
    (async () => {
      const start = Date.now();
      try {
        const { fetchDebridgeSupportedChains } = await import("./debridge");
        const chains = await fetchDebridgeSupportedChains();
        providerHealth.debridge = {
          id: "debridge", name: "deBridge", healthy: chains.length > 0,
          latencyMs: Date.now() - start, lastChecked: Date.now(),
        };
      } catch {
        providerHealth.debridge = {
          id: "debridge", name: "deBridge", healthy: false,
          latencyMs: Date.now() - start, lastChecked: Date.now(),
        };
      }
    })(),
    (async () => {
      const start = Date.now();
      try {
        const { fetchLifiChains } = await import("./lifi");
        const chains = await fetchLifiChains();
        providerHealth.lifi = {
          id: "lifi", name: "LI.FI", healthy: chains.length > 0,
          latencyMs: Date.now() - start, lastChecked: Date.now(),
        };
      } catch {
        providerHealth.lifi = {
          id: "lifi", name: "LI.FI", healthy: false,
          latencyMs: Date.now() - start, lastChecked: Date.now(),
        };
      }
    })(),
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
