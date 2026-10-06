/**
 * mcp/types.ts — Shared types for the Meridian routing layer.
 *
 * Every MCP provider (Haiku, deBridge, LI.FI, Base) returns data through
 * these common interfaces so the router can compare quotes, pick the best
 * route, and fallback transparently.
 */

import type { Address } from "viem";

// ─── Chain identifiers ──────────────────────────────────────────────

export const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  10: "Optimism",
  56: "BNB Chain",
  100: "Gnosis",
  137: "Polygon",
  146: "Sonic",
  250: "Fantom",
  324: "zkSync Era",
  1088: "Metis",
  5000: "Mantle",
  8453: "Base",
  42161: "Arbitrum",
  42220: "Celo",
  43114: "Avalanche",
  59144: "Linea",
  534352: "Scroll",
  7565164: "Solana",
};

// ─── Provider identification ────────────────────────────────────────

export type McpProviderId = "haiku" | "debridge" | "lifi" | "base";

export interface McpProviderStatus {
  id: McpProviderId;
  name: string;
  healthy: boolean;
  latencyMs: number | null;
  lastChecked: number;
}

// ─── Token & asset types ────────────────────────────────────────────

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
  chainId: number;
  name?: string;
  logoUri?: string;
  priceUsd?: number;
}

// ─── Route / quote types (cross-chain swap + bridge) ────────────────

export interface RouteQuote {
  provider: McpProviderId;
  fromToken: TokenInfo;
  toToken: TokenInfo;
  fromAmount: string;
  toAmount: string;
  toAmountUsd: number;
  /** Estimated gas + bridge fee in USD. */
  estimatedFeesUsd: number;
  /** Estimated time in seconds. */
  estimatedTimeSeconds: number;
  /** Provider-specific route data needed to execute. */
  routeData: unknown;
  /** Steps/hops in the route (for display). */
  steps: RouteStep[];
  /** Slippage applied (0..1). */
  slippage: number;
}

export interface RouteStep {
  type: "swap" | "bridge" | "approve";
  provider: string;
  fromToken: string;
  toToken: string;
  fromChainId: number;
  toChainId: number;
  estimatedTimeSeconds?: number;
}

/** A route request that all providers accept. */
export interface RouteRequest {
  fromChainId: number;
  toChainId: number;
  fromToken: Address;
  toToken: Address;
  /** Amount in base units (wei). */
  fromAmount: string;
  /** User wallet address. */
  userAddress: Address;
  /** Max slippage (0..1), defaults to 0.005 (0.5%). */
  slippage?: number;
}

// ─── Transaction types (unsigned, for signing client-side) ──────────

export interface UnsignedTx {
  to: Address;
  data: `0x${string}`;
  value: string;
  chainId: number;
  /** Gas limit estimate (hex string). */
  gasLimit?: string;
}

export interface RouteExecution {
  provider: McpProviderId;
  /** Ordered list of transactions to sign. */
  transactions: UnsignedTx[];
  /** Approval tx(s) if needed (before the main route tx). */
  approvals: UnsignedTx[];
}

// ─── Portfolio / position types (from Haiku aggregator) ─────────────

export interface ChainBalance {
  chainId: number;
  chainName: string;
  tokens: TokenBalance[];
  totalUsd: number;
}

export interface TokenBalance {
  token: TokenInfo;
  balance: string;
  balanceUsd: number;
}

export interface YieldPosition {
  protocol: string;
  chainId: number;
  type: "lending" | "staking" | "lp" | "vault";
  asset: string;
  depositedUsd: number;
  apy: number;
  rewardsUsd?: number;
}

export interface YieldOpportunity {
  protocol: string;
  chainId: number;
  asset: string;
  type: "lending" | "staking" | "lp" | "vault";
  apy: number;
  tvlUsd: number;
  riskScore?: number;
}

// ─── Execution status tracking ──────────────────────────────────────

export type TxStatus = "pending" | "confirming" | "confirmed" | "failed" | "expired";

export interface TxTracker {
  hash: string;
  chainId: number;
  status: TxStatus;
  provider: McpProviderId;
  /** For cross-chain: destination chain tx hash once bridged. */
  destinationHash?: string;
  destinationChainId?: number;
  createdAt: number;
  updatedAt: number;
}
