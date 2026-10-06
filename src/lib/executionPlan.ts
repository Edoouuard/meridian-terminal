import type { Address } from "viem";
import type { Order } from "./execution";

/**
 * executionPlan.ts — versioned plan schema + explicit state machine for
 * Meridian's validated execution flow (any order `execution.ts`'s
 * `buildExecution` supports — Aave/Spark/Compound/Morpho/Maker/Lido/WETH/
 * Rocket Pool/Frax/Uniswap/deBridge/LI.FI/transfers). Pure and offline:
 * every function here only reads its inputs and the current time — live
 * reads (balance, allowance, connected wallet/chain) are the caller's job
 * (see hooks/useExecuteOrder.ts).
 *
 * A plan is a frozen snapshot: wallet and order are fixed at creation time
 * and the plan expires after PLAN_TTL_MS, so a stale plan can never be
 * signed long after the balance/allowance/quote it was built from changed.
 */

export const EXECUTION_PLAN_VERSION = 1;
export const PLAN_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Non-failure states of the execution flow, in the order they're expected to occur. */
export type ExecutionState =
  | "DRAFT"
  | "VALIDATING"
  | "SIMULATING"
  | "READY_FOR_SIGNATURE"
  | "APPROVAL_PENDING"
  | "APPROVAL_CONFIRMED"
  | "SUPPLY_PENDING"
  | "CONFIRMING"
  | "CONFIRMED";

/** Terminal failure states. Once reached, the flow stops and surfaces `message` to the user. */
export type FailureState =
  | "WRONG_CHAIN"
  | "INSUFFICIENT_BALANCE"
  | "INVALID_AMOUNT"
  | "PLAN_EXPIRED"
  | "SIMULATION_FAILED"
  | "APPROVAL_REJECTED"
  | "APPROVAL_FAILED"
  | "SIGNATURE_REJECTED"
  | "TRANSACTION_REVERTED"
  | "RPC_ERROR"
  | "CONFIRMATION_TIMEOUT";

export type OrderFlowState = ExecutionState | FailureState;

/** True once a state is terminal (either CONFIRMED or any failure) — no further transitions happen. */
export function isTerminalState(state: OrderFlowState): boolean {
  return state === "CONFIRMED" || isFailureState(state);
}

const FAILURE_STATES: ReadonlySet<FailureState> = new Set<FailureState>([
  "WRONG_CHAIN",
  "INSUFFICIENT_BALANCE",
  "INVALID_AMOUNT",
  "PLAN_EXPIRED",
  "SIMULATION_FAILED",
  "APPROVAL_REJECTED",
  "APPROVAL_FAILED",
  "SIGNATURE_REJECTED",
  "TRANSACTION_REVERTED",
  "RPC_ERROR",
  "CONFIRMATION_TIMEOUT",
]);

export function isFailureState(state: OrderFlowState): state is FailureState {
  return (FAILURE_STATES as ReadonlySet<string>).has(state);
}

/**
 * Protocol+type combos that debit the connected wallet's native or token
 * balance before the call can succeed. Every (protocol, type) pair
 * `buildExecution` supports that spends a wallet-held balance appears here
 * exactly once; the rest (borrow, every protocol-side withdraw, claim)
 * RECEIVE funds instead and need no pre-signature balance check. Explicit
 * on purpose — inferring "debit vs. receive" structurally from the built
 * plan is ambiguous (e.g. WETH unwrap spends WETH but sets neither a
 * native `value` nor an approval, unlike every other token-spending call).
 */
const WALLET_DEBITING_ACTIONS: ReadonlySet<string> = new Set([
  "aave:supply",
  "aave:repay",
  "spark:supply",
  "spark:repay",
  "compound:supply",
  "compound:repay",
  "morpho:supply",
  "maker:supply",
  "lido:stake",
  "lido:unstake",
  "weth:supply", // wrap: spends native ETH
  "weth:withdraw", // unwrap: spends WETH
  "rocketpool:stake",
  "frax:stake",
  "uniswap:swap",
  "debridge:swap",
  "lifi:swap",
  "eth:transfer",
  "erc20:transfer",
]);

/** True when signing `order` requires the wallet to already hold the amount it spends. */
export function isWalletDebitingAction(order: Pick<Order, "protocol" | "type">): boolean {
  return WALLET_DEBITING_ACTIONS.has(`${order.protocol}:${order.type}`);
}

/** A frozen, versioned snapshot of a single order, ready to be validated/simulated/signed. */
export interface OrderPlan {
  version: typeof EXECUTION_PLAN_VERSION;
  planId: string;
  createdAt: number;
  expiresAt: number;
  walletAddress: Address;
  order: Order;
}

/** Random plan id — prefers crypto.randomUUID, falls back to a timestamp + random suffix. */
export function makePlanId(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createOrderPlan(walletAddress: Address, order: Order, now: number = Date.now()): OrderPlan {
  return {
    version: EXECUTION_PLAN_VERSION,
    planId: makePlanId(),
    createdAt: now,
    expiresAt: now + PLAN_TTL_MS,
    walletAddress,
    order,
  };
}

/** Accepts anything carrying an `expiresAt` — both `OrderPlan` and any future plan shape satisfy this structurally. */
export function isPlanExpired(plan: { expiresAt: number }, now: number = Date.now()): boolean {
  return now >= plan.expiresAt;
}

export interface OrderValidationContext {
  /** The wallet actually connected right now (undefined when disconnected). */
  connectedAddress: Address | undefined;
  /** The chain the wallet is actually connected to right now. */
  connectedChainId: number | undefined;
  /**
   * Live balance (base units) for the asset `order` would debit — native
   * balance when the built plan sends `value`, ERC20 balance of
   * `order.token` otherwise. Only read/required when
   * `isWalletDebitingAction(order)` is true; pass `undefined` otherwise
   * (the check is skipped, never silently passed).
   */
  liveBalance?: bigint;
  now?: number;
}

export type ValidationResult = { ok: true } | { ok: false; state: FailureState; message: string };

/**
 * Pure precondition check run before a plan may move from VALIDATING to
 * SIMULATING: wallet still connected and matching, correct chain, not
 * expired, and — only for a wallet-debiting order type — sufficient live
 * balance. Never touches the network — the caller supplies every live read.
 */
export function validateOrderPlan(plan: OrderPlan, ctx: OrderValidationContext): ValidationResult {
  if (!ctx.connectedAddress) {
    return { ok: false, state: "WRONG_CHAIN", message: "Wallet not connected." };
  }
  if (ctx.connectedAddress.toLowerCase() !== plan.walletAddress.toLowerCase()) {
    return {
      ok: false,
      state: "WRONG_CHAIN",
      message: "The connected wallet changed since this plan was created — refresh and try again.",
    };
  }
  if (ctx.connectedChainId !== plan.order.chainId) {
    return { ok: false, state: "WRONG_CHAIN", message: `Wrong network — switch to chain ${plan.order.chainId} before signing.` };
  }
  if (isPlanExpired(plan, ctx.now)) {
    return { ok: false, state: "PLAN_EXPIRED", message: "This plan has expired — refresh the amount and try again." };
  }
  if (isWalletDebitingAction(plan.order)) {
    if (ctx.liveBalance === undefined) {
      return { ok: false, state: "RPC_ERROR", message: "Could not read your live balance — try again." };
    }
    const amount = typeof plan.order.amount === "bigint" ? plan.order.amount : undefined;
    if (amount !== undefined && ctx.liveBalance < amount) {
      return { ok: false, state: "INSUFFICIENT_BALANCE", message: "Insufficient balance for this amount." };
    }
  }
  return { ok: true };
}

/**
 * Classify a thrown error (wallet rejection, RPC failure, on-chain revert,
 * confirmation timeout) into one of the fixed failure states. `phase`
 * distinguishes an approval-step failure from a main-order-step failure so
 * the UI can say exactly which signature failed.
 */
export function classifyExecutionError(err: unknown, phase: "approval" | "supply"): { state: FailureState; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  if (/reject|declined|user denied|4001/i.test(raw)) {
    return {
      state: phase === "approval" ? "APPROVAL_REJECTED" : "SIGNATURE_REJECTED",
      message: phase === "approval" ? "Approval rejected in wallet." : "Signature rejected in wallet.",
    };
  }
  if (/timed?\s*out|timeout/i.test(raw)) {
    return {
      state: "CONFIRMATION_TIMEOUT",
      message: "Timed out waiting for confirmation. Check the explorer link — the transaction may still land; do not resubmit.",
    };
  }
  if (/revert/i.test(raw)) {
    return {
      state: "TRANSACTION_REVERTED",
      message: phase === "approval" ? `Approval reverted on-chain: ${raw}` : `Transaction reverted on-chain: ${raw}`,
    };
  }
  return {
    state: phase === "approval" ? "APPROVAL_FAILED" : "RPC_ERROR",
    message: phase === "approval" ? `Approval failed: ${raw}` : `Request failed: ${raw}`,
  };
}

/**
 * Structured, secret-free log line for one state transition. Never includes
 * private keys, signatures, or raw wallet-provider payloads — only plan
 * metadata, the state, and (once available) a public tx hash. Accepts any
 * `{planId, chainId, symbol?}`-shaped value (including `null`), so both
 * `OrderPlan`'s own order and a caller-built adapter object work.
 */
export function logTransition(
  plan: { planId: string; chainId: number; symbol?: string } | null,
  state: OrderFlowState,
  extra?: Record<string, unknown>,
): void {
  // eslint-disable-next-line no-console
  console.info("[execute-order]", {
    planId: plan?.planId,
    chainId: plan?.chainId,
    symbol: plan?.symbol,
    state,
    ts: Date.now(),
    ...extra,
  });
}
