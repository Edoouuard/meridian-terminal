/**
 * solana — Solana (non-EVM) chain & protocol registry.
 *
 * Solana runs its own VM and uses @solana/web3.js plus an SPL/algebraic
 * wallet adapter, entirely separate from the wagmi EVM stack. Meridian does
 * not have that runtime wired yet, so every protocol below is honestly
 * `planned`: we can inventory them accurately, but we cannot read balances
 * or positions today without the Solana SDK + RPC + wallet adapter.
 *
 * Pure data (no React). Order is roughly by protocol TVL.
 */

import type { ChainDef, ProtocolDef } from "./types";

export const SOLANA_PROTOCOLS: ProtocolDef[] = [
  {
    name: "Jito",
    category: "lst",
    token: "jitoSOL",
    status: "planned",
    note: "Largest SOL staking protocol on Solana; jitoSOL liquid staking + validator MEV. Needs Solana SDK + RPC.",
  },
  {
    name: "Marinade",
    category: "liquid-staking",
    token: "mSOL",
    status: "planned",
    note: "Pioneering liquid staking DAO on Solana (~$2B+ staked). Read needs solana runtime.",
  },
  {
    name: "Jupiter",
    category: "aggregator",
    token: "JUP",
    status: "planned",
    note: "The dominant DEX aggregator / routing layer on Solana. Needs Solana SDK to read.",
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
    status: "planned",
    note: "Core AMM / liquidity pool DEX on Solana (CLMM + constant product). Planned (non-EVM read).",
  },
  {
    name: "Drift",
    category: "perps",
    status: "planned",
    note: "Perpetuals futures DEX on Solana, one of the deepest perp books. Needs Solana SDK.",
  },
  {
    name: "Orca",
    category: "dex",
    token: "ORCA",
    status: "planned",
    note: "User-friendly concentrated-liquidity AMM on Solana. Planned (no solana runtime yet).",
  },
  {
    name: "Sanctum",
    category: "liquid-staking",
    status: "planned",
    note: "Unified liquid staking layer / infinity pool aggregating LSTs. Planned.",
  },
  {
    name: "Pyth Network",
    category: "oracle",
    token: "PYTH",
    status: "planned",
    note: "Solana-native (now cross-chain) price oracle; ~90 built-in price feeds. Planned.",
  },
  {
    name: "Jupiter Perps",
    category: "perps",
    token: "JLP",
    status: "planned",
    note: "Perpetual futures protocol run by Jupiter (JLP vault). Planned (same Solana gap).",
  },
];

export const SOLANA_CHAIN: ChainDef = {
  id: "solana",
  name: "Solana",
  isEvm: false,
  sdk: "@solana/web3.js",
  walletAdapter: "solana",
  status: "planned",
  protocols: SOLANA_PROTOCOLS,
};