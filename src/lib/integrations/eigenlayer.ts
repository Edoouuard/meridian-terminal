/**
 * integrations/eigenlayer.ts — restake stETH into EigenLayer (Ethereum only).
 *
 * A deposit goes through the StrategyManager into the stETH strategy and
 * mints restaking shares. Checked on a mainnet fork: deposits are open (the
 * StrategyManager and the strategy are unpaused, the strategy is whitelisted)
 * and a stETH deposit mints shares.
 *
 * What a deposit alone does NOT do: earn operator rewards. Those require
 * delegating the shares to an operator (DelegationManager.delegateTo), a
 * trust choice left to the user in the EigenLayer app. Withdrawals are
 * queued and take ~14 days. The UI says both before signing.
 */

import type { Address } from "viem";

export const EIGENLAYER_STRATEGY_MANAGER: Address = "0x858646372CC42E1A627fcE94aa7A7033e7CF075A";
export const EIGENLAYER_STETH_STRATEGY: Address = "0x93c4b944D05dfe6df7645A86cd2206016c51564D";
export const EIGENLAYER_DELEGATION_MANAGER: Address = "0x39053D51B77DC0d36036Fc1fCc8Cb819df8Ef37A";

/** StrategyManager.depositIntoStrategy(strategy, token, amount) → shares. */
export const EIGENLAYER_DEPOSIT_ABI = [
  {
    type: "function",
    name: "depositIntoStrategy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "strategy", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
] as const;

/** StrategyManager.stakerDepositShares(staker, strategy) — restaked shares, for the position view and the fork proof. */
export const EIGENLAYER_STAKER_SHARES_ABI = [
  {
    type: "function",
    name: "stakerDepositShares",
    stateMutability: "view",
    inputs: [
      { name: "staker", type: "address" },
      { name: "strategy", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** StrategyBase.sharesToUnderlyingView(shares) — what restaked shares are worth in stETH (portfolio). */
export const EIGENLAYER_SHARES_TO_UNDERLYING_ABI = [
  { type: "function", name: "sharesToUnderlyingView", stateMutability: "view", inputs: [{ name: "amountShares", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

export const EIGENLAYER_RISK_NOTE =
  "Restaked stETH earns operator rewards only once delegated to an operator (do that in the EigenLayer app), and withdrawing takes ~14 days through EigenLayer's queue.";
