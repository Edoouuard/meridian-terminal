import type { ChainDef, ProtocolDef } from "./types";

/**
 * Avalanche — Meridian chain × protocol registry.
 *
 * Avalanche is an EVM L1 (C-Chain) running its own Avalanche consensus, and a
 * first-class DeFi ecosystem. It uses the same wagmi/viem EVM stack as other
 * EVM chains, with the `wagmi` wallet adapter from the same code path.
 *
 * Protocols below are the ~10 largest on Avalanche by TVL. Aave v3 is marked
 * `read` because Meridian already reads Aave positions on Avalanche today; the
 * rest are accurately inventoried and marked `planned` to be wired next.
 */

export const AVALANCHE_PROTOCOLS: ProtocolDef[] = [
  {
    name: "Aave v3",
    category: "lending",
    status: "read",
    note: "Reference money market on Avalanche; we read Aave positions here today.",
  },
  {
    name: "Benqi",
    category: "lending",
    token: "QI",
    status: "planned",
    note: "Largest native Avalanche lending/money-market protocol (QI).",
  },
  {
    name: "GMX",
    category: "perps",
    status: "planned",
    note: "Flagship perp DEX also deployed on Avalanche; notable C-Chain TVL.",
  },
  {
    name: "Trader Joe",
    category: "dex",
    token: "JOE",
    status: "planned",
    note: "Native Avalanche AMM/DEX (JOE) and ecosystem anchor.",
  },
  {
    name: "Curve",
    category: "dex",
    status: "planned",
    note: "Stablecoin AMM factory deployed on Avalanche; core liquidity venue.",
  },
  {
    name: "Uniswap v3",
    category: "dex",
    status: "planned",
    note: "Primary onchain DEX/AMM deployed on Avalanche C-Chain.",
  },
  {
    name: "Balancer",
    category: "dex",
    status: "planned",
    note: "Weighted/stable pool AMM present on Avalanche with meaningful TVL.",
  },
  {
    name: "Beefy",
    category: "yield",
    status: "planned",
    note: "Yield auto-compounding vaults across Avalanche farm protocols.",
  },
  {
    name: "KyberSwap",
    category: "aggregator",
    status: "planned",
    note: "DEX aggregator routing through Avalanche liquidity.",
  },
  {
    name: "Pangolin",
    category: "dex",
    token: "PNG",
    status: "planned",
    note: "Pioneering Avalanche-native AMM/DEX (PNG).",
  },
];

export const AVALANCHE_CHAIN: ChainDef = {
  id: "avalanche",
  name: "Avalanche",
  isEvm: true,
  sdk: "wagmi/viem",
  walletAdapter: "wagmi",
  status: "supported",
  protocols: AVALANCHE_PROTOCOLS,
};
