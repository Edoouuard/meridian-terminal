import type { Address } from "viem";
import type { Order } from "@/lib/execution";
import type { TradeLeg } from "@/lib/tradePlan";
import { TRACKED_TOKENS_BY_CHAIN } from "@/lib/onchain";

/**
 * assetMap.ts — maps a parsed TradePlan leg to a concrete, wallet-executable
 * `Order` for `buildExecution` (the wagmi "hand"), and — just as important —
 * honestly reports which venues/sides are NOT wired for live execution yet.
 *
 * This is deliberately a thin, pure, offline layer:
 *   - It resolves a leg's asset symbol to an ERC20 address + decimals via
 *     `TRACKED_TOKENS_BY_CHAIN` (the canonical per-chain asset list).
 *   - It maps the leg's USD notional to a human-unit amount string. A real
 *     quote engine is out of scope, so the rule is simple and documented below.
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
 * Resolve a leg's USD notional into a human-unit amount string.
 *
 * SIMPLIFICATION (documented, out-of-scope to fix): a real quote engine does not
 * exist yet, so we treat the USD notional as the human token amount directly.
 * This is exact for 1:1 pegged stablecoins (USDC/USDT — $1 = 1 token) and a rough
 * placeholder for ETH-like assets until live pricing lands. When no size was
 * parsed we fall back to a small, demo-friendly default so the button still works.
 */
export function humanAmountForLeg(leg: TradeLeg): string {
  const size = leg.sizeUsd && leg.sizeUsd > 0 ? leg.sizeUsd : 100;
  return String(Math.round(size));
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
 * @param leg     the parsed trade leg (side / asset / protocol / sizeUsd)
 * @param address optional recipient address, required only for native `eth`
 *                transfers (used as the `to` of the order).
 */
export function resolveOrderForLeg(
  leg: TradeLeg,
  address?: Address,
): Order | { unsupported: string } {
  const protocol = (leg.protocol || "").toLowerCase().trim();
  const side = (leg.side || "").toLowerCase().trim();
  const chainId = DEFAULT_CHAIN_ID;
  const venue = protocolLabel(leg.protocol);

  // --- Native L1 transfer (executable) -------------------------------------
  if (protocol === "eth" || side === "transfer") {
    if (!address) {
      return { unsupported: "Native transfer needs a recipient address; nothing wired here yet." };
    }
    return {
      type: "transfer",
      protocol: "eth",
      symbol: bareSymbol(leg.asset) || "ETH",
      amount: humanAmountForLeg(leg),
      chainId,
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
    return {
      type: orderType,
      protocol: "aave",
      symbol: token.symbol,
      token: token.address,
      amount: humanAmountForLeg(leg),
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
