/**
 * Public RPC endpoints per active chain, tried in order (wagmi `fallback`).
 * viem's single default per chain went down mid-session more than once (BNB
 * Chain's thirdweb endpoint, Ethereum's llamarpc), and reads and pre-signature
 * simulations depend on it. A dedicated provider can be put first through
 * NEXT_PUBLIC_RPC_<CHAIN> (Phase 2: Alchemy/Infura). Also used by the on-chain
 * audit, so the audit reads through the same endpoints the app does.
 */
const env = (v: string | undefined) => (v ? [v] : []);

export const RPC_URLS: Record<number, string[]> = {
  1: [...env(process.env.NEXT_PUBLIC_RPC_ETHEREUM), "https://ethereum-rpc.publicnode.com", "https://eth.merkle.io", "https://ethereum.reth.rs/rpc"],
  8453: [...env(process.env.NEXT_PUBLIC_RPC_BASE), "https://mainnet.base.org", "https://base-rpc.publicnode.com"],
  42161: [...env(process.env.NEXT_PUBLIC_RPC_ARBITRUM), "https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"],
  10: [...env(process.env.NEXT_PUBLIC_RPC_OPTIMISM), "https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"],
  137: [...env(process.env.NEXT_PUBLIC_RPC_POLYGON), "https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"],
  43114: [...env(process.env.NEXT_PUBLIC_RPC_AVALANCHE), "https://api.avax.network/ext/bc/C/rpc", "https://avalanche-c-chain-rpc.publicnode.com"],
  56: [...env(process.env.NEXT_PUBLIC_RPC_BSC), "https://bsc-dataseed.bnbchain.org", "https://bsc-rpc.publicnode.com", "https://56.rpc.thirdweb.com"],
};
