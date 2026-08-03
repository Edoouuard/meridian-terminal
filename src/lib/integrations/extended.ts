/**
 * extended.ts — Extended perp venue adapter.
 *
 * Extended is the Hyperliquid-adjacent L1 (some venues refer to it as the EVM
 * L1). It uses the same off-chain signed-order family as Hyperliquid: the order
 * is signed with the user's wallet via EIP-712 typed data and later submitted
 * to Extended's matching engine. This adapter builds the typed payload and
 * signing path only — it performs no network calls and never auto-submits.
 *
 * Pure and side-effect free.
 */

import type { Address } from "viem";
import { assembleTypedData } from "./types";
import type {
  PerpAdapter,
  PerpOrder,
  PerpSignFunction,
  SignedPerpOrder,
  TypedData,
} from "./types";

/** EIP-712 primary type for an Extended order. */
export const EXTENDED_ORDER_TYPE = "ExtendedOrder";

/** Extended order fields (structurally aligned with the Hyperliquid family). */
export const EXTENDED_ORDER_TYPES: Record<
  string,
  ReadonlyArray<{ name: string; type: string }>
> = {
  ExtendedOrder: [
    { name: "asset", type: "string" },
    { name: "isBuy", type: "bool" },
    { name: "size", type: "uint64" },
    { name: "price", type: "uint64" },
    { name: "reduceOnly", type: "bool" },
    { name: "orderType", type: "string" },
    { name: "cloid", type: "string" },
  ],
};

const EXTENDED_MARKETS = new Set([
  "BTC-PERP",
  "ETH-PERP",
  "SOL-PERP",
  "HYPE-PERP",
  "XRP-PERP",
  "DOGE-PERP",
]);

/** Extended's conservative default max leverage. */
const EXTENDED_MAX_LEVERAGE = 20;

/**
 * Build the EIP-712 typed payload for an Extended order. Pure — nothing is
 * signed or transmitted here.
 */
export function buildTypedData(order: PerpOrder): TypedData {
  const asset = (order.symbol ?? order.market).toUpperCase();
  const size = order.sizePerp !== undefined && order.sizePerp > BigInt(0)
    ? order.sizePerp
    : BigInt(Math.round(order.sizeUsd));
  const message = {
    asset,
    isBuy: order.isBuy,
    size,
    price: order.price ?? BigInt(0),
    reduceOnly: order.reduceOnly ?? false,
    orderType: order.price ? "limit" : "market",
    cloid: `ex-${asset.toLowerCase()}-${order.isBuy ? "b" : "s"}-${(order.signer || "").toLowerCase().slice(0, 6)}`,
  };
  return assembleTypedData({
    primaryType: EXTENDED_ORDER_TYPE,
    domain: {
      name: "Extended",
      version: "1",
      chainId: order.chainId ?? 1,
    },
    types: EXTENDED_ORDER_TYPES,
    message,
  });
}

export const extendedAdapter: PerpAdapter = {
  venue: "extended",

  isMarketSupported(symbol: string): boolean {
    return EXTENDED_MARKETS.has((symbol || "").toUpperCase());
  },

  maxLeverage(): number {
    return EXTENDED_MAX_LEVERAGE;
  },

  async signOrder(
    order: PerpOrder,
    signer: Address,
    sign: PerpSignFunction,
  ): Promise<SignedPerpOrder> {
    if ((order.sizeUsd <= 0 && (order.sizePerp === undefined || order.sizePerp <= BigInt(0)))) {
      throw new Error("order size must be positive");
    }
    const typed = buildTypedData(order);
    const signature = await sign(typed);
    return {
      order,
      signature,
      expiresAt: Date.now() + 60_000,
    };
  },

  buildSubmission(signed: SignedPerpOrder): object {
    const t = buildTypedData(signed.order);
    return {
      exchange: "extended",
      chainId: signed.order.chainId ?? 1,
      clientOrderId: t.message.cloid as string,
      asset: t.message.asset,
      isBuy: t.message.isBuy,
      size: t.message.size,
      price: t.message.price,
      reduceOnly: t.message.reduceOnly,
      orderType: t.message.orderType,
      signature: signed.signature,
      expiresAt: signed.expiresAt,
    };
  },
};
