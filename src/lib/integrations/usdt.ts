import type { Address } from "viem";

/**
 * usdt.ts — USDT non-standard ERC20 approve workaround.
 *
 * Tether's USDT contract (on mainnet and most L2s) requires the existing
 * allowance to be 0 before a new non-zero allowance can be set. A direct
 * `approve(spender, newAmount)` reverts if the current allowance is > 0.
 *
 * The workaround is to first `approve(spender, 0)`, wait for it to mine,
 * then `approve(spender, amount)`. This module identifies which tokens
 * need this pattern so the execute flow can handle it automatically.
 */

/** Known USDT contract addresses across chains (lowercase for comparison). */
const USDT_ADDRESSES: Set<string> = new Set([
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // Ethereum mainnet
  "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", // Arbitrum
  "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58", // Optimism
  "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", // Polygon
  "0x55d398326f99059ff775485246999027b3197955", // BNB Chain
  "0x493257fd37edb34451f62edf8d2a0c418852ba4c", // zkSync Era
  "0xa219439258ca9da29e9cc4ce5596924745e12b93", // Linea
  "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", // Avalanche
]);

/**
 * Returns true if the given token address is a non-standard ERC20 that
 * requires an allowance reset to 0 before setting a new allowance.
 */
export function needsAllowanceReset(tokenAddress: Address | undefined): boolean {
  if (!tokenAddress) return false;
  return USDT_ADDRESSES.has(tokenAddress.toLowerCase());
}
