import type { Abi, Address } from "viem";
import { parseUnits, zeroAddress } from "viem";
import { AAVE_V3_POOL_BY_CHAIN, CHAIN_LABEL } from "./onchain";

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

export type OrderType = "supply" | "repay" | "borrow" | "withdraw" | "transfer";
export type OrderProtocol = "aave" | "eth";

/**
 * Protocol-agnostic order produced by the trade engine. Carries enough to build a
 * concrete write call; the trailing `[k: string]: unknown` index signature lets a
 * future `TradePlan` shape be passed straight through without a structural re-type.
 */
export interface Order {
  type: OrderType;
  protocol: OrderProtocol;
  /** ERC20 asset address (required for Aave supply/repay; optional for native transfer). */
  token?: Address;
  symbol?: string;
  /** Amount in human units (decimal string) OR base units (bigint). */
  amount: bigint | string;
  chainId: number;
  /** Token decimals, used to parse human-unit strings. Defaults to 18. */
  decimals?: number;
  /** Recipient address for `eth` native transfers. */
  to?: Address;
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
  args[plan.senderIndex] = sender;
  return { ...plan, args };
}
