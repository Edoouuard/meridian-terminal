/**
 * Polygon — Meridian per-chain protocol registry.
 *
 * Polygon (MATIC/POL) is an EVM sidechain and historically one of DeFi's
 * busiest networks. Aave v3 is already readable via our wagmi setup, so it is
 * marked "read"; the rest are inventoried as "planned" with accurate data, to
 * be wired next. Pure data — no React.
 */
import type { ChainDef, ProtocolDef } from "./types";

export const POLYGON_PROTOCOLS: ProtocolDef[] = [
  {
    name: "Aave v3",
    category: "lending",
    status: "read",
    note: "Aave v3 Polygon market — readable via our existing wagmi reads (~$1B+ TVL).",
  },
  {
    name: "QuickSwap",
    category: "dex",
    token: "QUICK",
    status: "planned",
    note: "Polygon-native DEX (v3 concentrated + v2 style), QUICK governance; top TVL on chain.",
  },
  {
    name: "Uniswap v3",
    category: "dex",
    status: "planned",
    note: "Canonical concentrated-liquidity DEX, deep WMATIC/WETH/USDC pools on Polygon.",
  },
  {
    name: "Curve",
    category: "dex",
    status: "planned",
    note: "Stable-swap DEX with major Polygon pools (3pool, MIM, USDC/USDT).",
  },
  {
    name: "Balancer",
    category: "dex",
    token: "BAL",
    status: "planned",
    note: "Weighted/stable pool AMM and liquidity bootstrapping on Polygon.",
  },
  {
    name: "Gamma",
    category: "yield",
    token: "GAMMA",
    status: "planned",
    note: "Automated concentrated-liquidity strategies deploying into Polygon DEXs.",
  },
  {
    name: "Beefy",
    category: "yield",
    token: "BIFI",
    status: "planned",
    note: "Auto-compounding yield vaults spanning dozens of Polygon farms.",
  },
  {
    name: "KyberSwap",
    category: "aggregator",
    token: "KNC",
    status: "planned",
    note: "DEX aggregator (Elastic + Classic liquidity) active on Polygon.",
  },
  {
    name: "Stargate",
    category: "bridge",
    token: "STG",
    status: "planned",
    note: "Omnichain liquidity bridge with active Polygon-USDC routes.",
  },
  {
    name: "Jumper",
    category: "aggregator",
    status: "planned",
    note: "Cross-chain DEX/bridge aggregator routing through Polygon liquidity.",
  },
];

export const POLYGON_CHAIN: ChainDef = {
  id: "polygon",
  name: "Polygon",
  isEvm: true,
  sdk: "wagmi/viem",
  walletAdapter: "wagmi",
  status: "supported",
  protocols: POLYGON_PROTOCOLS,
};
