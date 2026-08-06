/**
 * Base — Meridian per-chain protocol registry.
 *
 * Base is an EVM L2 and the primary home of Coinbase's DeFi ecosystem.
 * Aave is already readable via our wagmi setup and Morpho via our indexer,
 * so both are marked "read"; the rest are inventoried as "planned" with
 * accurate data, to be wired next. Pure data — no React.
 */
import type { ChainDef, ProtocolDef } from "./types";

export const BASE_PROTOCOLS: ProtocolDef[] = [
  {
    name: "Aerodrome",
    category: "dex",
    token: "AERO",
    status: "planned",
    note: "Dominant Base DEX (vAMM/Solidly-style), ~$1B+ TVL; AERO/slAERO gauges.",
  },
  {
    name: "Uniswap v3",
    category: "dex",
    status: "planned",
    note: "Canonical concentrated-liquidity DEX, deep ETH/USDC pools.",
  },
  {
    name: "BaseSwap",
    category: "dex",
    token: "BSWAP",
    status: "planned",
    note: "Native Base DEX aggregating liquidity + vesting/ve model, ~$50M TVL.",
  },
  {
    name: "Moonwell",
    category: "money-market",
    token: "WELL",
    status: "planned",
    note: "Base-native lending/borrowing fork of Compound, WELL governance.",
  },
  {
    name: "Compound v3",
    category: "lending",
    status: "planned",
    note: "Comet single-asset collateral model, active on Base with USDC market.",
  },
  {
    name: "Aave",
    category: "lending",
    status: "read",
    note: "Aave v3 Base market — readable via our existing wagmi reads.",
  },
  {
    name: "Morpho",
    category: "money-market",
    status: "read",
    note: "Permissionless lending vaults — readable via our indexer.",
  },
  {
    name: "Ethena",
    category: "stablecoin",
    token: "USDE/sUSDe",
    status: "planned",
    note: "Delta-neutral synthetic dollar; sUSDe yield on Base supported.",
  },
  {
    name: "Jumper",
    category: "aggregator",
    status: "planned",
    note: "Cross-chain DEX/bridge aggregator, routes through Base liquidity.",
  },
  {
    name: "Extra Finance",
    category: "perps",
    token: "EXTRA",
    status: "planned",
    note: "Leveraged yield/perp vaults and leveraged farming on Base.",
  },
];

export const BASE_CHAIN: ChainDef = {
  id: "base",
  name: "Base",
  isEvm: true,
  sdk: "wagmi/viem",
  walletAdapter: "wagmi",
  status: "supported",
  protocols: BASE_PROTOCOLS,
};