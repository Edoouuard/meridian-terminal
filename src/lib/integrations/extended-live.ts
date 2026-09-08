/**
 * extended-live.ts — live network layer for Extended (ex-X10) perp orders.
 *
 * Extended is a perp DEX on Starknet/StarkEx: unlike Hyperliquid's plain
 * EIP-712 order signing, Extended settles orders with a StarkEx Pedersen/
 * Poseidon-hash signature over a Stark L2 keypair (SNIP-12). That scheme
 * cannot be produced by a browser wallet (MetaMask can't sign a Stark-curve
 * message), so this module depends on `@blackcube/extended-sdk` — a
 * TypeScript implementation of that signing scheme, built on the audited
 * `@noble`/`@scure` primitives, whose README documents it as validated
 * bit-for-bit against Extended's own Rust reference implementation and
 * accepted by Extended's real testnet order engine. Meridian does not
 * reimplement Stark-curve cryptography itself.
 *
 * The connected `Signer` (API key + Stark keypair + vault id) comes from
 * `useExtendedAccount` — the user's own Extended account, connected once via
 * the credentials Extended's dashboard already gives them. This module only
 * ever PLACES an order on explicit call; it never reads, transfers, or
 * withdraws.
 */

import { Extended, type Signer as ExtendedSigner, type Network as ExtendedNetwork } from "@blackcube/extended-sdk";
import { resolvePriceFromList, type PriceEntry } from "@/lib/quote";

/** Extended's market convention: hyphened base-quote against USD, e.g. "SOL" -> "SOL-USD". */
export function toExtendedMarket(symbol: string): string {
  const s = (symbol || "").toUpperCase().replace(/-PERP$/, "").replace(/-USD$/, "").trim();
  return `${s}-USD`;
}

/**
 * Format a positive quantity as a plain decimal string (no scientific
 * notation), trimmed of trailing zeros — the shape Extended's REST API wants
 * for `size`/`price`. Extended's own step-size validation is the real
 * precision check; this just avoids sending "1.23e-7"-style output.
 */
export function formatDecimal(n: number, maxDecimals = 8): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const fixed = n.toFixed(maxDecimals);
  const trimmed = fixed.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed || "0";
}

/**
 * Worst-case marketable limit price for an IOC "market" order: the live mid
 * shifted by a generous slippage buffer in the direction that guarantees a
 * fill. Extended's settlement signs a quote/fee amount computed FROM this
 * price, so — unlike a pure market order with no price at all — the signed
 * order actually bounds worst-case cost instead of defaulting to zero.
 */
export function worstCasePrice(mid: number, isBuy: boolean, slippageBps = 100): number {
  const factor = isBuy ? 1 + slippageBps / 10_000 : 1 - slippageBps / 10_000;
  return mid * factor;
}

export interface ExecuteExtendedParams {
  signer: ExtendedSigner;
  symbol: string;
  isBuy: boolean;
  /** USD notional to size from a live price. Ignored when `qtyOverride` is set. */
  sizeUsd: number;
  prices?: PriceEntry[];
  reduceOnly?: boolean;
  /**
   * Exact base-asset quantity to use verbatim instead of deriving one from
   * `sizeUsd` / a live price — for closing a known position exactly (a
   * price-derived qty would drift from the real position size).
   */
  qtyOverride?: number;
}

export interface ExecuteExtendedResult {
  ok: boolean;
  network: ExtendedNetwork;
  market: string;
  qty?: string;
  order?: unknown;
  error?: string;
}

/**
 * Execute an Extended perp order end to end: size the USD notional against a
 * caller-supplied live price (Meridian's own `/api/prices` feed — Extended's
 * own market data requires an API key, so this avoids a chicken-and-egg
 * fetch), build a worst-case-priced IOC order, and submit it through the SDK
 * (which resolves the market's on-chain scaling config, signs the StarkEx
 * settlement with the connected Stark key, and posts it). HARD-FAIL: refuses
 * to submit without a positive size and a live price — never approximates.
 */
export async function executeExtendedPerp(params: ExecuteExtendedParams): Promise<ExecuteExtendedResult> {
  const symbol = (params.symbol || "").toUpperCase().replace(/-PERP$/, "");
  const market = toExtendedMarket(symbol);
  const network = params.signer.network;

  const hasOverride = params.qtyOverride !== undefined;
  if (!hasOverride && !(Number.isFinite(params.sizeUsd) && params.sizeUsd > 0)) {
    return { ok: false, network, market, error: `Refusing to execute: notional size for ${symbol} must be positive. No order was built or signed.` };
  }
  if (hasOverride && !(Number.isFinite(params.qtyOverride) && (params.qtyOverride as number) > 0)) {
    return { ok: false, network, market, error: `Refusing to execute: quantity for ${symbol} must be positive.` };
  }

  const price = resolvePriceFromList(params.prices, symbol);
  if (price === null) {
    return { ok: false, network, market, error: `No live price for ${symbol} — cannot size this order safely. No order was built or signed.` };
  }

  const qty = hasOverride ? (params.qtyOverride as number) : params.sizeUsd / price;
  if (!(Number.isFinite(qty) && qty > 0)) {
    return { ok: false, network, market, error: `Computed a non-positive size for ${symbol} — refusing to submit.` };
  }
  const qtyStr = formatDecimal(qty);
  const limitPrice = formatDecimal(worstCasePrice(price, params.isBuy), 2);

  const dex = new Extended({ meridian: params.signer }, { default: "meridian" });
  try {
    const order = await dex.perp().place({
      name: market,
      side: params.isBuy ? "buy" : "sell",
      type: "market",
      size: qtyStr,
      price: limitPrice,
      tif: "ioc",
      reduceOnly: params.reduceOnly ?? false,
    });
    return { ok: true, network, market, qty: qtyStr, order };
  } catch (err) {
    return { ok: false, network, market, qty: qtyStr, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Read-only: the connected account's open perp positions on Extended. */
export async function fetchExtendedPositions(signer: ExtendedSigner) {
  const dex = new Extended({ meridian: signer }, { default: "meridian" });
  return dex.perp().getPositions();
}
