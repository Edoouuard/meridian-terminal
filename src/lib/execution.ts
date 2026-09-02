import type { Abi, Address } from "viem";
import { parseUnits, zeroAddress } from "viem";
import { AAVE_V3_POOL_BY_CHAIN, CHAIN_LABEL, STETH_ADDRESS } from "./onchain";
import { SWAP_ROUTER02_EXACT_INPUT_SINGLE_ABI, UNISWAP_SWAP_ROUTER02_BY_CHAIN } from "./integrations/uniswap";
import { ERC4626_DEPOSIT_ABI } from "./integrations/morpho";

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

export type OrderType = "supply" | "repay" | "borrow" | "withdraw" | "transfer" | "approve" | "stake" | "swap";
export type OrderProtocol = "aave" | "eth" | "lido" | "uniswap" | "morpho";

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
  /** ERC-4626 vault contract address for a Morpho `supply` order (resolved live from Philidor, not a fixed per-chain constant). */
  vaultAddress?: Address;
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
  /** Native value to send (only for `eth` transfers). */
  value?: bigint;
  /** Index into `args` holding the onBehalfOf/sender placeholder, patched at execution time. */
  senderIndex?: number;
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

    case "lido": {
      if (order.type !== "stake") return fail(`Lido only supports 'stake', got '${order.type}'`);
      if (chainId !== 1) return fail(`Lido staking is only supported on Ethereum mainnet, not ${chainLabel}`);
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
          riskNote: `Moves real funds on ${chainLabel} into a third-party Morpho vault — its live risk tier was shown before you confirmed. Withdrawal isn't wired in Meridian yet; use the vault's own interface to exit.`,
        };
      }

      return fail(`Morpho does not yet support order type '${order.type}'`);
    }

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
  if (plan.senderIndex === undefined) return plan;
  if (!sender) return fail("wallet not connected");
  const args = [...(plan.args ?? [])];
  if (plan.senderIndex < 0 || plan.senderIndex >= args.length) {
    return fail("execution plan has an invalid sender placeholder index");
  }
  if (plan.senderTupleKey !== undefined) {
    const tuple = args[plan.senderIndex];
    if (typeof tuple !== "object" || tuple === null) {
      return fail("execution plan's sender placeholder is not a tuple");
    }
    args[plan.senderIndex] = { ...(tuple as Record<string, unknown>), [plan.senderTupleKey]: sender };
  } else {
    args[plan.senderIndex] = sender;
  }
  return { ...plan, args };
}
