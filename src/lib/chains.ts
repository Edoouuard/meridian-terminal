/** Chain names as written by the LLM, DefiLlama and users → EVM chain ids. */
const CHAIN_NAME_TO_ID: Record<string, number> = {
  ethereum: 1, mainnet: 1, "ethereum mainnet": 1,
  optimism: 10, "op mainnet": 10, op: 10,
  "bnb chain": 56, bsc: 56, bnb: 56,
  gnosis: 100,
  polygon: 137,
  sonic: 146,
  fantom: 250,
  "zksync era": 324, zksync: 324,
  metis: 1088,
  mantle: 5000,
  base: 8453,
  arbitrum: 42161, "arbitrum one": 42161,
  celo: 42220,
  avalanche: 43114, "avalanche c-chain": 43114,
  linea: 59144,
  scroll: 534352,
};

export function chainIdFromName(name: string | undefined | null): number | undefined {
  if (!name) return undefined;
  return CHAIN_NAME_TO_ID[name.toLowerCase().trim()];
}

/**
 * The chain a plan leg executes on: the chain the plan names, falling back to
 * the wallet's current chain only when the leg doesn't name a known one.
 */
export function legChainId(leg: { chain?: string }, connectedChainId: number | undefined): number | undefined {
  return chainIdFromName(leg.chain) ?? connectedChainId;
}
