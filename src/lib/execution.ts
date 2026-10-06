import type { Abi, Address } from "viem";
import { parseUnits, zeroAddress } from "viem";
import { AAVE_V3_POOL_BY_CHAIN, CHAIN_LABEL, COMPOUND_V3_USDC_COMET_BY_CHAIN, STETH_ADDRESS, SPARK_POOL_BY_CHAIN, SDAI_VAULT, ROCKET_DEPOSIT_POOL, FRXETH_MINTER } from "./onchain";
import { SWAP_ROUTER02_EXACT_INPUT_SINGLE_ABI, UNISWAP_SWAP_ROUTER02_BY_CHAIN } from "./integrations/uniswap";
import { ERC4626_DEPOSIT_ABI, ERC4626_WITHDRAW_ABI } from "./integrations/morpho";
import {
  LIDO_CLAIM_WITHDRAWAL_ABI,
  LIDO_REQUEST_WITHDRAWALS_ABI,
  LIDO_WITHDRAWAL_QUEUE_ADDRESS,
} from "./integrations/lido";
import { isTrustedDebridgeEntrypoint, isTrustedLifiEntrypoint } from "./mcp/routerAllowlist";

/**
 * Execution layer for Meridian's DeFi terminal.
 *
 * `buildExecution(order)` turns a structured, protocol-agnostic `Order` (which can
 * be produced later by the trade planning engine from `tradePlan.ts`) into a
 * concrete, wallet-executable wagmi write plan (`ExecutionPlan`): the pool / token
 * address, the ABI, the function name and typed args, plus an optional native
 * `value`. Nothing here EVER auto-executes — this module is pure, serializable and
 * side-effect free. The actual wallet write only happens when a UI component
 * explicitly calls `execute()` on the `useExecute` hook, which is wired to a real
 * user mouse/keyboard click.
 *
 * The trade planner should emit amount in HUMAN units (a decimal string such as
 * "1000") or already-normalized base units (a bigint). `normalizeAmount` validates
 * and converts to base units, rejecting zero / negative / over-precise amounts.
 */

export type OrderType = "supply" | "repay" | "borrow" | "withdraw" | "transfer" | "approve" | "stake" | "swap" | "unstake" | "claim";
export type OrderProtocol = "aave" | "eth" | "erc20" | "lido" | "uniswap" | "morpho" | "compound" | "spark" | "maker" | "weth" | "rocketpool" | "frax" | "debridge" | "lifi" | "hyperliquid" | "extended" | "ondo" | "lighter" | "pendle" | "eigenlayer" | "variational";

/**
 * Protocol-agnostic order produced by the trade engine. Carries enough to build a
 * concrete write call; the trailing `[k: string]: unknown` index signature lets a
 * future `TradePlan` shape be passed straight through without a structural re-type.
 */
export interface Order {
  type: OrderType;
  protocol: OrderProtocol;
  /** ERC20 asset address (required for Aave supply/repay; the input token for a Uniswap swap; optional for native transfer). */
  token?: Address;
  symbol?: string;
  /** Amount in human units (decimal string) OR base units (bigint). */
  amount: bigint | string;
  chainId: number;
  /** Token decimals, used to parse human-unit strings. Defaults to 18. */
  decimals?: number;
  /** Recipient address for `eth` native transfers. */
  to?: Address;
  /** Spender for an `approve` (ERC20 allowance) order — defaults to the Aave pool / Uniswap router. */
  spender?: Address;
  /** Output token address for a Uniswap `swap` order. */
  tokenOut?: Address;
  /** Uniswap v3 fee tier (500/3000/10000) for a `swap` order. */
  fee?: number;
  /**
   * Minimum output base units a Uniswap `swap` will accept, derived from a
   * live on-chain quote just before signing. HARD-FAIL: buildExecution
   * refuses to build a swap plan without a positive value here — never
   * approximated, matching quote.ts's pricing discipline.
   */
  amountOutMinimum?: bigint;
  /** ERC-4626 vault contract address for a Morpho `supply`/`withdraw` order (resolved live from Philidor for supply, or from the user's own live position for withdraw). */
  vaultAddress?: Address;
  /** Lido withdrawal request id for a `claim` order (from getWithdrawalRequests / the request tx). */
  requestId?: bigint;
  /**
   * The unsigned transaction quoted by a router (deBridge/LI.FI) for a
   * `swap` order whose protocol is `"debridge"` or `"lifi"`. `to` is
   * cross-checked against routerAllowlist.ts before this can ever become a
   * signable plan — a quote naming any other address is refused outright.
   */
  routerTx?: { to: Address; data: `0x${string}`; value?: bigint };
  [k: string]: unknown;
}

/** A concrete, wallet-executable wagmi write plan. Pure data — never executes by itself. */
export interface ExecutionPlan {
  chainId: number;
  /** Contract to write to (Aave pool) or, for native transfers, the recipient. */
  address?: Address;
  abi?: Abi;
  functionName?: string;
  args?: readonly unknown[];
  /** Native value to send (only for `eth` transfers, payable calls, or a router's quoted tx). */
  value?: bigint;
  /**
   * Raw calldata for a pre-encoded call (a router's quoted tx) — used
   * instead of `abi`/`functionName`/`args` when the call isn't a typed
   * contract write Meridian itself encodes.
   */
  data?: `0x${string}`;
  /** Index into `args` holding the onBehalfOf/sender placeholder, patched at execution time. */
  senderIndex?: number;
  /**
   * Multiple flat `args` indices that all get patched to the same sender —
   * e.g. ERC-4626 `withdraw(assets, receiver, owner)` needs both `receiver`
   * and `owner` set to the connected wallet. Additive to `senderIndex`
   * (both may be set; every index across the two gets patched).
   */
  senderIndices?: number[];
  /**
   * When set, the sender is patched into this key of the object at
   * `args[senderIndex]` rather than replacing `args[senderIndex]` itself.
   * Needed for calls whose sender-carrying field lives inside a single
   * struct/tuple argument (e.g. Uniswap's `exactInputSingle(params)`,
   * whose `recipient` field is nested) rather than a flat positional arg
   * (e.g. Aave's `supply(asset, amount, onBehalfOf, referralCode)`).
   */
  senderTupleKey?: string;
  /** Human-readable summary shown in the UI before signing. */
  description: string;
  /** Safety warning surfaced to the user on every plan. */
  riskNote: string;
}

/**
 * Minimal Aave v3 Pool write ABI (supply). Aave already supplies only
 * `getUserAccountData` in `onchain.ts` (read paths); the write selector is defined
 * here locally so we never touch `onchain.ts`.
 *   supply(asset, amount, onBehalfOf, referralCode)
 */
export const AAVE_V3_POOL_SUPPLY_ABI = [
  {
    type: "function",
    name: "supply",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
] as const;

/**
 * Minimal Aave v3 Pool write ABI (repay).
 *   repay(asset, amount, interestRateMode, onBehalfOf)
 * `interestRateMode` 2 = variable, 1 = stable.
 */
export const AAVE_V3_POOL_REPAY_ABI = [
  {
    type: "function",
    name: "repay",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * Aave v3 Pool write ABI (withdraw).
 *   withdraw(asset, amount, to)
 */
export const AAVE_V3_POOL_WITHDRAW_ABI = [
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * Aave v3 Pool write ABI (borrow).
 *   borrow(asset, amount, interestRateMode, referralCode, onBehalfOf)
 */
export const AAVE_V3_POOL_BORROW_ABI = [
  {
    type: "function",
    name: "borrow",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "referralCode", type: "uint16" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [],
  },
] as const;

/**
 * Lido stETH `submit` — payable, mints stETH 1:1 for the ETH sent as `value`.
 *   submit(address _referral) payable returns (uint256)
 * The referral address is an optional Lido analytics tag; Meridian passes the
 * zero address (no referral program integration).
 */
export const LIDO_STETH_SUBMIT_ABI = [
  {
    type: "function",
    name: "submit",
    stateMutability: "payable",
    inputs: [{ name: "_referral", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * Compound III (Comet) `supply`/`withdraw` — verified against
 * compound-finance/comet's CometMainInterface.sol. Comet collapses what
 * Aave splits into 4 functions into just these 2: `supply(asset, amount)`
 * pays down debt first if any exists, otherwise adds to your supplied
 * balance (so it serves both Meridian's "supply" and "repay" order types);
 * `withdraw(asset, amount)` withdraws your supplied balance, or borrows
 * if it exceeds it (so it serves both "withdraw" and "borrow"). Neither
 * takes an onBehalfOf/to param — Comet always acts on/for msg.sender.
 */
export const COMET_SUPPLY_ABI = [
  {
    type: "function",
    name: "supply",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export const COMET_WITHDRAW_ABI = [
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/** WETH deposit() — wrap native ETH into WETH (payable, amount = msg.value). */
export const WETH_DEPOSIT_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
] as const;

/** WETH withdraw(wad) — unwrap WETH back to native ETH. */
export const WETH_WITHDRAW_ABI = [
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "wad", type: "uint256" }],
    outputs: [],
  },
] as const;

/** Rocket Pool RocketDepositPool.deposit() — payable, sends ETH, mints rETH to msg.sender. */
export const ROCKET_DEPOSIT_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
] as const;

/**
 * Frax frxETHMinter.submitAndDeposit(recipient) — payable, sends ETH,
 * mints frxETH, deposits into sfrxETH vault, sends sfrxETH to recipient.
 */
export const FRXETH_SUBMIT_AND_DEPOSIT_ABI = [
  {
    type: "function",
    name: "submitAndDeposit",
    stateMutability: "payable",
    inputs: [{ name: "recipient", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** ERC20 transfer(to, amount) — for sending ERC-20 tokens directly. */
export const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** ERC20 approve(spender, amount) — required before Aave can pull supply/repay assets. */
export const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** Aave's referralCode value for direct (non-integration) supplies. */
const AAVE_REFERRAL_CODE = BigInt(0);
/** Aave's variable interest-rate mode, used for repayments. */
const AAVE_INTEREST_RATE_MODE_VARIABLE = BigInt(2);

/**
 * Validate + normalize an amount to token base units. Accepts a human-unit decimal
 * string (e.g. "1000") or an already-base-unit bigint. Rejects zero, negative, and
 * values with more decimal places than the token supports.
 */
export function normalizeAmount(
  amount: bigint | string,
  decimals: number,
): { value: bigint } | { error: string } {
  if (!Number.isInteger(decimals) || decimals < 0) {
    return { error: `invalid token decimals '${decimals}'` };
  }
  let raw: bigint;
  if (typeof amount === "bigint") {
    raw = amount;
  } else if (typeof amount === "string") {
    const trimmed = amount.trim();
    const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
    if (!match) {
      return { error: `amount '${amount}' is not a valid non-negative decimal` };
    }
    // Reject over-precise fractions instead of silently rounding (a funds-moving
    // harness must never quietly alter the intended amount).
    const frac = match[2] ?? "";
    if (frac.length > decimals) {
      return { error: `amount '${amount}' exceeds the ${decimals}-decimal precision of this token` };
    }
    raw = parseUnits(trimmed, decimals);
  } else {
    return { error: "amount must be a bigint (base units) or a string (human units)" };
  }
  if (raw <= BigInt(0)) return { error: "amount must be positive" };
  return { value: raw };
}

function fail(message: string): { error: string } {
  return { error: message };
}

/**
 * Build a concrete, wallet-executable plan from a protocol-agnostic order.
 * Returns an `ExecutionPlan` or `{ error }`. Pure — never triggers a write.
 */
export function buildExecution(order: Order): ExecutionPlan | { error: string } {
  const chainId = Number(order.chainId);
  if (!Number.isFinite(chainId) || chainId <= 0) return fail(`invalid chainId '${order.chainId}'`);
  const chainLabel = CHAIN_LABEL[chainId] ?? `chain ${chainId}`;
  const decimals = order.decimals ?? 18;
  const assetLabel = order.symbol ?? "token";

  switch (order.protocol) {
    case "aave": {
      const pool = AAVE_V3_POOL_BY_CHAIN[chainId];
      if (!pool) return fail(`Aave v3 is not supported on ${chainLabel}`);
      const token = order.token;
      if (!token) return fail("aave order requires a token address");
      const amount = normalizeAmount(order.amount, decimals);
      if ("error" in amount) return amount;

      if (order.type === "repay") {
        return {
          chainId,
          address: pool,
          abi: AAVE_V3_POOL_REPAY_ABI,
          functionName: "repay",
          // [asset, amount, interestRateMode, onBehalfOf] — onBehalfOf is patched with
          // the connected sender by useExecute via `senderIndex`.
          args: [token, amount.value, AAVE_INTEREST_RATE_MODE_VARIABLE, zeroAddress],
          senderIndex: 3,
          description: `Repay ${order.amount} ${assetLabel} of Aave v3 debt (variable rate) on ${chainLabel}`,
          riskNote: `Moves real funds on ${chainLabel} — confirm the amount before signing. This reduces your open Aave debt.`,
        };
      }
      if (order.type === "supply") {
        return {
          chainId,
          address: pool,
          abi: AAVE_V3_POOL_SUPPLY_ABI,
          functionName: "supply",
          // [asset, amount, onBehalfOf, referralCode] — onBehalfOf patched by useExecute.
          args: [token, amount.value, zeroAddress, AAVE_REFERRAL_CODE],
          senderIndex: 2,
          description: `Supply ${order.amount} ${assetLabel} as collateral to Aave v3 on ${chainLabel}`,
          riskNote: `Moves real funds on ${chainLabel} — confirm the amount before signing. Your supply earns yield and can be used as collateral (subject to liquidation).`,
        };
      }
      if (order.type === "approve") {
        // ERC20 allowance so the pool can pull the asset (surfaces before supply/repay).
        const spender = (order.spender as Address | undefined) ?? pool;
        return {
          chainId,
          address: token,
          abi: ERC20_APPROVE_ABI,
          functionName: "approve",
          args: [spender, amount.value],
          description:
            spender === pool
              ? `Approve Aave v3 to spend up to ${order.amount} ${assetLabel} on ${chainLabel}`
              : `Approve ${spender.slice(0, 10)}… to spend up to ${order.amount} ${assetLabel} on ${chainLabel}`,
          riskNote: `Approval lets the spender transfer up to this amount of ${assetLabel}. Confirm the spender before signing.`,
        };
      }
      if (order.type === "withdraw") {
        return {
          chainId,
          address: pool,
          abi: AAVE_V3_POOL_WITHDRAW_ABI,
          functionName: "withdraw",
          args: [token, amount.value, zeroAddress], // `to` patched to the connected sender
          senderIndex: 2,
          description: `Withdraw ${order.amount} ${assetLabel} from Aave v3 on ${chainLabel}`,
          riskNote: `Withdraws ${assetLabel} collateral from Aave on ${chainLabel}. Watch your health factor — confirm before signing.`,
        };
      }
      if (order.type === "borrow") {
        return {
          chainId,
          address: pool,
          abi: AAVE_V3_POOL_BORROW_ABI,
          functionName: "borrow",
          args: [token, amount.value, AAVE_INTEREST_RATE_MODE_VARIABLE, AAVE_REFERRAL_CODE, zeroAddress],
          senderIndex: 4,
          description: `Borrow ${order.amount} ${assetLabel} against Aave collateral on ${chainLabel} (variable rate)`,
          riskNote: `Borrowing creates Aave debt on ${chainLabel} and lowers your health factor. Confirm before signing.`,
        };
      }
      return fail(`Aave v3 does not yet support order type '${order.type}'`);
    }

    case "compound": {
      const comet = COMPOUND_V3_USDC_COMET_BY_CHAIN[chainId];
      if (!comet) return fail(`Compound III's USDC market is not supported on ${chainLabel}`);
      const token = order.token;
      if (!token) return fail("compound order requires a token address");
      const amount = normalizeAmount(order.amount, decimals);
      if ("error" in amount) return amount;

      // Comet collapses supply/repay into one call and withdraw/borrow into
      // another (see COMET_SUPPLY_ABI's comment) — acts on msg.sender
      // directly, no onBehalfOf/to param to patch.
      if (order.type === "supply" || order.type === "repay") {
        return {
          chainId,
          address: comet,
          abi: COMET_SUPPLY_ABI,
          functionName: "supply",
          args: [token, amount.value],
          description:
            order.type === "repay"
              ? `Repay ${order.amount} ${assetLabel} of Compound III debt on ${chainLabel}`
              : `Supply ${order.amount} ${assetLabel} to Compound III on ${chainLabel}`,
          riskNote:
            order.type === "repay"
              ? `Moves real funds on ${chainLabel} — confirm the amount before signing. This reduces your open Compound III debt.`
              : `Moves real funds on ${chainLabel} — confirm the amount before signing. Your supply earns yield and can be borrowed against (subject to liquidation).`,
        };
      }
      if (order.type === "withdraw" || order.type === "borrow") {
        return {
          chainId,
          address: comet,
          abi: COMET_WITHDRAW_ABI,
          functionName: "withdraw",
          args: [token, amount.value],
          description:
            order.type === "borrow"
              ? `Borrow ${order.amount} ${assetLabel} against Compound III collateral on ${chainLabel}`
              : `Withdraw ${order.amount} ${assetLabel} from Compound III on ${chainLabel}`,
          riskNote:
            order.type === "borrow"
              ? `Borrowing creates Compound III debt on ${chainLabel} and lowers your borrowing capacity. Confirm before signing.`
              : `Withdraws ${assetLabel} from Compound III on ${chainLabel}. Watch your collateralization — confirm before signing.`,
        };
      }
      if (order.type === "approve") {
        const spender = (order.spender as Address | undefined) ?? comet;
        return {
          chainId,
          address: token,
          abi: ERC20_APPROVE_ABI,
          functionName: "approve",
          args: [spender, amount.value],
          description:
            spender === comet
              ? `Approve Compound III to spend up to ${order.amount} ${assetLabel} on ${chainLabel}`
              : `Approve ${spender.slice(0, 10)}… to spend up to ${order.amount} ${assetLabel} on ${chainLabel}`,
          riskNote: `Approval lets the spender transfer up to this amount of ${assetLabel}. Confirm the spender before signing.`,
        };
      }
      return fail(`Compound III does not yet support order type '${order.type}'`);
    }

    case "eth": {
      if (order.type !== "transfer") return fail(`Ethereum native only supports 'transfer', got '${order.type}'`);
      const to = order.to;
      if (!to) return fail("native transfer requires a 'to' address");
      const amount = normalizeAmount(order.amount, decimals);
      if ("error" in amount) return amount;
      return {
        chainId,
        address: to,
        value: amount.value,
        description: `Send ${order.amount} native ${CHAIN_LABEL[chainId] ?? "ETH"} to ${to} on ${chainLabel}`,
        riskNote: `Moves real funds on ${chainLabel} — confirm the recipient and amount before signing. Native transfers are irreversible once confirmed.`,
      };
    }

    case "erc20": {
      if (order.type !== "transfer") return fail(`ERC-20 transfer only supports 'transfer', got '${order.type}'`);
      const to = order.to;
      if (!to) return fail("ERC-20 transfer requires a 'to' address");
      const token = order.token;
      if (!token) return fail("ERC-20 transfer requires a token address");
      const amount = normalizeAmount(order.amount, decimals);
      if ("error" in amount) return amount;
      return {
        chainId,
        address: token,
        abi: ERC20_TRANSFER_ABI,
        functionName: "transfer",
        args: [to, amount.value],
        description: `Send ${order.amount} ${assetLabel} to ${to} on ${chainLabel}`,
        riskNote: `Moves real ${assetLabel} on ${chainLabel} — confirm the recipient and amount before signing. Token transfers are irreversible once confirmed.`,
      };
    }

    case "lido": {
      if (chainId !== 1) return fail(`Lido is only supported on Ethereum mainnet, not ${chainLabel}`);

      if (order.type === "stake") {
        const amount = normalizeAmount(order.amount, decimals);
        if ("error" in amount) return amount;
        return {
          chainId,
          address: STETH_ADDRESS,
          abi: LIDO_STETH_SUBMIT_ABI,
          functionName: "submit",
          args: [zeroAddress],
          value: amount.value,
          description: `Stake ${order.amount} ETH via Lido on ${chainLabel} for stETH`,
          riskNote: `Moves real ETH on ${chainLabel} and mints stETH 1:1 — unwinding later goes through Lido's own withdrawal queue, not an instant reverse. Confirm the amount before signing.`,
        };
      }

      if (order.type === "approve") {
        const spender = (order.spender as Address | undefined) ?? LIDO_WITHDRAWAL_QUEUE_ADDRESS;
        const amount = normalizeAmount(order.amount, decimals);
        if ("error" in amount) return amount;
        return {
          chainId,
          address: STETH_ADDRESS,
          abi: ERC20_APPROVE_ABI,
          functionName: "approve",
          args: [spender, amount.value],
          description: `Approve Lido's withdrawal queue to spend up to ${order.amount} stETH on ${chainLabel}`,
          riskNote: `Approval lets the withdrawal queue transfer up to this amount of stETH. Confirm before signing.`,
        };
      }

      if (order.type === "unstake") {
        const amount = normalizeAmount(order.amount, decimals);
        if ("error" in amount) return amount;
        return {
          chainId,
          address: LIDO_WITHDRAWAL_QUEUE_ADDRESS,
          abi: LIDO_REQUEST_WITHDRAWALS_ABI,
          functionName: "requestWithdrawals",
          // [amounts, owner] — owner patched to the connected sender by useExecute via `senderIndex`.
          args: [[amount.value], zeroAddress],
          senderIndex: 1,
          description: `Request withdrawal of ${order.amount} stETH from Lido on ${chainLabel}`,
          riskNote: `This locks your stETH into Lido's withdrawal queue — it is not instant. Once the queue finalizes your request (Lido's oracle, typically a few days), come back and claim the ETH.`,
        };
      }

      if (order.type === "claim") {
        const requestId = order.requestId;
        if (requestId === undefined) return fail("lido claim requires a requestId");
        return {
          chainId,
          address: LIDO_WITHDRAWAL_QUEUE_ADDRESS,
          abi: LIDO_CLAIM_WITHDRAWAL_ABI,
          functionName: "claimWithdrawal",
          args: [requestId],
          description: `Claim finalized Lido withdrawal request #${requestId} on ${chainLabel}`,
          riskNote: `Sends the finalized ETH from this request to your wallet. Only works once the request is finalized.`,
        };
      }

      return fail(`Lido does not yet support order type '${order.type}'`);
    }

    case "uniswap": {
      const token = order.token;
      if (!token) return fail("uniswap order requires a token address");
      const amount = normalizeAmount(order.amount, decimals);
      if ("error" in amount) return amount;
      const router = UNISWAP_SWAP_ROUTER02_BY_CHAIN[chainId];
      if (!router) return fail(`Uniswap v3 is not supported on ${chainLabel}`);

      if (order.type === "approve") {
        const spender = (order.spender as Address | undefined) ?? router;
        return {
          chainId,
          address: token,
          abi: ERC20_APPROVE_ABI,
          functionName: "approve",
          args: [spender, amount.value],
          description:
            spender === router
              ? `Approve Uniswap v3 to spend up to ${order.amount} ${assetLabel} on ${chainLabel}`
              : `Approve ${spender.slice(0, 10)}… to spend up to ${order.amount} ${assetLabel} on ${chainLabel}`,
          riskNote: `Approval lets the spender transfer up to this amount of ${assetLabel}. Confirm the spender before signing.`,
        };
      }

      if (order.type === "swap") {
        const tokenOut = order.tokenOut;
        const fee = order.fee;
        if (!tokenOut) return fail("uniswap swap requires a tokenOut address");
        if (!fee) return fail("uniswap swap requires a fee tier");
        const amountOutMinimum = order.amountOutMinimum;
        // HARD-FAIL: never sign a swap without a positive minimum received,
        // derived from a live on-chain quote. No fallback, no approximation.
        if (amountOutMinimum === undefined || amountOutMinimum <= BigInt(0)) {
          return fail("uniswap swap requires a positive amountOutMinimum from a live quote — refusing to swap without slippage protection");
        }
        return {
          chainId,
          address: router,
          abi: SWAP_ROUTER02_EXACT_INPUT_SINGLE_ABI,
          functionName: "exactInputSingle",
          args: [
            {
              tokenIn: token,
              tokenOut,
              fee,
              recipient: zeroAddress, // patched to the connected sender via senderTupleKey
              amountIn: amount.value,
              amountOutMinimum,
              sqrtPriceLimitX96: BigInt(0),
            },
          ],
          senderIndex: 0,
          senderTupleKey: "recipient",
          description: `Swap ${order.amount} ${assetLabel} via Uniswap v3 on ${chainLabel} (minimum output enforced by a live quote)`,
          riskNote: `Moves real funds on ${chainLabel} — the minimum you receive is enforced on-chain from a live quote taken just before signing.`,
        };
      }

      return fail(`Uniswap does not yet support order type '${order.type}'`);
    }

    case "morpho": {
      const token = order.token;
      if (!token) return fail("morpho order requires a token address");
      const amount = normalizeAmount(order.amount, decimals);
      if ("error" in amount) return amount;

      if (order.type === "approve") {
        const spender = order.spender as Address | undefined;
        if (!spender) return fail("morpho approve requires a spender (vault) address");
        return {
          chainId,
          address: token,
          abi: ERC20_APPROVE_ABI,
          functionName: "approve",
          args: [spender, amount.value],
          description: `Approve this Morpho vault to spend up to ${order.amount} ${assetLabel} on ${chainLabel}`,
          riskNote: `Approval lets the vault transfer up to this amount of ${assetLabel}. Confirm the vault address before signing.`,
        };
      }

      if (order.type === "supply") {
        const vault = order.vaultAddress;
        if (!vault) return fail("morpho supply requires a vaultAddress");
        return {
          chainId,
          address: vault,
          abi: ERC4626_DEPOSIT_ABI,
          functionName: "deposit",
          // [assets, receiver] — receiver patched to the connected sender by useExecute via `senderIndex`.
          args: [amount.value, zeroAddress],
          senderIndex: 1,
          description: `Deposit ${order.amount} ${assetLabel} into a Morpho vault on ${chainLabel}`,
          riskNote: `Moves real funds on ${chainLabel} into a third-party Morpho vault — its live risk tier was shown before you confirmed.`,
        };
      }

      if (order.type === "withdraw") {
        const vault = order.vaultAddress;
        if (!vault) return fail("morpho withdraw requires a vaultAddress");
        return {
          chainId,
          address: vault,
          abi: ERC4626_WITHDRAW_ABI,
          functionName: "withdraw",
          // [assets, receiver, owner] — both receiver and owner patched to the
          // connected sender (a self-withdrawal never needs an allowance check).
          args: [amount.value, zeroAddress, zeroAddress],
          senderIndices: [1, 2],
          description: `Withdraw ${order.amount} ${assetLabel} from a Morpho vault on ${chainLabel}`,
          riskNote: `Withdraws real funds from a Morpho vault on ${chainLabel} back to your wallet. Confirm the amount before signing.`,
        };
      }

      return fail(`Morpho does not yet support order type '${order.type}'`);
    }

    case "spark": {
      // Spark is an Aave v3 fork — same ABIs, different pool addresses.
      const pool = SPARK_POOL_BY_CHAIN[chainId];
      if (!pool) return fail(`Spark is not supported on ${chainLabel}`);
      const token = order.token;
      if (!token) return fail("spark order requires a token address");
      const amount = normalizeAmount(order.amount, decimals);
      if ("error" in amount) return amount;

      if (order.type === "approve") {
        const spender = (order.spender as Address | undefined) ?? pool;
        return {
          chainId, address: token, abi: ERC20_APPROVE_ABI, functionName: "approve",
          args: [spender, amount.value],
          description: `Approve Spark to spend up to ${order.amount} ${assetLabel} on ${chainLabel}`,
          riskNote: `Approval lets the spender transfer up to this amount of ${assetLabel}. Confirm before signing.`,
        };
      }
      if (order.type === "supply") {
        return {
          chainId, address: pool, abi: AAVE_V3_POOL_SUPPLY_ABI, functionName: "supply",
          args: [token, amount.value, zeroAddress, BigInt(0)], senderIndex: 2,
          description: `Supply ${order.amount} ${assetLabel} as collateral to Spark on ${chainLabel}`,
          riskNote: `Moves real funds on ${chainLabel} — confirm the amount before signing. Your supply earns yield and can be used as collateral (subject to liquidation).`,
        };
      }
      if (order.type === "repay") {
        return {
          chainId, address: pool, abi: AAVE_V3_POOL_REPAY_ABI, functionName: "repay",
          args: [token, amount.value, AAVE_INTEREST_RATE_MODE_VARIABLE, zeroAddress], senderIndex: 3,
          description: `Repay ${order.amount} ${assetLabel} of Spark debt (variable rate) on ${chainLabel}`,
          riskNote: `Moves real funds on ${chainLabel} — confirm the amount before signing. This reduces your open Spark debt.`,
        };
      }
      if (order.type === "withdraw") {
        return {
          chainId, address: pool, abi: AAVE_V3_POOL_WITHDRAW_ABI, functionName: "withdraw",
          args: [token, amount.value, zeroAddress], senderIndex: 2,
          description: `Withdraw ${order.amount} ${assetLabel} from Spark on ${chainLabel}`,
          riskNote: `Withdraws ${assetLabel} collateral from Spark on ${chainLabel}. Watch your health factor — confirm before signing.`,
        };
      }
      if (order.type === "borrow") {
        return {
          chainId, address: pool, abi: AAVE_V3_POOL_BORROW_ABI, functionName: "borrow",
          args: [token, amount.value, AAVE_INTEREST_RATE_MODE_VARIABLE, BigInt(0), zeroAddress], senderIndex: 4,
          description: `Borrow ${order.amount} ${assetLabel} against Spark collateral on ${chainLabel} (variable rate)`,
          riskNote: `Borrowing creates Spark debt on ${chainLabel} and lowers your health factor. Confirm before signing.`,
        };
      }
      return fail(`Spark does not yet support order type '${order.type}'`);
    }

    case "maker": {
      // Maker/Sky sDAI — ERC-4626 vault wrapping the DAI Savings Rate.
      const token = order.token;
      if (!token) return fail("maker order requires a token address");
      const amount = normalizeAmount(order.amount, decimals);
      if ("error" in amount) return amount;

      if (order.type === "approve") {
        const spender = (order.spender as Address | undefined) ?? SDAI_VAULT;
        return {
          chainId, address: token, abi: ERC20_APPROVE_ABI, functionName: "approve",
          args: [spender, amount.value],
          description: `Approve sDAI vault to spend up to ${order.amount} ${assetLabel} on ${chainLabel}`,
          riskNote: `Approval lets the vault transfer up to this amount of ${assetLabel}. Confirm before signing.`,
        };
      }
      if (order.type === "supply") {
        return {
          chainId, address: SDAI_VAULT, abi: ERC4626_DEPOSIT_ABI, functionName: "deposit",
          args: [amount.value, zeroAddress], senderIndex: 1,
          description: `Deposit ${order.amount} ${assetLabel} into sDAI (Maker DSR) on ${chainLabel}`,
          riskNote: `Moves real funds on ${chainLabel} into Maker's DAI Savings Rate vault — your DAI earns the DSR yield continuously.`,
        };
      }
      if (order.type === "withdraw") {
        return {
          chainId, address: SDAI_VAULT, abi: ERC4626_WITHDRAW_ABI, functionName: "withdraw",
          args: [amount.value, zeroAddress, zeroAddress], senderIndices: [1, 2],
          description: `Withdraw ${order.amount} ${assetLabel} from sDAI (Maker DSR) on ${chainLabel}`,
          riskNote: `Withdraws DAI from the Maker DSR vault back to your wallet. Confirm the amount before signing.`,
        };
      }
      return fail(`Maker DSR does not yet support order type '${order.type}'`);
    }

    case "weth": {
      // WETH wrap (deposit ETH → WETH) and unwrap (withdraw WETH → ETH).
      const token = order.token;
      if (!token) return fail("WETH order requires the WETH token address");
      const amount = normalizeAmount(order.amount, decimals);
      if ("error" in amount) return amount;

      if (order.type === "supply" || order.type === "swap") {
        // Wrap: deposit() payable — sends ETH as msg.value, credits WETH.
        return {
          chainId, address: token, abi: WETH_DEPOSIT_ABI, functionName: "deposit",
          args: [], value: amount.value,
          description: `Wrap ${order.amount} ETH into WETH on ${chainLabel}`,
          riskNote: `Converts native ETH to WETH (wrapped ETH) 1:1. WETH is needed for most DeFi interactions. Fully reversible via unwrap.`,
        };
      }
      if (order.type === "withdraw") {
        // Unwrap: withdraw(wad) — burns WETH, sends ETH.
        return {
          chainId, address: token, abi: WETH_WITHDRAW_ABI, functionName: "withdraw",
          args: [amount.value],
          description: `Unwrap ${order.amount} WETH into native ETH on ${chainLabel}`,
          riskNote: `Converts WETH back to native ETH 1:1. Fully reversible via wrap.`,
        };
      }
      return fail(`WETH only supports wrap (supply) and unwrap (withdraw), got '${order.type}'`);
    }

    case "rocketpool": {
      // Rocket Pool: deposit ETH, receive rETH at the current exchange rate.
      if (chainId !== 1) return fail(`Rocket Pool is only supported on Ethereum mainnet, not ${chainLabel}`);
      if (order.type !== "stake") return fail(`Rocket Pool only supports 'stake', got '${order.type}'`);
      const amount = normalizeAmount(order.amount, decimals);
      if ("error" in amount) return amount;
      return {
        chainId,
        address: ROCKET_DEPOSIT_POOL,
        abi: ROCKET_DEPOSIT_ABI,
        functionName: "deposit",
        args: [],
        value: amount.value,
        description: `Stake ${order.amount} ETH via Rocket Pool on ${chainLabel} for rETH`,
        riskNote: `Moves real ETH on ${chainLabel} and mints rETH at the current exchange rate. Rocket Pool is decentralized staking — rETH accrues staking yield via its exchange rate.`,
      };
    }

    case "frax": {
      // Frax: submitAndDeposit sends ETH → mints frxETH → deposits into sfrxETH vault.
      if (chainId !== 1) return fail(`Frax ETH staking is only supported on Ethereum mainnet, not ${chainLabel}`);
      if (order.type !== "stake") return fail(`Frax only supports 'stake', got '${order.type}'`);
      const amount = normalizeAmount(order.amount, decimals);
      if ("error" in amount) return amount;
      return {
        chainId,
        address: FRXETH_MINTER,
        abi: FRXETH_SUBMIT_AND_DEPOSIT_ABI,
        functionName: "submitAndDeposit",
        args: [zeroAddress], // recipient patched to connected sender
        senderIndex: 0,
        value: amount.value,
        description: `Stake ${order.amount} ETH via Frax on ${chainLabel} for sfrxETH`,
        riskNote: `Moves real ETH on ${chainLabel} through Frax's minter — mints frxETH and auto-deposits into sfrxETH for yield. sfrxETH accrues staking yield via its exchange rate.`,
      };
    }

    case "debridge":
    case "lifi": {
      // A router-quoted swap/bridge. Unlike every other protocol branch above,
      // the destination contract is named by a third party (the quote) rather
      // than by Meridian's own allowlist — so it is cross-checked against
      // routerAllowlist.ts here, and refused outright on any mismatch, before
      // this can ever become a signable plan.
      const providerLabel = order.protocol === "lifi" ? "LI.FI" : "deBridge";
      const isTrusted = order.protocol === "lifi" ? isTrustedLifiEntrypoint : isTrustedDebridgeEntrypoint;
      const token = order.token;

      if (order.type === "approve") {
        if (!token) return fail(`${providerLabel} approve requires a token address`);
        const spender = order.spender as Address | undefined;
        if (!spender) return fail(`${providerLabel} approve requires a spender address`);
        if (!isTrusted(chainId, spender)) {
          return fail(`Refusing to approve: ${spender} is not a verified ${providerLabel} entrypoint on ${chainLabel}.`);
        }
        const amount = normalizeAmount(order.amount, decimals);
        if ("error" in amount) return amount;
        return {
          chainId,
          address: token,
          abi: ERC20_APPROVE_ABI,
          functionName: "approve",
          args: [spender, amount.value],
          description: `Approve ${providerLabel} to spend up to ${order.amount} ${assetLabel} on ${chainLabel}`,
          riskNote: `Approval lets this verified ${providerLabel} router transfer up to this amount of ${assetLabel}. Confirm before signing.`,
        };
      }

      if (order.type !== "swap") {
        return fail(`${providerLabel} only supports 'swap' (bridge/swap) and 'approve', got '${order.type}'`);
      }
      const routerTx = order.routerTx;
      if (!routerTx) return fail(`${providerLabel} order requires routerTx (the quoted unsigned transaction)`);
      if (!isTrusted(chainId, routerTx.to)) {
        return fail(
          `Refusing to sign: ${routerTx.to} is not a verified ${providerLabel} entrypoint on ${chainLabel}. This quote may be stale — refresh and try again.`,
        );
      }
      return {
        chainId,
        address: routerTx.to,
        data: routerTx.data,
        value: routerTx.value,
        description: `Swap/bridge ${order.amount} ${assetLabel} via ${providerLabel} on ${chainLabel}`,
        riskNote: `Moves real funds on ${chainLabel} through a verified third-party router (${providerLabel}) — the destination contract was checked against Meridian's own allowlist before this plan was built.`,
      };
    }

    // Perp venues: these protocols are executed by dedicated UI components
    // (PerpExecuteButton, ExtendedPerpExecuteButton, LifiPerpExecuteButton)
    // that handle signing directly (EIP-712, StarkEx, LI.FI relay).
    // buildExecution is NOT called for them — but if it is (e.g. via
    // the generic ExecuteButton fallback), return a descriptive error
    // instead of "unknown protocol".
    case "hyperliquid":
      return fail("Hyperliquid perps use EIP-712 signing — use the dedicated Hyperliquid panel instead.");
    case "extended":
      return fail("Extended perps use StarkEx signing — use the dedicated Extended panel instead.");
    case "ondo":
    case "lighter":
      return fail(`${assetLabel} perps on ${String(order.protocol)} use the LI.FI relay — use the dedicated perps panel instead.`);
    case "variational":
      return fail("Variational options are not yet wired for live execution.");
    case "pendle":
      return fail("Pendle fixed-yield (PT) is not yet wired for live execution.");
    case "eigenlayer":
      return fail("EigenLayer restaking is not yet wired for live execution.");

    default:
      return fail(`unknown protocol '${String(order.protocol)}'`);
  }
}

/**
 * Patch a plan's onBehalfOf/sender placeholder with the connected wallet address.
 * Aave >=v3 supplies/repays with `onBehalfOf` set to the connected sender; the
 * plan is built sender-agnostically and this fills it in only at execution time.
 */
export function applySender(
  plan: ExecutionPlan,
  sender: Address | undefined,
): ExecutionPlan | { error: string } {
  const indices = [...(plan.senderIndices ?? []), ...(plan.senderIndex !== undefined ? [plan.senderIndex] : [])];
  if (indices.length === 0) return plan;
  if (!sender) return fail("wallet not connected");
  const args = [...(plan.args ?? [])];
  for (const idx of indices) {
    if (idx < 0 || idx >= args.length) {
      return fail("execution plan has an invalid sender placeholder index");
    }
    if (plan.senderTupleKey !== undefined) {
      const tuple = args[idx];
      if (typeof tuple !== "object" || tuple === null) {
        return fail("execution plan's sender placeholder is not a tuple");
      }
      args[idx] = { ...(tuple as Record<string, unknown>), [plan.senderTupleKey]: sender };
    } else {
      args[idx] = sender;
    }
  }
  return { ...plan, args };
}
