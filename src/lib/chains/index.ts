/**
 * chains — aggregated Meridian chain × protocol coverage registry.
 *
 * Aggregates the per-chain registry modules (one per chain) into a single
 * `ALL_CHAINS` list that the terminal renders as a coverage map. Each chain's
 * protocols carry an honest `status` (live / read / planned) — see `types.ts`.
 */

import type { ChainDef, IntegrationStatus } from "./types";
import { ETHEREUM_CHAIN } from "./ethereum";
import { BASE_CHAIN } from "./base";
import { ARBITRUM_CHAIN } from "./arbitrum";
import { OPTIMISM_CHAIN } from "./optimism";
import { POLYGON_CHAIN } from "./polygon";
import { AVALANCHE_CHAIN } from "./avalanche";
import { HYPERLIQUID_CHAIN } from "./hyperliquid";
import { SOLANA_CHAIN } from "./solana";
import { RHX_CHAIN } from "./rhx";

/** Every chain Meridian tracks, with its per-chain protocol registry. */
export const ALL_CHAINS: ChainDef[] = [
  ETHEREUM_CHAIN,
  BASE_CHAIN,
  ARBITRUM_CHAIN,
  OPTIMISM_CHAIN,
  POLYGON_CHAIN,
  AVALANCHE_CHAIN,
  HYPERLIQUID_CHAIN,
  SOLANA_CHAIN,
  RHX_CHAIN,
];

/** Look up a chain by its id ("ethereum", "solana", ...). */
export function getChain(id: string): ChainDef | undefined {
  return ALL_CHAINS.find((c) => c.id === id);
}

/** Count how many protocols on a chain are at the given integration status. */
export function countStatus(chain: ChainDef, status: IntegrationStatus): number {
  return chain.protocols.filter((p) => p.status === status).length;
}

export * from "./types";
