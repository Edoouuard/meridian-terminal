/**
 * perpl.ts — PerpL perp venue adapter (STUB).
 *
 * PerpL is a generic perpetual venue. Its submission and signing specs are not
 * yet known to Meridian, so this adapter is an explicit STUB: it advertises the
 * common `PerpAdapter` surface but refuses to sign (the venue spec is unknown,
 * so we must not invent a signing scheme and pass it off as real). `signOrder`
 * always throws; `isMarketSupported` returns false. This placeholder keeps the
 * registry uniform so a real adapter can be dropped in once PerpL's API and
 * EIP-712 types are documented.
 *
 * Pure and side-effect free — nothing is signed or submitted.
 */

import type { Address } from "viem";
import type {
  PerpAdapter,
  PerpOrder,
  PerpSignFunction,
  SignedPerpOrder,
  TypedData,
} from "./types";

export class PerpLSpecUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PerpLSpecUnavailableError";
  }
}

/**
 * PerpL has no defined EIP-712 order type yet. This throws rather than inventing
 * a fake schema, so no order can ever be fraudulently "signed" as a PerpL order.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function buildTypedData(_order: PerpOrder): TypedData {
  throw new PerpLSpecUnavailableError(
    "PerpL order spec is not yet known; refusing to fabricate typed data",
  );
}

export const perplAdapter: PerpAdapter = {
  venue: "perpl",

  isMarketSupported(): boolean {
    return false;
  },

  maxLeverage(): number {
    return 1;
  },

  async signOrder(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _order: PerpOrder,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _signer: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _sign: PerpSignFunction,
  ): Promise<SignedPerpOrder> {
    throw new PerpLSpecUnavailableError(
      "PerpL adapter is a stub — signing is unsupported until the venue spec is known",
    );
  },

  buildSubmission(): object {
    throw new PerpLSpecUnavailableError(
      "PerpL adapter is a stub — submission is unsupported until the venue spec is known",
    );
  },
};
