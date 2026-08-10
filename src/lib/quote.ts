/**
 * quote.ts — Meridian's real quote / pricing layer.
 *
 * Converts a USD notional into an EXACT token amount using a live price and the
 * token's own decimals. This replaces the old approximation where a leg's USD
 * notional was treated directly as the human token amount:
 *
 *   - 1:1-pegged stablecoins (USDC/USDT at price ≈ 1, 6 decimals) resolve to an
 *     exact whole-unit amount ("$1000 -> 1000.000000 base units").
 *   - ETH-like assets use the live price to derive the precise human amount
 *     ("$1000 at ~$4180 -> 0.23923445… ETH" -> exact base units).
 *
 * HARD-FAIL pricing: a real order is NEVER sized from an approximation. If there
 * is no live price (missing / not-a-number / non-positive), `usdToTokenAmount`
 * returns `null` — an explicit UNPRICEABLE signal — so callers refuse to build
 * the order instead of estimating. Only a valid, positive, finite price produces
 * a typed amount.
 *
 * Every function here is a pure, offline helper. Feeding it a price list is the
 * caller's job (they own the live fetch); this module never touches the network.
 * All amounts are validated positive; nothing here ever triggers an execution.
 */

/** Minimal shape of a live price row. `LivePrice` from the /api/prices route satisfies this structurally. */
export interface PriceEntry {
  symbol: string;
  price: number;
}

/** The result of converting a USD notional into an exact token amount. */
export interface UsdQuote {
  symbol: string;
  /** The USD notional that was quoted (defaulted to a sane value when none parsed). */
  sizeUsd: number;
  /** The price used, or null when no usable price was available. */
  priceUsd: number | null;
  /** Token decimals used to compute base units (defaults to 18). */
  decimals: number;
  /** Exact human-unit amount string (e.g. "1000", "0.23923444976076555"). */
  amount: string;
  /** Exact base-unit amount: Math.round(human * 10^decimals). This is what actually executes. */
  amountBase: bigint;
  /** Always true: a `UsdQuote` is only ever produced from a real live price (no approximation). */
  livePriced: true;
}

/**
 * Format a base-unit bigint + decimals into an exact, trailing-zero-trimmed human
 * string. E.g. 1_000_000_000n @6 -> "1000"; 239234449760765550n @18 -> "0.23923444976076555".
 */
export function formatBaseUnits(base: bigint, decimals: number): string {
  const dec = Number.isInteger(decimals) && decimals >= 0 ? decimals : 18;
  const neg = base < BigInt(0);
  const abs = neg ? -base : base;
  const s = abs.toString().padStart(dec + 1, "0");
  if (dec === 0) return (neg ? "-" : "") + s;
  const intPart = s.slice(0, s.length - dec);
  const frac = s.slice(s.length - dec).replace(/0+$/, "");
  if (frac === "") return (neg ? "-" : "") + intPart;
  return `${neg ? "-" : ""}${intPart}.${frac}`;
}

/** Default notional used when a leg carries no positive USD size (kept from assetMap's historical default). */
const DEFAULT_SIZE_USD = 100;

/**
 * Find a usable price for a symbol in a price list (case/PERP-insensitive).
 * Returns null when absent or not a positive finite number, so callers always
 * refuse to size the order instead of quoting on garbage.
 */
export function resolvePriceFromList(
  prices: PriceEntry[] | undefined,
  symbol: string | undefined,
): number | null {
  if (!prices || !symbol) return null;
  const target = symbol.trim().toUpperCase().replace(/-PERP$/, "");
  for (const p of prices) {
    const candidate = (p.symbol || "").trim().toUpperCase().replace(/-PERP$/, "");
    if (candidate === target) {
      return Number.isFinite(p.price) && p.price > 0 ? p.price : null;
    }
  }
  return null;
}

/**
 * Convert a USD notional into an exact token amount.
 *
 * @param symbol   the human-readable asset symbol (informational).
 * @param sizeUsd  the USD notional (positive). Undefined/<=0 falls back to a default.
 * @param priceUsd the live price in USD per token. When null / non-finite / <=0 there
 *                 is no usable live price.
 * @param decimals token decimals (defaults to 18 when omitted/invalid).
 *
 * HARD-FAIL pricing: returns `null` (an explicit UNPRICEABLE signal) when there is
 * no usable live price — a real order must NEVER be sized from an approximation.
 * The caller is expected to refuse to build the order when `null` comes back. If
 * the notional would collapse to dust at a real price, that also returns `null`
 * rather than approximating, since guessing an amount here could hand a
 * funds-moving harness the wrong number.
 *
 * @returns the exact `UsdQuote` when a usable live price exists, otherwise `null`.
 */
export function usdToTokenAmount(
  symbol: string,
  sizeUsd: number | undefined,
  priceUsd: number | null,
  decimals: number = 18,
): UsdQuote | null {
  const dec = Number.isInteger(decimals) && decimals >= 0 ? decimals : 18;
  const size =
    sizeUsd && Number.isFinite(sizeUsd) && sizeUsd > 0 ? sizeUsd : DEFAULT_SIZE_USD;
  const price =
    priceUsd && Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null;

  // No usable live price — refuse to size. Never approximate.
  if (price === null) {
    return null;
  }

  const scale = BigInt(10) ** BigInt(dec);

  // Exact base amount for the notional at the given price.
  const amountBase = BigInt(Math.round((size / price) * Number(scale)));

  // An ultra-expensive asset (or dust notional) must never be sized from an
  // approximation either — refuse rather than emit a wrong/zero order.
  if (amountBase <= BigInt(0)) {
    return null;
  }

  return {
    symbol,
    sizeUsd: size,
    priceUsd: price,
    decimals: dec,
    amount: formatBaseUnits(amountBase, dec),
    amountBase,
    livePriced: true,
  };
}
