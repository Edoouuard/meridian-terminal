/**
 * coverage.ts — what Meridian executes, chain by chain, read from the tables
 * the execution code itself uses (pool addresses, verified vaults, routers),
 * so the count shown in the Chains tab can't drift from what really signs:
 * a protocol appears on a chain only where Meridian holds its contract.
 */

import { ACTIVE_CHAIN_IDS, AAVE_V3_POOL_BY_CHAIN, CHAIN_LABEL, COMPOUND_V3_USDC_COMET_BY_CHAIN, SPARK_POOL_BY_CHAIN } from "@/lib/onchain";
import { VAULTS } from "@/lib/protocols/vaults";
import { SWAP_LST_CHAINS, PROTOCOLS } from "@/lib/protocols/registry";
import { PENDLE_CHAINS } from "@/lib/integrations/pendle";
import { UNISWAP_SWAP_ROUTER02_BY_CHAIN } from "@/lib/integrations/uniswap";

const ETHEREUM = 1;

/** Morpho vaults are picked live (Philidor, Core tier or better) on the chains Morpho Blue is deployed on. */
const MORPHO_CHAINS = [1, 8453, 42161, 10, 137];

/** Perp venues Meridian trades through their own APIs (not chain contracts). */
export const PERP_VENUES = ["Hyperliquid", "Extended", "TxFlow"] as const;

export interface ChainCoverage {
  chainId: number;
  name: string;
  /** Protocols Meridian can sign into on this chain, by category then name. */
  protocols: string[];
}

export interface Coverage {
  chains: ChainCoverage[];
  /** Distinct protocols across all chains (bridges and swaps included). */
  protocols: string[];
}

const keysOf = (table: Record<number, unknown>) => Object.keys(table).map(Number);

export function executableCoverage(): Coverage {
  const on = new Map<number, Set<string>>(ACTIVE_CHAIN_IDS.map((id) => [id, new Set<string>()]));
  const add = (name: string, chains: Iterable<number>) => {
    for (const id of chains) on.get(id)?.add(name);
  };

  add("Aave", keysOf(AAVE_V3_POOL_BY_CHAIN));
  add("Spark", keysOf(SPARK_POOL_BY_CHAIN));
  add("Compound", keysOf(COMPOUND_V3_USDC_COMET_BY_CHAIN));
  add("Morpho", MORPHO_CHAINS);
  add("Pendle", PENDLE_CHAINS);
  add("Lido", [ETHEREUM]);
  add("Rocket Pool", [ETHEREUM]);
  add("Frax", [ETHEREUM]);
  add("EigenLayer", [ETHEREUM]);
  for (const v of VAULTS) add(v.protocol, [v.chainId]);
  for (const [slug, chains] of Object.entries(SWAP_LST_CHAINS)) add(PROTOCOLS[slug]?.name ?? slug, chains);
  add("Uniswap", keysOf(UNISWAP_SWAP_ROUTER02_BY_CHAIN));
  // Bridges between every pair of active chains (deBridge or LI.FI, whichever quotes best).
  add("LI.FI / deBridge", ACTIVE_CHAIN_IDS);

  const chains = ACTIVE_CHAIN_IDS.map((chainId) => ({ chainId, name: CHAIN_LABEL[chainId] ?? String(chainId), protocols: [...(on.get(chainId) ?? [])].sort((a, b) => a.localeCompare(b)) }));
  const protocols = [...new Set(chains.flatMap((c) => c.protocols))].sort((a, b) => a.localeCompare(b));
  return { chains, protocols };
}
