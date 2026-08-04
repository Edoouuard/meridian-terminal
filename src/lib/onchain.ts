import type { Address } from "viem";
import { arbitrum, avalanche, base, mainnet, optimism, polygon } from "wagmi/chains";

export const SUPPORTED_CHAINS = [mainnet, base, arbitrum, optimism, polygon, avalanche] as const;

export const CHAIN_LABEL: Record<number, string> = {
  [mainnet.id]: "Ethereum",
  [base.id]: "Base",
  [arbitrum.id]: "Arbitrum",
  [optimism.id]: "Optimism",
  [polygon.id]: "Polygon",
  [avalanche.id]: "Avalanche",
};

/**
 * Aave v3 Pool addresses, verified 2026-07-30 against aave-dao/aave-address-book.
 * Arbitrum/Optimism/Polygon/Avalanche deliberately share one address — Aave deployed
 * those four via the same deterministic (CREATE2) factory and salt, confirmed by
 * fetching all four source files independently. Base and Ethereum were deployed
 * separately and have their own addresses. Wrong addresses here would silently
 * misreport real money — double-check any change against a second source.
 */
export const AAVE_V3_POOL_BY_CHAIN: Record<number, Address> = {
  [mainnet.id]: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  [base.id]: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  [arbitrum.id]: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  [optimism.id]: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  [polygon.id]: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  [avalanche.id]: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
};

export const STETH_ADDRESS: Address = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84";

export interface TrackedToken {
  symbol: string;
  address: Address;
  decimals: number;
  /** Which live-price symbol to value this token at (see src/app/api/prices/route.ts). */
  priceSymbol: string;
  venue: string;
}

/**
 * Curated set of major ERC20s per chain, scanned via one multicall per chain per
 * connected wallet. There is no free way to discover "every token this address
 * holds" from a plain RPC without a paid indexer, so this list — not full
 * auto-discovery — is the read-only v1 scope. Every address individually verified
 * 2026-07-30/07-31 against Etherscan/Basescan/Arbiscan/Optimistic Etherscan/
 * PolygonScan/Snowtrace token pages (or, for OP-stack WETH, the shared predeploy
 * spec at 0x4200...0006). Kept deliberately smaller on L2s than mainnet — only
 * tokens with one unambiguous canonical (not bridged-alias) address per chain.
 */
export const TRACKED_TOKENS_BY_CHAIN: Record<number, TrackedToken[]> = {
  [mainnet.id]: [
    { symbol: "stETH", address: STETH_ADDRESS, decimals: 18, priceSymbol: "ETH", venue: "Lido" },
    { symbol: "wstETH", address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", decimals: 18, priceSymbol: "WSTETH", venue: "Lido" },
    { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18, priceSymbol: "ETH", venue: "Wallet" },
    { symbol: "WBTC", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8, priceSymbol: "WBTC", venue: "Wallet" },
    { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
    { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, priceSymbol: "USDT", venue: "Wallet" },
    { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18, priceSymbol: "DAI", venue: "Wallet" },
    { symbol: "LINK", address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", decimals: 18, priceSymbol: "LINK", venue: "Wallet" },
    { symbol: "UNI", address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", decimals: 18, priceSymbol: "UNI", venue: "Wallet" },
  ],
  [base.id]: [
    { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
    { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18, priceSymbol: "ETH", venue: "Wallet" },
  ],
  [arbitrum.id]: [
    { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
    { symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6, priceSymbol: "USDT", venue: "Wallet" },
    { symbol: "WETH", address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18, priceSymbol: "ETH", venue: "Wallet" },
  ],
  [optimism.id]: [
    { symbol: "USDC", address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
    { symbol: "USDT", address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6, priceSymbol: "USDT", venue: "Wallet" },
    { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18, priceSymbol: "ETH", venue: "Wallet" },
  ],
  [polygon.id]: [
    { symbol: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
    { symbol: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6, priceSymbol: "USDT", venue: "Wallet" },
  ],
  [avalanche.id]: [
    { symbol: "USDC", address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
    { symbol: "USDT", address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6, priceSymbol: "USDT", venue: "Wallet" },
  ],
};

export const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Aave v3 Pool.getUserAccountData — base-currency amounts are USD with 8 decimals on every chain listed above. */
export const AAVE_POOL_ABI = [
  {
    type: "function",
    name: "getUserAccountData",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
  },
] as const;

/** Aave returns this sentinel (uint256 max) for healthFactor when the user has no debt. */
export const AAVE_NO_DEBT_HEALTH_FACTOR = BigInt(2) ** BigInt(256) - BigInt(1);

/**
 * Perp coins on Hyperliquid whose signed position size is treated as ETH delta
 * for the cross-venue net-delta / flatten metrics. Mirrors riskModel's
 * ETH_TRACKING_SYMBOLS, normalised to the uppercase, `-PERP`-stripped coin
 * strings the Hyperliquid API returns (e.g. "ETH", "ETH-PERP", "wstETH").
 */
export const PERP_ETH_COIN_SET: ReadonlySet<string> = new Set(["ETH", "WETH", "STETH", "WSTETH"]);

/** True if a Hyperliquid perp coin maps to ETH delta (long + / short - in coin units). */
export function perpCoinIsEth(coin: string): boolean {
  const base = (coin || "").toUpperCase().replace(/-PERP$/, "");
  return PERP_ETH_COIN_SET.has(base);
}
