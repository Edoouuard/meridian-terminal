import type { Address } from "viem";

/**
 * Ethereum mainnet addresses, verified 2026-07-30 against bgd-labs/aave-address-book
 * (AaveV3Ethereum.sol / AaveV3Ethereum.ts) and Etherscan's verified stETH token page.
 * Wrong addresses here would silently misreport real money — double-check any change
 * against a second source before editing.
 */
export const AAVE_V3_POOL_ADDRESS: Address = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
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
 * Curated set of major ERC20s scanned via a single multicall per connected wallet.
 * There is no free way to discover "every token this address holds" from a plain RPC
 * without an indexer, so this list — not full auto-discovery — is the read-only v1
 * scope. Addresses verified 2026-07-30 against Etherscan token pages.
 */
export const TRACKED_TOKENS: TrackedToken[] = [
  { symbol: "stETH", address: STETH_ADDRESS, decimals: 18, priceSymbol: "ETH", venue: "Lido" },
  { symbol: "wstETH", address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", decimals: 18, priceSymbol: "WSTETH", venue: "Lido" },
  { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18, priceSymbol: "ETH", venue: "Wallet" },
  { symbol: "WBTC", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8, priceSymbol: "WBTC", venue: "Wallet" },
  { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
  { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, priceSymbol: "USDT", venue: "Wallet" },
  { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18, priceSymbol: "DAI", venue: "Wallet" },
  { symbol: "LINK", address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", decimals: 18, priceSymbol: "LINK", venue: "Wallet" },
  { symbol: "UNI", address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", decimals: 18, priceSymbol: "UNI", venue: "Wallet" },
];

export const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Aave v3 Pool.getUserAccountData — base-currency amounts are USD with 8 decimals on the Ethereum market. */
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
