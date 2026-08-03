/**
 * hyperliquid.ts — Hyperliquid perp venue adapter.
 *
 * Hyperliquid signs orders off-chain with the user's wallet using EIP-712 typed
 * data over a Hyperliquid order structure, then submits the signed order to the
 * Hyperliquid matching engine via the public exchange HTTP API (or the L1
 * Exchange contract). This adapter implements:
 *   - the EIP-712 typed-data build (spec-correct domain + 8-decimal scaling),
 *   - validation,
 *   - the wallet signature path (only when a caller supplies a `sign` fn),
 *   - the wire format builder for the exchange API.
 * The actual network calls live in `hyperliquid-live.ts` (read/fetch/submit);
 * this module itself is pure and side-effect free and never auto-submits.
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

/** Hyperliquid's L1 core (Exchange) contract on Arbitrum — the EIP-712 verifying contract. */
export const HYPERLIQUID_CORE_ADDRESS: Address = "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7";

/** Public exchange submission endpoint (mainnet). */
export const HYPERLIQUID_EXCHANGE_URL = "https://api.hyperliquid.xyz/exchange";
/** Public info (read) endpoint (mainnet). */
export const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
/** Testnet variants — used for safe development/tool runs. */
export const HYPERLIQUID_TESTNET_EXCHANGE_URL = "https://api.hyperliquid-testnet.xyz/exchange";
export const HYPERLIQUID_TESTNET_INFO_URL = "https://api.hyperliquid-testnet.xyz/info";

/** Hyperliquid prices/sizes are transmitted as 8-decimal scaled integers. */
export const HYPERLIQUID_PX_SCALE = BigInt(100000000);

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
 * the listing order index rather than a ticker on the wire. This static map is a
 * fallback; `hyperliquid-live.ts` fetches the authoritative index from the meta
 * endpoint at execution time.
 */
export function hyperliquidAssetIndex(symbol: string): number {
  const s = (symbol || "").toUpperCase().replace(/-PERP$/, "");
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

/** Hyperliquid asset index lookup from a live `meta` universe (array position == index). */
export function assetIndexFromUniverse(universe: Array<{ name?: string }>, symbol: string): number {
  const s = (symbol || "").toUpperCase().replace(/-PERP$/, "");
  const ix = universe.findIndex((u) => (u.name || "").toUpperCase() === s);
  return ix >= 0 ? ix : 0;
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
 * Resolve the perp quantity in coin units, and the 8-decimal scaled wire values.
 * Prefers an explicit `sizePerp`; otherwise `sizeUsd / price`. Returns the
 * scaled `sz` (coin units * 1e8) and a human-readable coin quantity.
 */
export function resolveSz(order: PerpOrder): { szScaled: bigint; coinQty: number } {
  const scale = Number(HYPERLIQUID_PX_SCALE);
  let coinQty: number;
  if (order.sizePerp !== undefined && order.sizePerp > BigInt(0)) {
    coinQty = Number(order.sizePerp) / scale;
  } else if (order.price !== undefined && order.price > BigInt(0)) {
    // price is in micro-units (1e6 of the raw decimal) — convert to raw decimal first
    coinQty = order.sizeUsd / (Number(order.price) / 1_000_000);
  } else {
    coinQty = order.sizeUsd; // no price yet — caller should set one via live price
  }
  const clamped = Number.isFinite(coinQty) && coinQty > 0 ? coinQty : order.sizeUsd;
  return { szScaled: BigInt(Math.max(1, Math.round(clamped * scale))), coinQty: clamped };
}

/**
 * Build the EIP-712 typed payload for a Hyperliquid order with spec-correct
 * domain (name "Hyperliquid", version "1", chainId 42161, verifyingContract =
 * HyperliquidCore) and 8-decimal scaled `sz`/`limitPx` (uint64). Pure — no
 * signing side effects.
 */
export function buildTypedData(order: PerpOrder): TypedData {
  const symbol = (order.symbol ?? order.market).toUpperCase().replace(/-PERP$/, "");
  const { szScaled } = resolveSz(order);
  // price is in micro-units (1e6 of the raw decimal) — scale to Hyperliquid 8-decimal wire (1e8) with *100
  const priceMicro = order.price !== undefined && Number(order.price) > 0 ? Number(order.price) : 0;
  const priceScaled = priceMicro > 0 ? BigInt(Math.round(priceMicro * 100)) : BigInt(0);
  const domain = {
    name: "Hyperliquid",
    version: "1",
    chainId: order.chainId ?? 42161,
    verifyingContract: HYPERLIQUID_CORE_ADDRESS,
  };
  const message = {
    asset: order.assetIndex ?? hyperliquidAssetIndex(symbol),
    isBuy: order.isBuy,
    limitPx: priceScaled,
    sz: szScaled,
    reduceOnly: order.reduceOnly ?? false,
    orderType: order.price ? "limit" : "market",
    cloid: `hl-${symbol.toLowerCase()}-${order.isBuy ? "b" : "s"}-${(order.signer || "").toLowerCase().slice(0, 6)}-${Date.now().toString(36)}`,
  };
  return assembleTypedData({ primaryType: HYPERLIQUID_ORDER_TYPE, domain, types: HYPERLIQUID_ORDER_TYPES, message });
}

/**
 * Build the exchange API wire payload for a signed Hyperliquid order. Hyperliquid
 * expects the EIP-712 signature split into [r, s] (64 hex chars each), and the
 * action wrapping the scaled order. Pure — does not transmit.
 */
export function buildExchangeRequest(signed: SignedPerpOrder): {
  action: object;
  nonce: number;
  signature: [string, string];
  connectionId: string;
} {
  const t = buildTypedData(signed.order);
  const symbol = (signed.order.symbol ?? signed.order.market).toUpperCase().replace(/-PERP$/, "");
  const sig = signed.signature.replace(/^0x/, "");
  const r = sig.slice(0, 64);
  const s = sig.slice(64, 128);
  const isBuy = Boolean(t.message.isBuy);
  const tif = isBuy ? "Alo" : "Ioc";
  return {
    action: {
      type: "order",
      orders: [
        {
          a: Number(t.message.asset),
          b: isBuy,
          p: String(t.message.limitPx === BigInt(0) ? "0" : t.message.limitPx),
          s: String(t.message.sz),
          r: Boolean(t.message.reduceOnly),
          t: { limit: { tif } },
          c: t.message.cloid,
        },
      ],
    },
    nonce: Date.now(),
    signature: [r, s],
    connectionId: `meridian-${symbol}-${Date.now().toString(36)}`,
  };
}

function buildSubmission(signed: SignedPerpOrder): object {
  return buildExchangeRequest(signed);
}

export const hyperliquidAdapter: PerpAdapter = {
  venue: "hyperliquid",

  isMarketSupported(symbol: string): boolean {
    return HYPERLIQUID_MARKETS.has((symbol || "").toUpperCase().replace(/-PERP$/, ""));
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
    return { order, signature, expiresAt: Date.now() + 60_000 };
  },

  buildSubmission,
};
