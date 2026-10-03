/**
 * extended.ts — Extended (ex-X10) perp venue metadata.
 *
 * Extended is a perp DEX on Starknet/StarkEx. Earlier versions of this
 * adapter modeled Extended's order signing as plain EIP-712 (the same shape
 * as Hyperliquid's `PerpAdapter`) — that was wrong: Extended settles orders
 * with a StarkEx Pedersen/Poseidon-hash signature over a separate Stark L2
 * keypair, which a connected EVM wallet cannot produce on its own (no
 * `signTypedData` call reproduces it). Rather than keep a plausible-looking
 * but fabricated EIP-712 scheme around, this module now only advertises
 * market/leverage metadata; `signOrder`/`buildSubmission` refuse rather than
 * pretend the generic `PerpAdapter` shape applies here.
 *
 * The REAL, live implementation is `extended-live.ts`, built on
 * `@blackcube/extended-sdk` — a StarkEx SNIP-12 signer whose README documents
 * it as validated bit-for-bit against Extended's own Rust reference
 * implementation and accepted by Extended's real testnet order engine. Use
 * that (via `useExtendedAccount` / `useExtendedPerp` / ThreadCard's
 * `ExtendedPerpExecuteButton`) for actual execution.
 */

import type { Address } from "viem";
import type { PerpAdapter, PerpOrder, PerpSignFunction, SignedPerpOrder } from "./types";

const EXTENDED_MARKETS = new Set([
  "BTC",
  "BTC-PERP",
  "ETH",
  "ETH-PERP",
  "SOL",
  "SOL-PERP",
  "HYPE",
  "HYPE-PERP",
  "XRP",
  "XRP-PERP",
  "DOGE",
  "DOGE-PERP",
]);

/** Extended's conservative default max leverage. */
const EXTENDED_MAX_LEVERAGE = 20;

export class ExtendedSigningSchemeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtendedSigningSchemeError";
  }
}

export const extendedAdapter: PerpAdapter = {
  venue: "extended",

  isMarketSupported(symbol: string): boolean {
    return EXTENDED_MARKETS.has((symbol || "").toUpperCase());
  },

  maxLeverage(): number {
    return EXTENDED_MAX_LEVERAGE;
  },

  async signOrder(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _order: PerpOrder,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _signer: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _sign: PerpSignFunction,
  ): Promise<SignedPerpOrder> {
    throw new ExtendedSigningSchemeError(
      "Extended does not sign orders via plain EIP-712 (this generic PerpAdapter shape doesn't apply) — use executeExtendedPerp() from extended-live.ts, which signs with the connected account's Stark key instead.",
    );
  },

  buildSubmission(): object {
    throw new ExtendedSigningSchemeError(
      "Extended's wire format isn't built here — see extended-live.ts / executeExtendedPerp().",
    );
  },
};
