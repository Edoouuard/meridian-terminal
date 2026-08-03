/**
 * registry.ts — registry of Meridian's perp venue adapters.
 *
 * Holds the canonical list of perp venues that the terminal can route orders to.
 * Pure and side-effect free: it is just a lookup structure plus helpers.
 */

import type { PerpAdapter, PerpVenueId } from "./types";
import { hyperliquidAdapter } from "./hyperliquid";
import { extendedAdapter } from "./extended";
import { variationalAdapter } from "./variational";
import { perplAdapter } from "./perpl";

/** All registered perp venues, keyed by venue id. */
export const PERP_VENUES: Record<PerpVenueId, PerpAdapter> = {
  hyperliquid: hyperliquidAdapter,
  extended: extendedAdapter,
  variational: variationalAdapter,
  perpl: perplAdapter,
};

/** Look up an adapter by venue id; `undefined` if the venue is unknown. */
export function getVenue(id: PerpVenueId): PerpAdapter | undefined {
  return PERP_VENUES[id];
}

/** List the registered venue adapters in a stable order. */
export function supportedVenues(): PerpAdapter[] {
  return (Object.keys(PERP_VENUES) as PerpVenueId[]).map((id) => PERP_VENUES[id]);
}
