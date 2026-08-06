import type { ChainDef, ProtocolDef } from "./types";

/**
 * Ethereum (mainnet) — Meridian's primary chain.
 *
 * EVM via wagmi/viem; the top ~10 protocols by TVL are inventoried below.
 * Aave v3 is wired for real execution (supply/repay/borrow/withdraw);
 * Lido and Morpho are readable today (stETH balances / money-market
 * positions via indexer); the rest are accurately inventoried but planned.
 * Addresses are omitted deliberately until they are verifiable per deployment.
 */
export const ETHEREUM_PROTOCOLS: ProtocolDef[] = [
  {
    name: "Aave v3",
    category: "lending",
    status: "live",
    note: "Primary lending market on Ethereum; supply/repay/borrow/withdraw executed live.",
  },
  {
    name: "Lido",
    category: "liquid-staking",
    token: "stETH",
    status: "read",
    note: "Top liquid staking protocol; we track user stETH balances, not yet executing.",
  },
  {
    name: "Morpho",
    category: "money-market",
    status: "read",
    note: "Efficient lending via user-managed markets; positions read through the indexer.",
  },
  {
    name: "Uniswap v3",
    category: "dex",
    status: "planned",
    note: "Largest DEX on Ethereum; concentrated-liquidity swaps planned.",
  },
  {
    name: "Curve",
    category: "dex",
    status: "planned",
    note: "Stablecoin/pegged-asset DEX; deep liquidity, planned for swap routing.",
  },
  {
    name: "MakerDAO / Sky",
    category: "stablecoin",
    token: "DAI/USDS",
    status: "planned",
    note: "Stablecoin issuer (DAI/USDS) and the Sky ecosystem; balances planned.",
  },
  {
    name: "Pendle",
    category: "yield",
    status: "planned",
    note: "Tokenized yield / PT-YT markets; yield positions planned.",
  },
  {
    name: "EigenLayer",
    category: "restaking",
    status: "planned",
    note: "Largest restaking protocol; delegated staking positions planned.",
  },
  {
    name: "Ethena",
    category: "stablecoin",
    token: "USDe/sUSDe",
    status: "planned",
    note: "Delta-neutral synthetic dollar (USDe/sUSDe); balances planned.",
  },
  {
    name: "Compound",
    category: "lending",
    status: "planned",
    note: "Older but still significant money market; lending planned.",
  },
  {
    name: "dYdX",
    category: "perps",
    status: "planned",
    note: "Top on-chain perpetuals venue; perp positions planned.",
  },
];

export const ETHEREUM_CHAIN: ChainDef = {
  id: "ethereum",
  name: "Ethereum",
  isEvm: true,
  sdk: "wagmi/viem",
  walletAdapter: "wagmi",
  status: "supported",
  protocols: ETHEREUM_PROTOCOLS,
};
