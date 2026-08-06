import type { ChainDef, ProtocolDef } from "./types";

/**
 * Arbitrum — Meridian chain × protocol registry.
 *
 * Arbitrum is an EVM L2 (Ethereum rollup) and the largest L2 by DeFi TVL.
 * It uses the same wagmi/viem EVM stack as Ethereum mainnet, with the
 * `bridged` wallet adapter from the same EVM code path.
 *
 * Protocols below are the ~10 largest on Arbitrum by TVL. Aave v3 is marked
 * `read` because Meridian already reads Aave positions on Arbitrum today; the
 * rest are accurately inventoried and marked `planned` to be wired next.
 */

export const ARBITRUM_PROTOCOLS: ProtocolDef[] = [
  {
    name: "Aave v3",
    category: "lending",
    status: "read",
    note: "Reference money market on Arbitrum; we read Aave positions here today.",
  },
  {
    name: "GMX",
    category: "perps",
    status: "planned",
    note: "Flagship perp DEX (GMX v2); one of the largest TVL protocols on Arbitrum.",
  },
  {
    name: "Uniswap v3",
    category: "dex",
    status: "planned",
    note: "Primary onchain DEX/AMM deployed on Arbitrum.",
  },
  {
    name: "Radiant Capital",
    category: "lending",
    status: "planned",
    note: "Omnichain lending / money market; significant Arbitrum TVL.",
  },
  {
    name: "Camelot",
    category: "dex",
    status: "planned",
    note: "Native Arbitrum AMM/DEX (GRAIL) with strong ecosystem standing.",
  },
  {
    name: "Pendle",
    category: "yield",
    status: "planned",
    note: "Yield-tokenization / PT-YT markets; sizable Arbitrum TVL.",
  },
  {
    name: "Stargate",
    category: "bridge",
    status: "planned",
    note: "Omnichain liquidity bridge (STG); top Arbitrum asset-transfer venue.",
  },
  {
    name: "Jumper",
    category: "aggregator",
    status: "planned",
    note: "Cross-chain / swap aggregator routing through Arbitrum liquidity.",
  },
  {
    name: "Thena",
    category: "dex",
    status: "planned",
    note: "Arbitrum-based DEX/AMM with ve(3,3) model.",
  },
  {
    name: "Vertex",
    category: "perps",
    status: "planned",
    note: "Orderbook-based perp DEX operating on Arbitrum.",
  },
];

export const ARBITRUM_CHAIN: ChainDef = {
  id: "arbitrum",
  name: "Arbitrum",
  isEvm: true,
  sdk: "wagmi/viem",
  walletAdapter: "wagmi",
  status: "supported",
  protocols: ARBITRUM_PROTOCOLS,
};
