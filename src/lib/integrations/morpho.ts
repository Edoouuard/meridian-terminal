/**
 * morpho.ts — Morpho vault (ERC-4626) execution support.
 *
 * Morpho Blue has no single canonical "pool" contract like Aave — deposits go
 * into one of hundreds of permissionless MetaMorpho vaults, each its own
 * ERC-4626 contract. Rather than hardcode a curated vault list (which would
 * go stale and can't rank by safety), Meridian resolves the vault to deposit
 * into at execute-time from Philidor's live vault risk data (see
 * philidor.ts / useVaultRisk) — the same top-scored vault the Vault Risk
 * panel already surfaces for the requested asset, filtered to the connected
 * wallet's chain and gated to a minimum risk score so an unvetted, low-scoring
 * vault is never silently picked for a one-click deposit.
 *
 * deposit()/withdraw() are the fixed EIP-4626 standard signatures — unlike
 * Uniswap/Aave's bespoke ABIs, these don't need per-deployment address
 * verification (the standard itself is the contract), only the vault
 * *address* (from Philidor) needs to be trustworthy, which the risk gate
 * below is for.
 */

/** Minimum acceptable Philidor risk score to auto-select a vault for deposit: Core tier or better (Prime 8.0-10, Core 5.0-7.9). Edge-tier vaults are never silently used. */
export const MIN_MORPHO_RISK_SCORE = 5;

/** EIP-4626 deposit(assets, receiver) -> shares. */
export const ERC4626_DEPOSIT_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
] as const;
