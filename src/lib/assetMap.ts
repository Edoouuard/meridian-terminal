import type { Address } from "viem";
import type { Order } from "@/lib/execution";
import type { TradeLeg } from "@/lib/tradePlan";
import { TRACKED_TOKENS_BY_CHAIN } from "@/lib/onchain";
import {
  type PriceEntry,
  resolvePriceFromList,
  usdToTokenAmount,
} from "@/lib/quote";

/**
 * assetMap.ts — maps a parsed TradePlan leg to a concrete, wallet-executable
 * `Order` for `buildExecution` (the wagmi "hand"), and — just as important —
 * honestly reports which venues/sides are NOT wired for live execution yet.
 *
 * This is deliberately a thin, mostly-offline layer:
 *   - It resolves a leg's asset symbol to an ERC20 address + decimals via
 *     `TRACKED_TOKENS_BY_CHAIN` (the canonical per-chain asset list).
 *   - It maps the leg's USD notional to an exact human-unit amount using the
 *     quote layer (`src/lib/quote.ts`) and a caller-supplied live price list
 *     when available. With a live price the amount is exact (stablecoins peg to
 *     whole units; ETH-like assets divide by price); without one it falls back
 *     to the documented size≈amount approximation.
 *   - For venues that cannot execute yet (Hyperliquid/Extended perps, Pendle PT,
 *     options, swaps, staking, bridges, Aave borrow), it returns
 *     `{ unsupported: <message> }` instead of ever pretending to succeed.
 *
 * Nothing here ever triggers a write — it only produces data. The actual wallet
 * signature happens exclusively in `useExecute.execute()` on an explicit click.
 */

/** Default execution chain: mainnet. Assets are resolved here by default. */
export const DEFAULT_CHAIN_ID = 1;

/**
 * Venues that have a real, wallet-executable path wired through the harness.
 * Every other venue falls out of `resolveOrderForLeg` as `unsupported`.
 */
export const EXECUTABLE_VENUES: { venue: string; side: string; orderType: Order["type"]; protocol: Order["protocol"] }[] = [
  { venue: "Aave", side: "Supply", orderType: "supply", protocol: "aave" },
  { venue: "Aave", side: "Repay", orderType: "repay", protocol: "aave" },
  { venue: "L1", side: "Transfer", orderType: "transfer", protocol: "eth" },
];

/** Human-readable venue label for a protocol display string (e.g. "Hyperliquid"). */
export function protocolLabel(protocol: string | undefined): string {
  if (!protocol) return "This venue";
  return protocol;
}

/**
 * Resolve a leg's USD notional into an exact human-unit amount string.
 *
 * Now backed by the quote layer: when a live price is available for the asset we
 * divide the notional by the price and format to the token's decimals (exact for
 * 1:1 stablecoins, precise for ETH-like assets). When no price is available we
 * keep the historical approximation (USD notional ≈ token amount). When no size
 * was parsed we fall back to a small, demo-friendly default so the button works.
 *
 * @param prices optional live price list (symbol -> price); used to quote the asset.
 */
export function humanAmountForLeg(leg: TradeLeg, prices?: PriceEntry[]): string {
  const symbol = bareSymbol(leg.asset);
  const price = resolvePriceFromList(prices, symbol);
  const decimals = tokenDecimalsFor(symbol);
  return usdToTokenAmount(symbol, leg.sizeUsd, price, decimals).amount;
}

/** Decimals for a tracked token symbol on the default chain, or 18 when unknown. */
function tokenDecimalsFor(symbol: string): number {
  const token = findToken(symbol, DEFAULT_CHAIN_ID);
  return token ? token.decimals : 18;
}

/** Find a tracked token by symbol on a given chain (case-insensitive). */
function findToken(symbol: string, chainId: number) {
  const tokens = TRACKED_TOKENS_BY_CHAIN[chainId] ?? [];
  return tokens.find((t) => t.symbol.toLowerCase() === symbol.trim().toLowerCase());
}

/** Strip a PERP / PT / product suffix from an asset so we can match a token symbol ("ETH PERP" → "ETH"). */
function bareSymbol(asset: string): string {
  return asset
    .trim()
    .replace(/\s*(PERP|PT|perpetual)\s*$/i, "")
    .trim();
}

/**
 * Build a concrete `Order` for a parsed trade leg (Aave v3 supply/repay, or a
 * native L1 transfer), or `{ unsupported }` when the venue/side has no live
 * execution path yet. NEVER auto-executes — the caller decides when to sign.
 *
 * Amounts are quoted exactly via `src/lib/quote.ts`: when `prices` carries a
 * live price for the asset, the Order's amount is the precise base-unit bigint
 * for the USD notional (stablecoins peg to whole units; ETH-like assets divide
 * by price). When no price is available it falls back to the statistical
 * size≈amount approximation, so the button still works offline.
 *
 * @param leg     the parsed trade leg (side / asset / protocol / sizeUsd)
 * @param address optional recipient address, required only for native `eth`
 *                transfers (used as the `to` of the order).
 * @param prices  optional live price list (symbol -> price) used to quote the
 *                asset exactly. Pass the fetched list from `/api/prices`.
 */
export function resolveOrderForLeg(
  leg: TradeLeg,
  address?: Address,
  prices?: PriceEntry[],
): Order | { unsupported: string } {
  const protocol = (leg.protocol || "").toLowerCase().trim();
  const side = (leg.side || "").toLowerCase().trim();
  const chainId = DEFAULT_CHAIN_ID;
  const venue = protocolLabel(leg.protocol);

  // Quote the leg's notional once: live price when available, else approximation.
  const quoteFor = (symbol: string, decimals: number) =>
    usdToTokenAmount(symbol, leg.sizeUsd, resolvePriceFromList(prices, symbol), decimals);

  // --- Native L1 transfer (executable) -------------------------------------
  if (protocol === "eth" || side === "transfer") {
    if (!address) {
      return { unsupported: "Native transfer needs a recipient address; nothing wired here yet." };
    }
    const symbol = bareSymbol(leg.asset) || "ETH";
    const quote = quoteFor(symbol, 18);
    return {
      type: "transfer",
      protocol: "eth",
      symbol,
      amount: quote.amountBase,
      chainId,
      decimals: 18,
      to: address,
    };
  }

  // --- Aave v3 supply / repay (executable) ----------------------------------
  if (protocol === "aave") {
    const orderType: Order["type"] | undefined =
      side === "repay" ? "repay" : side === "supply" ? "supply" : undefined;
    if (!orderType) {
      return { unsupported: `Aave ${leg.side} is not wired for live execution yet` };
    }
    const symbol = bareSymbol(leg.asset);
    const token = findToken(symbol, chainId);
    if (!token) {
      return {
        unsupported: `Aave ${orderType} of "${symbol}" is not wired yet: "${symbol}" has no tracked ${chainId === 1 ? "mainnet" : "chain " + chainId} address.`,
      };
    }
    const quote = quoteFor(token.symbol, token.decimals);
    return {
      type: orderType,
      protocol: "aave",
      symbol: token.symbol,
      token: token.address,
      amount: quote.amountBase,
      chainId,
      decimals: token.decimals,
    };
  }

  // --- Directional / hedge / beta-neutral / options perps (NOT wired) -------
  if (side === "long" || side === "short" || side === "open" || /perp|option|call|put/i.test(leg.asset)) {
    return { unsupported: `${venue} perps not wired for live execution yet` };
  }

  // --- Every other known venue is deliberately not wired --------------------
  switch (protocol) {
    case "pendle":
      return { unsupported: "Pendle fixed-yield (PT) not wired for live execution yet" };
    case "lido":
      return { unsupported: "Lido staking not wired for live execution yet" };
    case "morpho":
      return { unsupported: "Morpho vaults not wired for live execution yet" };
    case "uniswap":
      return { unsupported: "Uniswap swaps not wired for live execution yet" };
    case "eigenlayer":
      return { unsupported: "EigenLayer restaking not wired for live execution yet" };
    case "bridge":
    case "cross-chain":
      return { unsupported: "Cross-chain bridging not wired for live execution yet" };
    default:
      return { unsupported: `${venue} is not wired for live execution yet` };
  }
}
