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
 * becomes a dependency for these two venues specifically. Reads (positions,
 * orders, account) bypass this — `getPositions` etc. are direct-to-venue.
 *
 * Each provider manages its own credentials (SIWE session + HMAC key for
 * Ondo, WASM-signed API key for Lighter) via its own encrypted-localStorage
 * adapter — see `@lifi/perps-sdk-provider-ondo`/`-lighter`'s own doc
 * comments. Those adapters are NOT keyed by environment, so a sandbox session
 * and a production session need separate `PerpsClient` instances — see
 * `getPerpsClient` below.
 *
 * SAFETY: Ondo defaults to its sandbox environment (see `useOndoEnv.ts`) —
 * production is only ever selected by an explicit user toggle. Lighter has no
 * testnet in this SDK (only its mainnet and Robinhood-Chain deployments are
 * exposed), so it is always real funds; the UI must say so plainly rather
 * than implying a safety net that doesn't exist.
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
import { ondoProvider, DEFAULT_ONDO_API_URL, ONDO_SANDBOX_API_URL } from "@lifi/perps-sdk-provider-ondo";
import { lighterProvider } from "@lifi/perps-sdk-provider-lighter";
import type { OndoEnv } from "@/hooks/useOndoEnv";

export type LifiPerpsProviderId = "ondo" | "lighter";

export const LIFI_PROVIDER_LABEL: Record<LifiPerpsProviderId, string> = {
  ondo: "Ondo",
  lighter: "Lighter",
};

const clientsByOndoEnv = new Map<OndoEnv, PerpsClient>();

/**
 * The shared `PerpsClient` for a given Ondo environment, built once and
 * memoized (Lighter's config never changes, so it rides along unchanged in
 * both instances). Sandbox and production get genuinely separate instances —
 * and therefore separate credential stores — since they're different Ondo
 * accounts, not the same account against two URLs.
 */
export function getPerpsClient(ondoEnv: OndoEnv): PerpsClient {
  const cached = clientsByOndoEnv.get(ondoEnv);
  if (cached) return cached;
  const client = new PerpsClient({
    providers: [
      ondoProvider(
        ondoEnv === "sandbox"
          ? { apiUrl: ONDO_SANDBOX_API_URL }
          : { apiUrl: DEFAULT_ONDO_API_URL },
      ),
      lighterProvider(),
    ],
  });
  clientsByOndoEnv.set(ondoEnv, client);
  return client;
}

export { ActionType, OrderSide, OrderType };

/**
 * Resolve a bare asset symbol (e.g. "TSLA", "SOL") to the provider's active
 * market + its `MarketRef` (opaque marketId/categoryId — never guessed).
 * Returns null when the venue lists no active market for that symbol, so
 * callers refuse to build an order rather than fabricating an id.
 */
export async function resolveLifiMarket(
  client: PerpsClient,
  provider: LifiPerpsProviderId,
  symbol: string,
): Promise<{ market: Market; ref: MarketRef } | null> {
  const { markets } = await getMarkets(client.client, { provider });
  const target = (symbol || "").trim().toUpperCase();
  const match = markets.find(
    (m) => !m.isDelisted && m.baseAsset.displaySymbol.toUpperCase() === target,
  );
  if (!match) return null;
  return { market: match, ref: { marketId: match.id, categoryId: match.categoryId } };
}
