/**
 * RPC endpoints per active chain, tried in order (wagmi `fallback`):
 *   1. NEXT_PUBLIC_RPC_<CHAIN> — an explicit URL, when set;
 *   2. Alchemy, when NEXT_PUBLIC_ALCHEMY_API_KEY is set;
 *   3. Infura, when NEXT_PUBLIC_INFURA_API_KEY is set;
 *   4. public endpoints, so the app keeps working without any key.
 * viem's single public default per chain went down mid-session more than once
 * (BNB Chain's thirdweb endpoint, Ethereum's llamarpc), and reads and
 * pre-signature simulations depend on it.
 *
 * The provider keys are NEXT_PUBLIC: the browser reads the chain directly, so
 * they ship in the bundle like any frontend RPC key. Lock them down on the
 * provider side (Alchemy: allowlisted domains; Infura: allowlisted origins)
 * to Meridian's domains. Also used by the on-chain audit, so the audit reads
 * through the same endpoints the app does.
 */

type Env = Record<string, string | undefined>;

/** Subdomain per chain: https://<sub>.g.alchemy.com/v2/<key>. */
const ALCHEMY: Record<number, string> = {
  1: "eth-mainnet",
  8453: "base-mainnet",
  42161: "arb-mainnet",
  10: "opt-mainnet",
  137: "polygon-mainnet",
  43114: "avax-mainnet",
  56: "bnb-mainnet",
};

/** Subdomain per chain: https://<sub>.infura.io/v3/<key>. */
const INFURA: Record<number, string> = {
  1: "mainnet",
  8453: "base-mainnet",
  42161: "arbitrum-mainnet",
  10: "optimism-mainnet",
  137: "polygon-mainnet",
  43114: "avalanche-mainnet",
  56: "bsc-mainnet",
};

const PUBLIC: Record<number, { env: string; urls: string[] }> = {
  1: { env: "NEXT_PUBLIC_RPC_ETHEREUM", urls: ["https://ethereum-rpc.publicnode.com", "https://eth.merkle.io", "https://ethereum.reth.rs/rpc"] },
  8453: { env: "NEXT_PUBLIC_RPC_BASE", urls: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"] },
  42161: { env: "NEXT_PUBLIC_RPC_ARBITRUM", urls: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"] },
  10: { env: "NEXT_PUBLIC_RPC_OPTIMISM", urls: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"] },
  137: { env: "NEXT_PUBLIC_RPC_POLYGON", urls: ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"] },
  43114: { env: "NEXT_PUBLIC_RPC_AVALANCHE", urls: ["https://api.avax.network/ext/bc/C/rpc", "https://avalanche-c-chain-rpc.publicnode.com"] },
  56: { env: "NEXT_PUBLIC_RPC_BSC", urls: ["https://bsc-dataseed.bnbchain.org", "https://bsc-rpc.publicnode.com", "https://56.rpc.thirdweb.com"] },
};

const clean = (v: string | undefined) => v?.trim() || undefined;

/** Ordered endpoints for one chain under a given environment (pure; unit-tested). */
export function rpcUrlsFor(chainId: number, env: Env): string[] {
  const pub = PUBLIC[chainId];
  if (!pub) return [];
  const explicit = clean(env[pub.env]);
  const alchemy = clean(env.NEXT_PUBLIC_ALCHEMY_API_KEY);
  const infura = clean(env.NEXT_PUBLIC_INFURA_API_KEY);
  return [
    ...(explicit ? [explicit] : []),
    ...(alchemy && ALCHEMY[chainId] ? [`https://${ALCHEMY[chainId]}.g.alchemy.com/v2/${alchemy}`] : []),
    ...(infura && INFURA[chainId] ? [`https://${INFURA[chainId]}.infura.io/v3/${infura}`] : []),
    ...pub.urls,
  ];
}

// NEXT_PUBLIC_* are inlined at build time only when referenced literally.
const ENV: Env = {
  NEXT_PUBLIC_ALCHEMY_API_KEY: process.env.NEXT_PUBLIC_ALCHEMY_API_KEY,
  NEXT_PUBLIC_INFURA_API_KEY: process.env.NEXT_PUBLIC_INFURA_API_KEY,
  NEXT_PUBLIC_RPC_ETHEREUM: process.env.NEXT_PUBLIC_RPC_ETHEREUM,
  NEXT_PUBLIC_RPC_BASE: process.env.NEXT_PUBLIC_RPC_BASE,
  NEXT_PUBLIC_RPC_ARBITRUM: process.env.NEXT_PUBLIC_RPC_ARBITRUM,
  NEXT_PUBLIC_RPC_OPTIMISM: process.env.NEXT_PUBLIC_RPC_OPTIMISM,
  NEXT_PUBLIC_RPC_POLYGON: process.env.NEXT_PUBLIC_RPC_POLYGON,
  NEXT_PUBLIC_RPC_AVALANCHE: process.env.NEXT_PUBLIC_RPC_AVALANCHE,
  NEXT_PUBLIC_RPC_BSC: process.env.NEXT_PUBLIC_RPC_BSC,
};

export const RPC_URLS: Record<number, string[]> = Object.fromEntries(
  Object.keys(PUBLIC).map((id) => [Number(id), rpcUrlsFor(Number(id), ENV)]),
);
