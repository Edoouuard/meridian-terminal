import type { Address } from "viem";

/**
 * mcp/routerAllowlist.ts — the ONLY trusted on-chain entrypoints Meridian
 * will ever sign a swap/bridge transaction against.
 *
 * Every other protocol integration in this codebase (Aave, Uniswap, Lido,
 * ...) signs against an address that comes from Meridian's OWN verified
 * allowlist (see lib/onchain.ts) — never from a third party at request
 * time. A deBridge/LI.FI quote breaks that pattern by construction: the
 * aggregator names its own `to` address dynamically per-route, and that
 * address does not originate from Meridian.
 *
 * To keep the exact same safety bar, every quote's `to` is cross-checked
 * against this allowlist before it is ever allowed to become a signable
 * ExecutionPlan (see execution.ts's "debridge"/"lifi" branch). A quote
 * whose `to` doesn't match is refused outright — never signed, regardless
 * of how plausible the rest of the quote looks.
 *
 * Addresses verified 2026-10 against each provider's own deployment
 * records (docs.li.fi/.../smart-contract-addresses, docs.debridge.com/
 * dln-details/overview/deployed-contracts) cross-checked against
 * independent block-explorer listings (Etherscan/Basescan/Arbiscan/
 * Optimistic Etherscan/PolygonScan, each independently labeling the same
 * address "LiFiDiamond" / "DlnSource"). Both providers deploy
 * deterministically (CREATE2/CREATE3), so the same address repeats across
 * chains — still verified per chain below, never assumed. A chain absent
 * from a map is NOT supported for that provider: never guess an address.
 */

/** LI.FI's "LiFiDiamond" entrypoint — verified on these 5 chains only. */
export const LIFI_DIAMOND_BY_CHAIN: Record<number, Address> = {
  1: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", // Ethereum
  8453: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", // Base
  42161: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", // Arbitrum
  10: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", // Optimism
  137: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", // Polygon
};

/** deBridge's "DlnSource" entrypoint (origin-chain side of a DLN order) — verified on these chains only. */
export const DEBRIDGE_DLN_SOURCE_BY_CHAIN: Record<number, Address> = {
  1: "0xeF4fB24aD0916217251F553c0596F8Edc630EB66", // Ethereum
  8453: "0xeF4fB24aD0916217251F553c0596F8Edc630EB66", // Base
  42161: "0xeF4fB24aD0916217251F553c0596F8Edc630EB66", // Arbitrum
  10: "0xeF4fB24aD0916217251F553c0596F8Edc630EB66", // Optimism
  137: "0xeF4fB24aD0916217251F553c0596F8Edc630EB66", // Polygon
};

/** True when `address` is the verified LI.FI entrypoint on `chainId`. */
export function isTrustedLifiEntrypoint(chainId: number, address: string): boolean {
  const trusted = LIFI_DIAMOND_BY_CHAIN[chainId];
  return !!trusted && trusted.toLowerCase() === address.toLowerCase();
}

/** True when `address` is the verified deBridge entrypoint on `chainId`. */
export function isTrustedDebridgeEntrypoint(chainId: number, address: string): boolean {
  const trusted = DEBRIDGE_DLN_SOURCE_BY_CHAIN[chainId];
  return !!trusted && trusted.toLowerCase() === address.toLowerCase();
}

/** Chains Meridian can route a swap/bridge through at all (either provider verified). */
export function isRoutingSupportedChain(chainId: number): boolean {
  return chainId in LIFI_DIAMOND_BY_CHAIN || chainId in DEBRIDGE_DLN_SOURCE_BY_CHAIN;
}
