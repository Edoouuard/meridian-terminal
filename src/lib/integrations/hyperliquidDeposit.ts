/**
 * integrations/hyperliquidDeposit.ts — fund a Hyperliquid account.
 *
 * Hyperliquid credits USDC sent on Arbitrum to its Bridge2 contract to the
 * sender's Hyperliquid account (perps margin) within about a minute. It is a
 * plain ERC-20 transfer, so it runs through Meridian's normal validated path;
 * two rules keep it safe:
 *   - only native USDC on Arbitrum — any other token sent to Bridge2 is lost;
 *   - at least 5 USDC — Hyperliquid does not credit smaller deposits.
 * Checked on-chain: Bridge2 holds code on Arbitrum and ~$400M of USDC.
 */

import type { Address } from "viem";

export const HYPERLIQUID_BRIDGE2: Address = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7";
export const HYPERLIQUID_DEPOSIT_CHAIN_ID = 42161;
export const ARBITRUM_USDC: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
/** Hyperliquid's minimum deposit, in USDC base units (6 decimals). Smaller deposits are lost. */
export const HYPERLIQUID_MIN_DEPOSIT = 5_000_000n;

export function isHyperliquidBridge(chainId: number, address: string | undefined): boolean {
  return chainId === HYPERLIQUID_DEPOSIT_CHAIN_ID && !!address && address.toLowerCase() === HYPERLIQUID_BRIDGE2.toLowerCase();
}

/** Why a transfer to Bridge2 must not be signed, or null when it's a valid deposit. */
export function hyperliquidDepositProblem(token: string | undefined, amount: bigint): string | null {
  if (!token || token.toLowerCase() !== ARBITRUM_USDC.toLowerCase()) {
    return "Hyperliquid's bridge only accepts native USDC on Arbitrum — any other token sent there is lost.";
  }
  if (amount < HYPERLIQUID_MIN_DEPOSIT) return "Hyperliquid's minimum deposit is 5 USDC — smaller deposits are not credited.";
  return null;
}
