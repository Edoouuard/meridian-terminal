/**
 * index.ts — public API of Meridian's perp-protocol integration layer.
 *
 * This module is the single entry point for routing a `PerpOrder` to a perp
 * venue. It is pure and side-effect free: it only re-exports types/registry and
 * points an order at the right venue adapter. Signing and submission are never
 * implicit — an adapter only signs when its caller explicitly passes a `sign`
 * callback, and no adapter transmits anything over the network.
 */

export * from "./types";
export * from "./registry";

export {
  hyperliquidAdapter,
  hyperliquidAssetIndex,
  buildTypedData as buildHyperliquidTypedData,
  HYPERLIQUID_ORDER_TYPE,
  HYPERLIQUID_ORDER_TYPES,
} from "./hyperliquid";
export { extendedAdapter, buildTypedData as buildExtendedTypedData } from "./extended";
export { variationalAdapter, buildTypedData as buildVariationalTypedData } from "./variational";
export { perplAdapter, PerpLSpecUnavailableError } from "./perpl";

import type { PerpAdapter, PerpOrder } from "./types";
import { getVenue } from "./registry";

/**
 * Route a `PerpOrder` to the adapter for its venue. Returns `undefined` if the
 * venue id is not registered. The returned adapter still needs an explicit
 * `sign` callback before anything is signed — routing alone performs no I/O.
 */
export function routePerpOrder(order: PerpOrder): PerpAdapter | undefined {
  return getVenue(order.venue);
}
