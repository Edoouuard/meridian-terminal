/**
 * solana — Solana (non-EVM) chain & protocol registry.
 *
 * Solana runs its own VM and uses @solana/web3.js plus an SPL/algebraic wallet
 * adapter, entirely separate from the wagmi EVM stack. Meridian now has the
 * Solana SDK + public mainnet RPC wired for READ (`src/lib/solana.ts` +
 * `src/hooks/useSolana.ts` + `SolanaPanel`): a user-supplied public key's SOL
 * and curated SPL-token balances are read directly (no wallet adapter needed
 * for read). Protocols whose token is in that curated SPL set are `read`;
 * execution / position-reading protocols (Jupiter Perps, Kamino, Drift perps
 * positions) remain honestly `planned`.
 *
 * Pure data (no React). Order is roughly by protocol TVL.
 */

import type { ChainDef, ProtocolDef } from "./types";

export const SOLANA_PROTOCOLS: ProtocolDef[] = [
  {
    name: "Jito",
    category: "lst",
    token: "jitoSOL",
    status: "read",
    note: "Largest SOL staking protocol on Solana; jitoSOL liquid staking + validator MEV. jitoSOL balance read via solana RPC.",
  },
  {
    name: "Marinade",
    category: "liquid-staking",
    token: "mSOL",
    status: "read",
    note: "Pioneering liquid staking DAO on Solana (~$2B+ staked). mSOL balance read via solana RPC.",
  },
  {
    name: "Jupiter",
    category: "aggregator",
    token: "JUP",
    status: "read",
    note: "The dominant DEX aggregator / routing layer on Solana. JUP balance read via solana RPC.",
  },
  {
    name: "Kamino",
    category: "money-market",
    status: "planned",
    note: "Leading lending / money-market + liquidity protocol on Solana. Requires solana wallet adapter.",
  },
  {
    name: "Raydium",
    category: "dex",
    token: "RAY",
    status: "read",
    note: "Core AMM / liquidity pool DEX on Solana (CLMM + constant product). RAY balance read via solana RPC.",
  },
  {
    name: "Drift",
    category: "perps",
    token: "DRIFT",
    status: "read",
    note: "Perpetuals futures DEX on Solana, one of the deepest perp books. DRIFT token balance read via solana RPC; perp positions still planned.",
  },
  {
    name: "Orca",
    category: "dex",
    token: "ORCA",
    status: "read",
    note: "User-friendly concentrated-liquidity AMM on Solana. ORCA balance read via solana RPC.",
  },
  {
    name: "Sanctum",
    category: "liquid-staking",
    status: "read",
    note: "Unified liquid staking layer / infinity pool aggregating LSTs. Solana token balance read via solana RPC.",
  },
  {
    name: "Pyth Network",
    category: "oracle",
    token: "PYTH",
    status: "read",
    note: "Solana-native (now cross-chain) price oracle; ~90 built-in price feeds. PYTH balance read via solana RPC.",
  },
  {
    name: "Jupiter Perps",
    category: "perps",
    token: "JLP",
    status: "planned",
    note: "Perpetual futures protocol run by Jupiter (JLP vault). Planned (requires solana wallet adapter).",
  },
];

export const SOLANA_CHAIN: ChainDef = {
  id: "solana",
  name: "Solana",
  isEvm: false,
  sdk: "@solana/web3.js",
  walletAdapter: "solana",
  status: "in-progress",
  protocols: SOLANA_PROTOCOLS,
};