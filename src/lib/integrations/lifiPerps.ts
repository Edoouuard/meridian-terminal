/**
 * lifiPerps.ts — Ondo Perps + Lighter live execution, via LI.FI's Perps SDK.
 *
 * Both venues run active points programs (Ondo: tokenized-equity perps,
 * "Ondo Points"; Lighter: zkLighter, integrated into Robinhood Wallet, $LIT
 * points) but neither is a simple "sign an EIP-712 order with your wallet"
 * venue like Hyperliquid: Ondo authenticates via SIWE + a per-request HMAC
 * trading key, and Lighter signs with its own curve through a bundled Go→WASM
 * signer. Rather than reimplement either scheme (the mistake the old
 * extended.ts/variational.ts adapters made), this depends on `@lifi/perps-sdk`
 * — LI.FI's TypeScript SDK, viem-native, with the Ondo/Lighter provider
 * source available to read (not just trust a README).
 *
 * ARCHITECTURAL NOTE, unlike Hyperliquid/Extended/Uniswap/Aave/Morpho/Lido
 * elsewhere in this app: order placement here is NOT purely direct-to-venue.
 * `PerpsClient` stages each action through LI.FI's own backend
 * (`createAction`/`executeAction`, default host `https://li.quest/v1/perps`):
 * the client builds the unsigned request, signs it locally (the SIWE
 * signature / HMAC secret / Stark key never leaves the browser), and submits
 * the SIGNED request back through LI.FI's backend, which relays it to
 * Ondo/Lighter. LI.FI cannot forge a different order — the signature covers
 * the request — but it does sit in the path as a relay, and its uptime
 * becomes a dependency for these two venues specifically.
 *
 * One shared `PerpsClient` instance registers both providers; each provider
 * manages its own credentials (SIWE session + HMAC key for Ondo, WASM-signed
 * API key for Lighter) via its own encrypted-localStorage adapter — see
 * `@lifi/perps-sdk-provider-ondo`/`-lighter`'s own doc comments.
 */

import {
  ActionType,
  OrderSide,
  OrderType,
  PerpsClient,
  getMarkets,
  type Market,
  type MarketRef,
} from "@lifi/perps-sdk";
import { ondoProvider } from "@lifi/perps-sdk-provider-ondo";
import { lighterProvider } from "@lifi/perps-sdk-provider-lighter";

export type LifiPerpsProviderId = "ondo" | "lighter";

export const LIFI_PROVIDER_LABEL: Record<LifiPerpsProviderId, string> = {
  ondo: "Ondo",
  lighter: "Lighter",
};

/** Shared client: both providers registered once, module-wide (mirrors registry.ts's singleton pattern). */
export const perpsClient = new PerpsClient({
  providers: [ondoProvider(), lighterProvider()],
});

export { ActionType, OrderSide, OrderType };

/**
 * Resolve a bare asset symbol (e.g. "TSLA", "SOL") to the provider's active
 * market + its `MarketRef` (opaque marketId/categoryId — never guessed).
 * Returns null when the venue lists no active market for that symbol, so
 * callers refuse to build an order rather than fabricating an id.
 */
export async function resolveLifiMarket(
  provider: LifiPerpsProviderId,
  symbol: string,
): Promise<{ market: Market; ref: MarketRef } | null> {
  const { markets } = await getMarkets(perpsClient.client, { provider });
  const target = (symbol || "").trim().toUpperCase();
  const match = markets.find(
    (m) => !m.isDelisted && m.baseAsset.displaySymbol.toUpperCase() === target,
  );
  if (!match) return null;
  return { market: match, ref: { marketId: match.id, categoryId: match.categoryId } };
}
