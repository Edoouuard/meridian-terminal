/**
 * lido.ts — Lido WithdrawalQueueERC721 integration (unstake ETH out of stETH).
 *
 * Lido unstaking is not instant: stETH is locked into a withdrawal request,
 * which is finalized by Lido's oracle (typically within a few days, bounded
 * by validator exit queue conditions Meridian doesn't control), and only
 * then can the ETH be claimed. This module covers all three steps —
 * request, status, claim — rather than only the request half, since a
 * request nobody can ever see the status of or claim isn't a closed loop.
 *
 * Address verified 2026-09 against Lido's own deployed-mainnet.json
 * (github.com/lidofinance/core) and confirmed live: an eth_call to
 * `STETH()` on this address returns exactly onchain.ts's STETH_ADDRESS.
 * Function signatures verified against the same repo's
 * contracts/0.8.9/WithdrawalQueue.sol. Wrong addresses here would silently
 * misroute real money — double-check any change against a second source.
 */

export const LIDO_WITHDRAWAL_QUEUE_ADDRESS = "0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1";

/** requestWithdrawals(uint256[] amounts, address owner) -> uint256[] requestIds. Pulls stETH via transferFrom — needs a prior approval. */
export const LIDO_REQUEST_WITHDRAWALS_ABI = [
  {
    type: "function",
    name: "requestWithdrawals",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_amounts", type: "uint256[]" },
      { name: "_owner", type: "address" },
    ],
    outputs: [{ name: "requestIds", type: "uint256[]" }],
  },
] as const;

/** getWithdrawalRequests(address owner) -> uint256[] — every request id (claimed or not) owned by this address. */
export const LIDO_GET_WITHDRAWAL_REQUESTS_ABI = [
  {
    type: "function",
    name: "getWithdrawalRequests",
    stateMutability: "view",
    inputs: [{ name: "_owner", type: "address" }],
    outputs: [{ name: "requestsIds", type: "uint256[]" }],
  },
] as const;

/** getWithdrawalStatus(uint256[] requestIds) -> WithdrawalRequestStatus[]. */
export const LIDO_GET_WITHDRAWAL_STATUS_ABI = [
  {
    type: "function",
    name: "getWithdrawalStatus",
    stateMutability: "view",
    inputs: [{ name: "_requestIds", type: "uint256[]" }],
    outputs: [
      {
        name: "statuses",
        type: "tuple[]",
        components: [
          { name: "amountOfStETH", type: "uint256" },
          { name: "amountOfShares", type: "uint256" },
          { name: "owner", type: "address" },
          { name: "timestamp", type: "uint256" },
          { name: "isFinalized", type: "bool" },
          { name: "isClaimed", type: "bool" },
        ],
      },
    ],
  },
] as const;

/** claimWithdrawal(uint256 requestId) — finds its own checkpoint hint; simplest claim path for one request at a time. */
export const LIDO_CLAIM_WITHDRAWAL_ABI = [
  {
    type: "function",
    name: "claimWithdrawal",
    stateMutability: "nonpayable",
    inputs: [{ name: "_requestId", type: "uint256" }],
    outputs: [],
  },
] as const;

export interface LidoWithdrawalRequest {
  id: bigint;
  amountOfStETH: bigint;
  timestamp: bigint;
  isFinalized: boolean;
  isClaimed: boolean;
}

/** A request is ready to claim once finalized and not yet claimed. */
export function isClaimable(req: LidoWithdrawalRequest): boolean {
  return req.isFinalized && !req.isClaimed;
}
