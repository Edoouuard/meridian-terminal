import type { Address } from "viem";

/**
 * executionPlan.ts — versioned plan schema + explicit state machine for
 * Meridian's first production execution flow (USDC -> Aave v3 supply, same
 * chain). Pure and offline: every function here only reads its inputs and
 * the current time — live reads (balance, allowance, connected
 * wallet/chain) are the caller's job (see useAaveSupply.ts).
 *
 * A plan is a frozen snapshot: wallet, chain, asset and amount are fixed at
 * creation time and the plan expires after PLAN_TTL_MS, so a stale plan can
 * never be signed long after the balance/allowance it was built from changed.
 */

export const EXECUTION_PLAN_VERSION = 1;
export const PLAN_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Non-failure states of the supply flow, in the order they're expected to occur. */
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

export type SupplyFlowState = ExecutionState | FailureState;

/** True once a state is terminal (either CONFIRMED or any failure) — no further transitions happen. */
export function isTerminalState(state: SupplyFlowState): boolean {
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

export function isFailureState(state: SupplyFlowState): state is FailureState {
  return (FAILURE_STATES as ReadonlySet<string>).has(state);
}

/** A frozen, versioned snapshot of a single USDC -> Aave v3 supply action. */
export interface AaveSupplyPlan {
  version: typeof EXECUTION_PLAN_VERSION;
  planId: string;
  createdAt: number;
  expiresAt: number;
  walletAddress: Address;
  chainId: number;
  protocol: "aave";
  token: Address;
  symbol: string;
  decimals: number;
  /** Exact base-unit amount to supply (never human units — avoids any ambiguity at signing time). */
  amount: bigint;
}

/** Random plan id — prefers crypto.randomUUID, falls back to a timestamp + random suffix. */
export function makePlanId(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createAaveSupplyPlan(input: {
  walletAddress: Address;
  chainId: number;
  token: Address;
  symbol: string;
  decimals: number;
  amount: bigint;
  now?: number;
}): AaveSupplyPlan {
  const now = input.now ?? Date.now();
  return {
    version: EXECUTION_PLAN_VERSION,
    planId: makePlanId(),
    createdAt: now,
    expiresAt: now + PLAN_TTL_MS,
    walletAddress: input.walletAddress,
    chainId: input.chainId,
    protocol: "aave",
    token: input.token,
    symbol: input.symbol,
    decimals: input.decimals,
    amount: input.amount,
  };
}

export function isPlanExpired(plan: AaveSupplyPlan, now: number = Date.now()): boolean {
  return now >= plan.expiresAt;
}

export interface ValidationContext {
  /** The wallet actually connected right now (undefined when disconnected). */
  connectedAddress: Address | undefined;
  /** The chain the wallet is actually connected to right now. */
  connectedChainId: number | undefined;
  /** Live USDC balance (base units) for `plan.walletAddress` on `plan.chainId`. */
  usdcBalance: bigint | undefined;
  now?: number;
}

export type ValidationResult = { ok: true } | { ok: false; state: FailureState; message: string };

/**
 * Pure precondition check run before a plan may move from VALIDATING to
 * SIMULATING: wallet still connected and matching, correct chain, not
 * expired, sufficient live balance. Never touches the network — the caller
 * supplies every live read.
 */
export function validateAaveSupplyPlan(plan: AaveSupplyPlan, ctx: ValidationContext): ValidationResult {
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
  if (ctx.connectedChainId !== plan.chainId) {
    return { ok: false, state: "WRONG_CHAIN", message: `Wrong network — switch to chain ${plan.chainId} before signing.` };
  }
  if (isPlanExpired(plan, ctx.now)) {
    return { ok: false, state: "PLAN_EXPIRED", message: "This plan has expired — refresh the amount and try again." };
  }
  if (ctx.usdcBalance === undefined) {
    return { ok: false, state: "RPC_ERROR" as FailureState, message: "Could not read your USDC balance — try again." };
  }
  if (ctx.usdcBalance < plan.amount) {
    return { ok: false, state: "INSUFFICIENT_BALANCE", message: "Insufficient USDC balance for this amount." };
  }
  return { ok: true };
}

/**
 * Classify a thrown error (wallet rejection, RPC failure, on-chain revert,
 * confirmation timeout) into one of the fixed failure states. `phase`
 * distinguishes an approval-step failure from a supply-step failure so the
 * UI can say exactly which signature failed.
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
 * metadata, the state, and (once available) a public tx hash.
 */
export function logTransition(plan: AaveSupplyPlan | null, state: SupplyFlowState, extra?: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.info("[aave-supply]", {
    planId: plan?.planId,
    chainId: plan?.chainId,
    symbol: plan?.symbol,
    state,
    ts: Date.now(),
    ...extra,
  });
}
