import type { Address } from "viem";

/**
 * Ethereum mainnet addresses, verified 2026-07-30 against bgd-labs/aave-address-book
 * (AaveV3Ethereum.sol / AaveV3Ethereum.ts) and Etherscan's verified stETH token page.
 * Wrong addresses here would silently misreport real money — double-check any change
 * against a second source before editing.
 */
export const AAVE_V3_POOL_ADDRESS: Address = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
export const STETH_ADDRESS: Address = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84";

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
