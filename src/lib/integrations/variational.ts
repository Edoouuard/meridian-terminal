/**
 * variational.ts — Variational options perp venue adapter.
 *
 * Variational is an options perp venue (calls/puts). It belongs to the same
 * off-chain signed-order family as Hyperliquid/Extended: the order is signed
 * with the user's wallet via EIP-712 typed data and later submitted to
 * Variational's matching engine. This adapter builds the typed payload and
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

/** EIP-712 primary type for a Variational options order. */
export const VARIATIONAL_ORDER_TYPE = "VariationalOrder";

/** Variational order fields (calls/puts on the same signed-order family). */
export const VARIATIONAL_ORDER_TYPES: Record<
  string,
  ReadonlyArray<{ name: string; type: string }>
> = {
  VariationalOrder: [
    { name: "underlying", type: "string" },
    { name: "kind", type: "string" },
    { name: "strike", type: "uint64" },
    { name: "isBuy", type: "bool" },
    { name: "size", type: "uint64" },
    { name: "premium", type: "uint64" },
    { name: "reduceOnly", type: "bool" },
    { name: "cloid", type: "string" },
  ],
};

const VARIATIONAL_MARKETS = new Set([
  "BTC",
  "ETH",
  "SOL",
  "HYPE",
  "XRP",
]);

/** Options venues typically cap leverage lower than directional perps. */
const VARIATIONAL_MAX_LEVERAGE = 10;

/**
 * Resolve the option kind from the order. `isBuy` + direction heuristics:
 * buy => a call, sell => a put (see tradePlan.ts options intent for the same
 * convention). Pure.
 */
function resolveKind(order: PerpOrder): string {
  const m = (order.market || order.symbol || "").toLowerCase();
  if (m.includes("call")) return "call";
  if (m.includes("put")) return "put";
  return order.isBuy ? "call" : "put";
}

/**
 * Build the EIP-712 typed payload for a Variational options order. Pure —
 * nothing is signed or transmitted here.
 */
export function buildTypedData(order: PerpOrder): TypedData {
  const underlying = (order.symbol ?? order.market).split(/[-_ ]/i)[0].toUpperCase();
  const size = order.sizePerp !== undefined && order.sizePerp > BigInt(0)
    ? order.sizePerp
    : BigInt(Math.round(order.sizeUsd));
  const message = {
    underlying,
    kind: resolveKind(order),
    strike: order.price ?? BigInt(0),
    isBuy: order.isBuy,
    size,
    premium: BigInt(0),
    reduceOnly: order.reduceOnly ?? false,
    cloid: `va-${underlying.toLowerCase()}-${resolveKind(order)}-${(order.signer || "").toLowerCase().slice(0, 6)}`,
  };
  return assembleTypedData({
    primaryType: VARIATIONAL_ORDER_TYPE,
    domain: {
      name: "Variational",
      version: "1",
      chainId: order.chainId ?? 42161,
    },
    types: VARIATIONAL_ORDER_TYPES,
    message,
  });
}

export const variationalAdapter: PerpAdapter = {
  venue: "variational",

  isMarketSupported(symbol: string): boolean {
    return VARIATIONAL_MARKETS.has((symbol || "").toUpperCase().split(/[-_ ]/i)[0]);
  },

  maxLeverage(): number {
    return VARIATIONAL_MAX_LEVERAGE;
  },

  async signOrder(
    order: PerpOrder,
    signer: Address,
    sign: PerpSignFunction,
  ): Promise<SignedPerpOrder> {
    if (order.sizeUsd <= 0 && (order.sizePerp === undefined || order.sizePerp <= BigInt(0))) {
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
      exchange: "variational",
      chainId: signed.order.chainId ?? 42161,
      clientOrderId: t.message.cloid as string,
      underlying: t.message.underlying,
      kind: t.message.kind,
      strike: t.message.strike,
      isBuy: t.message.isBuy,
      size: t.message.size,
      premium: t.message.premium,
      reduceOnly: t.message.reduceOnly,
      signature: signed.signature,
      expiresAt: signed.expiresAt,
    };
  },
};
