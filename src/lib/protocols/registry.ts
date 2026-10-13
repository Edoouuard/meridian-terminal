/**
 * protocols/registry.ts — the DeFi protocols Meridian covers, keyed by their
 * DefiLlama project slug.
 *
 * Coverage has two levels:
 *   - "execute": Meridian can build and sign the deposit itself (a dedicated
 *     integration, or a verified ERC-4626 vault from lib/protocols/vaults.ts);
 *   - "watch": the protocol is blue-chip enough to show its live rates for
 *     comparison, but Meridian doesn't sign into it (yet).
 * Slugs were taken from DefiLlama's live /pools data (projects with the most
 * single-asset stablecoin/ETH TVL on Meridian's 7 chains). Anything not
 * listed here is never shown: DefiLlama tracks thousands of pools, and an
 * unlisted protocol is unvetted by definition.
 */

import { VAULTS, type VaultEntry } from "@/lib/protocols/vaults";

export type ProtocolCategory = "lending" | "savings" | "staking" | "restaking" | "fixed" | "credit";

export interface ProtocolInfo {
  /** Name the planner and UI use; for executable ones, the protocol a leg names. */
  name: string;
  category: ProtocolCategory;
  /** Default coverage; a vault-backed protocol is executable only where a verified vault exists. */
  coverage: "execute" | "watch" | "vault";
}

export const PROTOCOLS: Record<string, ProtocolInfo> = {
  // Executable through dedicated integrations
  "aave-v3": { name: "Aave", category: "lending", coverage: "execute" },
  "compound-v3": { name: "Compound", category: "lending", coverage: "execute" },
  "morpho-blue": { name: "Morpho", category: "lending", coverage: "execute" },
  sparklend: { name: "Spark", category: "lending", coverage: "execute" },
  lido: { name: "Lido", category: "staking", coverage: "execute" },
  "rocket-pool": { name: "Rocket Pool", category: "staking", coverage: "execute" },
  pendle: { name: "Pendle", category: "fixed", coverage: "execute" },
  // Executable through verified ERC-4626 vaults
  "fluid-lending": { name: "Fluid", category: "lending", coverage: "vault" },
  "sky-lending": { name: "Sky", category: "savings", coverage: "vault" },
  "spark-savings": { name: "Spark Savings", category: "savings", coverage: "vault" },
  "ethena-usde": { name: "Ethena", category: "savings", coverage: "vault" },
  // Watched: live rates for comparison only
  maple: { name: "Maple", category: "credit", coverage: "watch" },
  "ether.fi-stake": { name: "ether.fi", category: "staking", coverage: "watch" },
  "binance-staked-eth": { name: "Binance wBETH", category: "staking", coverage: "watch" },
  "coinbase-wrapped-staked-eth": { name: "Coinbase cbETH", category: "staking", coverage: "watch" },
  kelp: { name: "Kelp", category: "restaking", coverage: "watch" },
  renzo: { name: "Renzo", category: "restaking", coverage: "watch" },
  "stakewise-v3": { name: "StakeWise", category: "staking", coverage: "watch" },
  "meth-protocol": { name: "Mantle mETH", category: "staking", coverage: "watch" },
  "liquid-collective": { name: "Liquid Collective", category: "staking", coverage: "watch" },
  "aave-v4": { name: "Aave v4", category: "lending", coverage: "watch" },
  "yearn-finance": { name: "Yearn", category: "savings", coverage: "watch" },
  "curve-llamalend": { name: "Curve LlamaLend", category: "lending", coverage: "watch" },
  "venus-core-pool": { name: "Venus", category: "lending", coverage: "watch" },
  "lista-lending": { name: "Lista", category: "lending", coverage: "watch" },
  dolomite: { name: "Dolomite", category: "lending", coverage: "watch" },
  "euler-v2": { name: "Euler", category: "lending", coverage: "watch" },
  "silo-v2": { name: "Silo", category: "lending", coverage: "watch" },
  "benqi-lending": { name: "Benqi", category: "lending", coverage: "watch" },
  "moonwell-lending": { name: "Moonwell", category: "lending", coverage: "watch" },
  "centrifuge-protocol": { name: "Centrifuge", category: "credit", coverage: "watch" },
};

/** DefiLlama chain name → chain id, for Meridian's 7 active chains. */
export const LLAMA_CHAIN_ID: Record<string, number> = {
  Ethereum: 1,
  Base: 8453,
  Arbitrum: 42161,
  Optimism: 10,
  Polygon: 137,
  Avalanche: 43114,
  BSC: 56,
};

export const STABLE_SYMBOLS = new Set(["USDC", "USDT", "USDT0", "USD₮0", "DAI", "USDS", "SUSDS", "SDAI", "USDE", "SUSDE", "GHO", "PYUSD", "USDC.E", "RLUSD", "USD1", "FDUSD", "CRVUSD", "FRAX"]);

export function assetKind(symbol: string): "stable" | "eth" | "other" {
  const s = symbol.toUpperCase();
  if (STABLE_SYMBOLS.has(s)) return "stable";
  if (/^(W?ETH|STETH|WSTETH|RETH|CBETH|WEETH|EZETH|RSETH|METH|WBETH|OSETH|LSETH|ETHX)$/.test(s)) return "eth";
  return "other";
}

/** The verified vault a DefiLlama pool corresponds to, if any. */
export function vaultForPool(project: string, chainId: number, symbol: string): VaultEntry | undefined {
  const sym = symbol.toUpperCase();
  return VAULTS.find((v) => v.llamaProject === project && v.chainId === chainId && v.llamaSymbol.toUpperCase() === sym);
}

/**
 * Whether Meridian can sign a deposit for this pool. Dedicated integrations
 * cover their protocol on the chains they're wired for (checked again at
 * execution); vault-backed protocols only where a verified vault matches.
 */
export function isExecutablePool(project: string, chainId: number, symbol: string): boolean {
  const info = PROTOCOLS[project];
  if (!info) return false;
  if (info.coverage === "execute") {
    if (project === "sparklend" || project === "lido" || project === "rocket-pool") return chainId === 1;
    if (project === "pendle") return chainId === 1 || chainId === 8453 || chainId === 42161;
    if (project === "morpho-blue") return chainId === 1 || chainId === 8453 || chainId === 42161;
    return true;
  }
  if (info.coverage === "vault") return vaultForPool(project, chainId, symbol) !== undefined;
  return false;
}
