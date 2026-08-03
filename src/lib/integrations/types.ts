/**
 * types.ts — shared types for Meridian's perp-protocol integration layer.
 *
 * Every perp venue (Hyperliquid, Extended, Variational, PerpL) is driven through
 * one common, offline, side-effect-free abstraction: an order is described as a
 * plain `PerpOrder`, the caller supplies a signature callback, and the adapter
 * returns a `SignedPerpOrder` ready for submission. Nothing here ever signs or
 * submits on its own — signing only happens when a caller explicitly passes a
 * `sign` function, and submission is a separate step performed by a future
 * network layer.
 *
 * This module is pure data + type definitions. It imports only viem's `Address`
 * type (erased at runtime) and never touches React or the network.
 */

import type { Address } from "viem";

/** The perp venues Meridian can route orders to. */
export type PerpVenueId = "hyperliquid" | "extended" | "variational" | "perpl";

/**
 * A protocol-agnostic perpetual order.
 *
 * `sizeUsd` is the human-readable notional in USD, kept as the shared ordering
 * notion across venues. `sizePerp` (optional) is the venue-native perp unit
 * quantity when the caller already knows it; adapters fall back to deriving it
 * from `sizeUsd` / `price`. `price` is a bigint in the venue's price precision.
 */
export interface PerpOrder {
  venue: PerpVenueId;
  /** Venue market id, e.g. "HYPE", "BTC-PERP", "ETH-PERP". */
  market: string;
  /** Canonical asset symbol (alias of market) used for venue lookups. */
  symbol?: string;
  /** true = buy/long, false = sell/short (or put for options venues). */
  isBuy: boolean;
  /** Notional size in USD (human readable). */
  sizeUsd: number;
  /** Venue-native perp unit quantity, when already known. */
  sizePerp?: bigint;
  /** Leverage multiplier; must respect the venue's bounds. */
  leverage?: number;
  /** Limit price in venue precision. Absent for market (IOC) orders. */
  price?: bigint;
  /** true = only reduce an existing position, never open/increase. */
  reduceOnly?: boolean;
  /** Chain/venue environment id the order is scoped to. */
  chainId?: number;
  /** Wallet that must authorize the order. */
  signer: Address;
}

/** A validated order plus the off-chain signature authorizing it. */
export interface SignedPerpOrder {
  order: PerpOrder;
  signature: `0x${string}`;
  /** Unix seconds; venues may reject orders past this. Optional. */
  expiresAt?: number;
}

/** A well-formed EIP-712 typed payload. */
export interface TypedData {
  primaryType: string;
  domain: Record<string, unknown>;
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  message: Record<string, unknown>;
}

/**
 * The signature provider Meridian calls to authorize an order. Callers wire this
 * to a wallet (e.g. viem's `signTypedData`) — Meridian itself never supplies it.
 */
export type PerpSignFunction = (msg: TypedData) => Promise<`0x${string}`>;

/** Result of order validation. */
export type ValidationResult = { ok: true } | { ok: false; error: string };

/**
 * The common adapter contract every venue implements. A venue adapter is a pure,
 * offline capability: it knows which markets it supports, how much leverage it
 * allows, how to turn a `PerpOrder` into venue-specific EIP-712 typed data and
 * (given a caller-supplied sign function) into a signed order, and how to shape
 * the final submission payload for a future network layer.
 *
 * No method performs network I/O or auto-submits anything.
 */
export interface PerpAdapter {
  venue: PerpVenueId;
  /** Whether this venue lists the given market symbol (e.g. "HYPE"). */
  isMarketSupported(symbol: string): boolean;
  /** Maximum leverage this venue allows for the given market. */
  maxLeverage(symbol: string): number;
  /**
   * Validate + sign an order. Requires an explicit `sign` callback and a
   * `signer`; never signs implicitly and never submits.
   */
  signOrder(
    order: PerpOrder,
    signer: Address,
    sign: PerpSignFunction,
  ): Promise<SignedPerpOrder>;
  /**
   * Shape a signed order into the venue's wire format, ready for a future
   * submission layer. Pure and offline — does not transmit anything.
   */
  buildSubmission(signed: SignedPerpOrder): object;
}

/* ------------------------------------------------------------------ *
 * Shared EIP-712 helpers (pure).
 * ------------------------------------------------------------------ */

/** Standard EIP-712 domain fields. */
export const EIP712_DOMAIN_TYPES: ReadonlyArray<{ name: string; type: string }> = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

const cloneTypes = (
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>,
) =>
  Object.fromEntries(
    Object.entries(types).map(([k, v]) => [k, v.map((f) => ({ ...f }))]),
  ) as Record<string, Array<{ name: string; type: string }>>;

/**
 * Assemble a well-formed EIP-712 typed payload from venue-specific pieces,
 * merging the standard `EIP712Domain` definition into `types`. Pure.
 */
export function assembleTypedData(params: {
  primaryType: string;
  domain: Record<string, unknown>;
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  message: Record<string, unknown>;
}): TypedData {
  return {
    primaryType: params.primaryType,
    domain: params.domain,
    types: {
      ...cloneTypes(params.types),
      EIP712Domain: EIP712_DOMAIN_TYPES.map((f) => ({ ...f })),
    },
    message: params.message,
  };
}
