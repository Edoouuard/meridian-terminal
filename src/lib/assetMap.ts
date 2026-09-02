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
 *     quote layer (`src/lib/quote.ts`) and a caller-supplied live price list.
 *     With a live price the amount is exact (stablecoins peg to whole units;
 *     ETH-like assets divide by price); WITHOUT one the order is NOT sized at all
 *     — valuation is HARD-FAIL, never approximated.
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
  { venue: "Aave", side: "Borrow", orderType: "borrow", protocol: "aave" },
  { venue: "Aave", side: "Withdraw", orderType: "withdraw", protocol: "aave" },
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
 * Backed by the quote layer: when a live price is available for the asset we
 * divide the notional by the price and format to the token's decimals (exact for
 * 1:1 stablecoins, precise for ETH-like assets). When no price is available this
 * returns `""` — an exact amount cannot be derived, and `resolveOrderForLeg`
 * refuses to build the order rather than approximating.
 *
 * @param prices optional live price list (symbol -> price); used to quote the asset.
 * @param chainId optional target chain (defaults to `DEFAULT_CHAIN_ID`).
 */
export function humanAmountForLeg(leg: TradeLeg, prices?: PriceEntry[], chainId?: number): string {
  const symbol = bareSymbol(leg.asset);
  const price = resolvePriceFromList(prices, symbol);
  const decimals = tokenDecimalsFor(symbol, chainId);
  const quote = usdToTokenAmount(symbol, leg.sizeUsd, price, decimals);
  // HARD-FAIL: no live price -> no exact amount. Return "" rather than approximating.
  return quote ? quote.amount : "";
}

/** Decimals for a tracked token symbol on a chain, or 18 when unknown. */
function tokenDecimalsFor(symbol: string, chainId?: number): number {
  const token = findToken(symbol, chainId ?? DEFAULT_CHAIN_ID);
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
 * by price). When no live price is available the order is NOT sized at all and
 * this returns `{ unsupported }` — valuation hard-fails, never approximates.
 *
 * @param leg     the parsed trade leg (side / asset / protocol / sizeUsd)
 * @param address optional recipient address, required only for native `eth`
 *                transfers (used as the `to` of the order).
 * @param prices  optional live price list (symbol -> price) used to quote the
 *                asset exactly. Pass the fetched list from `/api/prices`.
 * @param chainId optional target chain id (the connected chain). When omitted,
 *                defaults to `DEFAULT_CHAIN_ID` (mainnet). The leg's token is
 *                resolved on THIS chain and the resulting order carries that
 *                chainId, so "supply USDC on Base" routes to Base's Aave pool
 *                + Base's USDC. unwired chains fall through to `{ unsupported }`.
 */
export function resolveOrderForLeg(
  leg: TradeLeg,
  address?: Address,
  prices?: PriceEntry[],
  chainId?: number,
): Order | { unsupported: string } {
  const protocol = (leg.protocol || "").toLowerCase().trim();
  const side = (leg.side || "").toLowerCase().trim();
  const resolveChainId = chainId ?? DEFAULT_CHAIN_ID;
  const venue = protocolLabel(leg.protocol);

  // Quote the leg's notional once. HARD-FAIL: `null` (no live price) means we
  // refuse to size the order rather than approximating the amount.
  const quoteFor = (symbol: string, decimals: number) =>
    usdToTokenAmount(symbol, leg.sizeUsd, resolvePriceFromList(prices, symbol), decimals);

  // --- Native L1 transfer (executable) -------------------------------------
  if (protocol === "eth" || side === "transfer") {
    if (!address) {
      return { unsupported: "Native transfer needs a recipient address; nothing wired here yet." };
    }
    const symbol = bareSymbol(leg.asset) || "ETH";
    const quote = quoteFor(symbol, 18);
    if (!quote) {
      return { unsupported: `No live price for ${symbol} — cannot size this order safely. Price feeds down?` };
    }
    return {
      type: "transfer",
      protocol: "eth",
      symbol,
      amount: quote.amountBase,
      chainId: resolveChainId,
      decimals: 18,
      to: address,
    };
  }

  // --- Aave v3 supply / repay (executable) ----------------------------------
  if (protocol === "aave") {
    const orderType: Order["type"] | undefined =
      side === "repay"
        ? "repay"
        : side === "supply"
          ? "supply"
          : side === "borrow"
            ? "borrow"
            : side === "withdraw"
              ? "withdraw"
              : side === "approve"
                ? "approve"
                : undefined;
    if (!orderType) {
      return { unsupported: `Aave ${leg.side} is not wired for live execution yet` };
    }
    const symbol = bareSymbol(leg.asset);
    const token = findToken(symbol, resolveChainId);
    if (!token) {
      return {
        unsupported: `Aave ${orderType} of "${symbol}" is not wired yet: "${symbol}" has no tracked ${resolveChainId === 1 ? "mainnet" : "chain " + resolveChainId} address.`,
      };
    }
    const quote = quoteFor(token.symbol, token.decimals);
    if (!quote) {
      return {
        unsupported: `No live price for ${token.symbol} — cannot size this order safely. Price feeds down?`,
      };
    }
    return {
      type: orderType,
      protocol: "aave",
      symbol: token.symbol,
      token: token.address,
      amount: quote.amountBase,
      chainId: resolveChainId,
      decimals: token.decimals,
    };
  }

  // --- Lido staking (executable, ETH only, mainnet only) --------------------
  if (protocol === "lido" && side === "stake") {
    const symbol = bareSymbol(leg.asset);
    if (symbol !== "ETH" && symbol !== "stETH") {
      return { unsupported: `Lido only stakes ETH — "${symbol}" is not supported.` };
    }
    if (resolveChainId !== 1) {
      return { unsupported: "Lido staking is only available on Ethereum mainnet — switch networks to stake." };
    }
    const quote = quoteFor("ETH", 18);
    if (!quote) {
      return { unsupported: "No live price for ETH — cannot size this order safely. Price feeds down?" };
    }
    return {
      type: "stake",
      protocol: "lido",
      symbol: "ETH",
      amount: quote.amountBase,
      chainId: resolveChainId,
      decimals: 18,
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
      return { unsupported: `Lido ${leg.side || "action"} not wired for live execution yet (staking ETH is; unstaking/withdrawal is not)` };
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

/**
 * Build the ERC20 `approve` order that must precede an Aave `supply` (Aave pulls
 * the tokens via allowance). Returns null when not applicable (non-Aave supply,
 * no token). The Execute UI runs this first, then the supply.
 */
export function approveOrderFor(order: Order): Order | null {
  if (order.protocol === "aave" && order.type === "supply" && order.token) {
    return {
      type: "approve",
      protocol: "aave",
      token: order.token,
      symbol: order.symbol,
      amount: order.amount,
      chainId: order.chainId,
      decimals: order.decimals,
    };
  }
  return null;
}
