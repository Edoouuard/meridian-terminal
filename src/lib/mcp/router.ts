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

import { createDebridgeCrossChainTx, createDebridgeSameChainSwapTx, type DebridgeTxData } from "./debridge";
import { getLifiQuote, type LifiTxRequest } from "./lifi";

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

  if (debridgeResult.status === "fulfilled" && debridgeResult.value) {
    const value = debridgeResult.value;
    const tx: DebridgeTxData | null = isSameChain
      ? (value as DebridgeTxData)
      : (value as { tx: DebridgeTxData | null }).tx;
    if (tx) {
      quotes.push({
        provider: "debridge",
        tx,
        toAmountEstimate: isSameChain ? undefined : (value as { estimatedDstAmount?: string }).estimatedDstAmount,
        etaSeconds: isSameChain ? undefined : (value as { estimatedTimeSeconds?: number }).estimatedTimeSeconds,
      });
    }
  }

  if (lifiResult.status === "fulfilled" && lifiResult.value?.transactionRequest) {
    const value = lifiResult.value;
    const tx = value.transactionRequest as LifiTxRequest;
    quotes.push({
      provider: "lifi",
      tx: { to: tx.to, data: tx.data, value: tx.value, chainId: tx.chainId },
      toAmountEstimate: value.estimate?.toAmount,
      etaSeconds: value.estimate?.executionDuration,
    });
  }

  return selectBestRoute(quotes);
}
