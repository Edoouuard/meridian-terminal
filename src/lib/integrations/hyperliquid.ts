/**
 * hyperliquid.ts — Hyperliquid perp venue adapter.
 *
 * Hyperliquid signs orders off-chain with the user's wallet using EIP-712 typed
 * data over a Hyperliquid order structure, then submits the signed order to the
 * Hyperliquid matching engine / L1 Exchange contract (HyperliquidCore). This
 * adapter implements the typed-data build + sign path; it performs no network
 * calls and never auto-submits. Submitting the resulting `SignedPerpOrder` is a
 * separate, future step (see the follow-up notes in the task report).
 *
 * This module is pure and side-effect free.
 */

import type { Address } from "viem";
import { assembleTypedData } from "./types";
import type {
  PerpAdapter,
  PerpOrder,
  PerpSignFunction,
  SignedPerpOrder,
  TypedData,
  ValidationResult,
} from "./types";

/** EIP-712 primary type for a Hyperliquid order. */
export const HYPERLIQUID_ORDER_TYPE = "HyperliquidOrder";

/** Hyperliquid order fields (matches the on-chain order structure). */
export const HYPERLIQUID_ORDER_TYPES: Record<
  string,
  ReadonlyArray<{ name: string; type: string }>
> = {
  HyperliquidOrder: [
    { name: "asset", type: "uint32" },
    { name: "isBuy", type: "bool" },
    { name: "limitPx", type: "uint64" },
    { name: "sz", type: "uint64" },
    { name: "reduceOnly", type: "bool" },
    { name: "orderType", type: "string" },
    { name: "cloid", type: "string" },
  ],
};

/** Curated set of markets this adapter claims to support. */
const HYPERLIQUID_MARKETS = new Set([
  "HYPE",
  "BTC",
  "BTC-PERP",
  "ETH",
  "ETH-PERP",
  "SOL",
  "SOL-PERP",
  "XRP",
  "DOGE",
  "SUI",
  "LINK",
  "AVAX",
  "BNB",
]);

/** Hyperliquid's default max leverage for most perp markets (50x). */
const HYPERLIQUID_MAX_LEVERAGE = 50;

/**
 * Resolve a market/symbol to Hyperliquid's numeric asset index. Hyperliquid uses
 * the listing order index rather than a ticker on the wire. This is a partial,
 * offline map — a production follow-up should fetch the live asset index table
 * (info API) and cache it. Unknown symbols default to 0 with no guarantee.
 */
export function hyperliquidAssetIndex(symbol: string): number {
  const s = (symbol || "").toUpperCase();
  const known: Record<string, number> = {
    HYPE: 0,
    BTC: 1,
    ETH: 2,
    SOL: 3,
    XRP: 4,
    DOGE: 5,
    SUI: 6,
    LINK: 7,
    AVAX: 8,
    BNB: 9,
  };
  return known[s] ?? 0;
}

/**
 * Validate a Hyperliquid order: positive size, leverage within the venue bound,
 * and a positive price when a limit price is supplied. Pure.
 */
export function validateOrder(order: PerpOrder): ValidationResult {
  if (!order.sizeUsd && !order.sizePerp) {
    return { ok: false, error: "order size must be positive (sizeUsd or sizePerp)" };
  }
  if (order.sizeUsd < 0 || (order.sizePerp !== undefined && order.sizePerp <= BigInt(0))) {
    return { ok: false, error: "order size must be positive" };
  }
  const lev = order.leverage ?? 1;
  if (!Number.isFinite(lev) || lev < 1 || lev > HYPERLIQUID_MAX_LEVERAGE) {
    return {
      ok: false,
      error: `leverage ${lev} out of Hyperliquid bounds (1..${HYPERLIQUID_MAX_LEVERAGE})`,
    };
  }
  if (order.price !== undefined && order.price <= BigInt(0)) {
    return { ok: false, error: "limit price must be positive" };
  }
  return { ok: true };
}

/**
 * Derive the venue-native size (`sz`) in perp units. Prefers an explicit
 * `sizePerp`; otherwise falls back to `sizeUsd` when no price is given (a
 * notional approximation) or `sizeUsd / price` for a priced limit order. Pure.
 */
function resolveSizeSz(order: PerpOrder): bigint {
  if (order.sizePerp !== undefined && order.sizePerp > BigInt(0)) return order.sizePerp;
  const price = order.price !== undefined && order.price > BigInt(0) ? Number(order.price) : 0;
  const perp = price > 0 ? order.sizeUsd / price : order.sizeUsd;
  const clamped = Number.isFinite(perp) && perp > 0 ? perp : order.sizeUsd;
  return BigInt(Math.round(clamped));
}

/**
 * Build the EIP-712 typed payload for a Hyperliquid order. Pure — produces
 * `{ domain, types, message }` (plus `primaryType`) without signing anything.
 */
export function buildTypedData(order: PerpOrder): TypedData {
  const symbol = (order.symbol ?? order.market).toUpperCase();
  const domain = {
    name: "Hyperliquid",
    version: "1",
    chainId: order.chainId ?? 42161,
  };
  const message = {
    asset: hyperliquidAssetIndex(symbol),
    isBuy: order.isBuy,
    limitPx: order.price ?? BigInt(0),
    sz: resolveSizeSz(order),
    reduceOnly: order.reduceOnly ?? false,
    orderType: order.price ? "limit" : "market",
    cloid: `hl-${symbol.toLowerCase()}-${order.isBuy ? "b" : "s"}-${(order.signer || "").toLowerCase().slice(0, 6)}`,
  };
  return assembleTypedData({
    primaryType: HYPERLIQUID_ORDER_TYPE,
    domain,
    types: HYPERLIQUID_ORDER_TYPES,
    message,
  });
}

/** Shape a signed Hyperliquid order into a submission payload. Pure / offline. */
function buildSubmission(signed: SignedPerpOrder): object {
  const t = buildTypedData(signed.order);
  return {
    exchange: "hyperliquid",
    chainId: signed.order.chainId ?? 42161,
    clientOrderId: t.message.cloid,
    asset: t.message.asset,
    isBuy: t.message.isBuy,
    limitPx: t.message.limitPx,
    sz: t.message.sz,
    reduceOnly: t.message.reduceOnly,
    orderType: t.message.orderType,
    signature: signed.signature,
    expiresAt: signed.expiresAt,
  };
}

export const hyperliquidAdapter: PerpAdapter = {
  venue: "hyperliquid",

  isMarketSupported(symbol: string): boolean {
    return HYPERLIQUID_MARKETS.has((symbol || "").toUpperCase());
  },

  maxLeverage(): number {
    return HYPERLIQUID_MAX_LEVERAGE;
  },

  async signOrder(
    order: PerpOrder,
    signer: Address,
    sign: PerpSignFunction,
  ): Promise<SignedPerpOrder> {
    const check = validateOrder(order);
    if (!check.ok) throw new Error(check.error);
    const typed = buildTypedData(order);
    const signature = await sign(typed);
    return {
      order,
      signature,
      expiresAt: Date.now() + 60_000,
    };
  },

  buildSubmission,
};
