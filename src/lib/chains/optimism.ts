/**
 * optimism — Meridian per-chain protocol registry.
 *
 * Optimism is an EVM L2 (OP Stack) with the deepest Superchain DeFi depth
 * after Base. Aave is already readable via our wagmi setup, so it is marked
 * "read"; the rest are inventoried as "planned" with accurate data, to be
 * wired next. Pure data — no React.
 */
import type { ChainDef, ProtocolDef } from "./types";

export const OPTIMISM_PROTOCOLS: ProtocolDef[] = [
  {
    name: "Aave",
    category: "lending",
    status: "read",
    note: "Aave v3 Optimism market — readable via our existing wagmi reads.",
  },
  {
    name: "Synthetix",
    category: "perps",
    token: "SNX",
    status: "planned",
    note: "Synthetix Perps v3 — allowed perps exchange backing much of Optimism's perp liquidity; SNX vault.",
  },
  {
    name: "Velodrome",
    category: "dex",
    token: "VELO",
    status: "planned",
    note: "Solidly-style ve(3,3) DEX, long the core trading venue on Optimism; VELO voting gauges.",
  },
  {
    name: "Aerodrome",
    category: "dex",
    token: "AERO",
    status: "planned",
    note: "Velodrome's successor (vAMM/Solidly-style) is native to Base but also live on OP via the Superchain.",
  },
  {
    name: "Uniswap v3",
    category: "dex",
    status: "planned",
    note: "Canonical concentrated-liquidity DEX, deep ETH/USDC/OP pools on Optimism.",
  },
  {
    name: "Extra Finance",
    category: "perps",
    token: "EXTRA",
    status: "planned",
    note: "Leveraged farming / lending yield protocol built on OP (also on Base).",
  },
  {
    name: "Beefy",
    category: "yield",
    status: "planned",
    note: "Multi-chain yield optimizer auto-compounding OP vault positions.",
  },
  {
    name: "Sonne Finance",
    category: "lending",
    token: "SONNE",
    status: "planned",
    note: "Optimism-native Compound-fork money market, SONNE governance.",
  },
  {
    name: "Pendle",
    category: "yield",
    token: "PENDLE",
    status: "planned",
    note: "Yield tokenization — PT/YT split of principal vs yield (LRTs & LP points) on OP.",
  },
  {
    name: "Jumper",
    category: "aggregator",
    status: "planned",
    note: "Cross-chain DEX/bridge aggregator routing through Optimism liquidity.",
  },
];

export const OPTIMISM_CHAIN: ChainDef = {
  id: "optimism",
  name: "Optimism",
  isEvm: true,
  sdk: "wagmi/viem",
  walletAdapter: "wagmi",
  status: "supported",
  protocols: OPTIMISM_PROTOCOLS,
};
