/**
 * variational.ts — Variational options/perp venue adapter (STUB).
 *
 * Variational runs an active points program (Omni points, ahead of a $VAR
 * TGE) and its RFQ perp/options product is real and trading today — but as
 * of this writing Variational has not shipped a public trading API: its own
 * docs describe the trading API as still in development and not yet
 * available to any (even first-party) integrator, with only public market
 * statistics exposed. There is no documented order format, signing scheme,
 * or submission endpoint to implement against.
 *
 * Earlier versions of this adapter modeled a plain EIP-712 "VariationalOrder"
 * signing scheme anyway — that was fabricated; nothing about it corresponds
 * to a real Variational endpoint. Per the same policy PerpL's stub documents:
 * an unknown venue spec is grounds for an explicit, refusing stub, never a
 * guessed-at scheme dressed up to look real. `signOrder` always throws;
 * `isMarketSupported` returns false. Swap this in for a real adapter once
 * Variational documents and ships a trading API.
 *
 * Pure and side-effect free — nothing is signed or submitted.
 */

import type { Address } from "viem";
import type { PerpAdapter, PerpOrder, PerpSignFunction, SignedPerpOrder, TypedData } from "./types";

export class VariationalApiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VariationalApiUnavailableError";
  }
}

/**
 * Variational has no public trading API yet, so there is no order format to
 * build. This throws rather than inventing one.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function buildTypedData(_order: PerpOrder): TypedData {
  throw new VariationalApiUnavailableError(
    "Variational has not published a trading API yet; refusing to fabricate an order format.",
  );
}

export const variationalAdapter: PerpAdapter = {
  venue: "variational",

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
    throw new VariationalApiUnavailableError(
      "Variational adapter is a stub — no public trading API exists yet to sign against.",
    );
  },

  buildSubmission(): object {
    throw new VariationalApiUnavailableError(
      "Variational adapter is a stub — no public trading API exists yet to submit to.",
    );
  },
};
