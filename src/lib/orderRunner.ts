/**
 * orderRunner.ts — the one validated execution path for every wallet order.
 *
 * Framework-free (no React, no wagmi hooks): callers inject the public client
 * and the wallet's write functions, so the exact same checks run for a single
 * order (`useExecuteOrder`) and for every leg of a multi-leg strategy
 * (`useStrategyExecutor`), and the whole flow is unit-testable with fakes.
 *
 *   prepareOrder:  normalize amount → build plan (onchain.ts / routerAllowlist
 *                  addresses only) → live balance check → live allowance read →
 *                  simulate. Never signs.
 *   executePreparedOrder: re-check chain/expiry/allowance → [USDT reset →]
 *                  approve exact amount → wait → re-simulate → send → wait.
 *
 * Invariants: approvals are always exactly the order amount, a sufficient
 * existing allowance is never re-approved, nothing is sent without a passing
 * simulation, and every receipt wait has a timeout.
 */

import type { Address } from "viem";
import { ERC20_ABI, ERC20_ALLOWANCE_ABI } from "@/lib/onchain";
import { applySender, buildExecution, normalizeAmount, type ExecutionPlan, type Order } from "@/lib/execution";
import { approveOrderFor } from "@/lib/assetMap";
import { needsAllowanceReset } from "@/lib/integrations/usdt";
import {
  classifyExecutionError,
  createOrderPlan,
  isPlanExpired,
  isWalletDebitingAction,
  logTransition,
  validateOrderPlan,
  type FailureState,
  type OrderFlowState,
  type OrderPlan,
} from "@/lib/executionPlan";
import { recordExecution, type OrderRecordType } from "@/lib/history";

/** How long to wait for a tx to confirm before surfacing CONFIRMATION_TIMEOUT instead of hanging forever. */
export const CONFIRMATION_TIMEOUT_MS = 120_000;

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The subset of a viem public client the runner uses. Dynamically-shaped plans
 * (viem's broad `Abi`) make the real generic signatures explode with "union
 * type too complex", so the args are erased here once.
 */
export interface OrderRunnerClient {
  getBalance(args: { address: Address }): Promise<bigint>;
  readContract(args: any): Promise<unknown>;
  simulateContract(args: any): Promise<unknown>;
  call(args: any): Promise<unknown>;
  waitForTransactionReceipt(args: { hash: `0x${string}`; timeout?: number }): Promise<{ status: "success" | "reverted" }>;
}
export type WriteAsync = (args: any) => Promise<`0x${string}`>;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface OrderRunnerDeps {
  address: Address;
  /** Chain the wallet is connected to right now. */
  connectedChainId: number | undefined;
  /** Public client for the order's chain. */
  client: OrderRunnerClient;
  writeContract: WriteAsync;
  sendTransaction: WriteAsync;
  /** UI hook — called on every state transition (the runner already logs it). */
  onState?: (state: OrderFlowState, info?: { hash?: `0x${string}` }) => void;
}

export interface Failure {
  ok: false;
  state: FailureState;
  message: string;
  plan?: OrderPlan;
}

interface ResolvedApproval {
  built: ExecutionPlan;
  spender: Address;
}

export interface PreparedOrder {
  plan: OrderPlan;
  /** Built, sender-patched plan — carries `.description` / `.riskNote` for the confirm UI. */
  built: ExecutionPlan;
  approval: ResolvedApproval | null;
  /** Whether an approval signature is needed first, from the live allowance read. */
  needsApproval: boolean;
}

export type PrepareResult = ({ ok: true } & PreparedOrder) | Failure;
export type ExecuteResult =
  | { ok: true; hash: `0x${string}`; approvalHash?: `0x${string}` }
  | (Failure & { hash?: `0x${string}`; approvalHash?: `0x${string}` });

/** Map an Order's type to the coarse history record type. */
export function recordTypeFor(orderType: Order["type"]): OrderRecordType {
  switch (orderType) {
    case "supply":
    case "stake":
      return "deposit";
    case "repay":
    case "borrow":
    case "withdraw":
    case "unstake":
    case "transfer":
      return "withdraw";
    case "swap":
      return "swap";
    case "claim":
      return "claim";
    default:
      return "custom";
  }
}

function transition(deps: OrderRunnerDeps, plan: OrderPlan | null, state: OrderFlowState, info?: { hash?: `0x${string}`; message?: string }) {
  logTransition(plan ? { planId: plan.planId, chainId: plan.order.chainId, symbol: plan.order.symbol } : null, state, info);
  deps.onState?.(state, info?.hash ? { hash: info.hash } : undefined);
}

function failure(deps: OrderRunnerDeps, plan: OrderPlan | null, state: FailureState, message: string): Failure {
  transition(deps, plan, state, { message });
  return { ok: false, state, message, ...(plan ? { plan } : {}) };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolve the approve plan + its spender (from the approve call's own args), when the order needs one. */
function resolveApproval(order: Order): ResolvedApproval | null | { error: string } {
  const approveOrder = approveOrderFor(order);
  if (!approveOrder) return null;
  const built = buildExecution(approveOrder);
  if ("error" in built) return { error: built.error };
  const spender = built.args?.[0] as Address | undefined;
  if (!spender) return { error: "could not resolve the approval spender" };
  return { built, spender };
}

/** eth_call the plan: simulateContract for ABI plans, a raw call for router calldata. Native sends have nothing to simulate. */
async function simulatePlan(client: OrderRunnerClient, account: Address, plan: ExecutionPlan): Promise<void> {
  if (plan.abi && plan.functionName && plan.args) {
    await client.simulateContract({
      account,
      address: plan.address!,
      abi: plan.abi,
      functionName: plan.functionName,
      args: plan.args,
      ...(plan.value !== undefined ? { value: plan.value } : {}),
    });
  } else if (plan.data !== undefined) {
    await client.call({ account, to: plan.address, data: plan.data, value: plan.value });
  }
}

async function submitPlan(deps: OrderRunnerDeps, plan: ExecutionPlan): Promise<`0x${string}`> {
  if (plan.address && plan.abi && plan.functionName && plan.args) {
    return deps.writeContract({
      chainId: plan.chainId,
      address: plan.address,
      abi: plan.abi,
      functionName: plan.functionName,
      args: plan.args,
      ...(plan.value !== undefined ? { value: plan.value } : {}),
    });
  }
  if (plan.value !== undefined || plan.data !== undefined) {
    if (!plan.address) throw new Error("transaction is missing a recipient (address)");
    return deps.sendTransaction({ chainId: plan.chainId, to: plan.address, value: plan.value, data: plan.data });
  }
  throw new Error("execution plan is missing required write fields");
}

async function readAllowance(client: OrderRunnerClient, token: Address, owner: Address, spender: Address): Promise<bigint | undefined> {
  const v = await client
    .readContract({ address: token, abi: ERC20_ALLOWANCE_ABI, functionName: "allowance", args: [owner, spender] })
    .catch(() => undefined);
  return typeof v === "bigint" ? v : undefined;
}

/** Build, validate and simulate an order. Never signs anything. */
export async function prepareOrder(deps: OrderRunnerDeps, order: Order): Promise<PrepareResult> {
  const { address, client } = deps;
  if (deps.connectedChainId !== order.chainId) {
    return failure(deps, null, "WRONG_CHAIN", `Switch your wallet to chain ${order.chainId} before continuing.`);
  }

  const normalized = normalizeAmount(order.amount, order.decimals ?? 18);
  if ("error" in normalized) return failure(deps, null, "INVALID_AMOUNT", normalized.error);
  const exactOrder: Order = { ...order, amount: normalized.value };

  const plan = createOrderPlan(address, exactOrder);
  transition(deps, plan, "VALIDATING");

  const built = buildExecution(exactOrder);
  if ("error" in built) return failure(deps, plan, "SIMULATION_FAILED", built.error);
  const patched = applySender(built, address);
  if ("error" in patched) return failure(deps, plan, "SIMULATION_FAILED", patched.error);

  let liveBalance: bigint | undefined;
  if (isWalletDebitingAction(exactOrder)) {
    if (patched.value !== undefined && patched.value > BigInt(0)) {
      liveBalance = await client.getBalance({ address }).catch(() => undefined);
    } else if (exactOrder.token) {
      const b = await client
        .readContract({ address: exactOrder.token, abi: ERC20_ABI, functionName: "balanceOf", args: [address] })
        .catch(() => undefined);
      liveBalance = typeof b === "bigint" ? b : undefined;
    }
  }
  const validation = validateOrderPlan(plan, { connectedAddress: address, connectedChainId: deps.connectedChainId, liveBalance });
  if (!validation.ok) return failure(deps, plan, validation.state, validation.message);

  transition(deps, plan, "SIMULATING");
  const approval = resolveApproval(exactOrder);
  if (approval && "error" in approval) return failure(deps, plan, "SIMULATION_FAILED", approval.error);

  let needsApproval = false;
  if (approval) {
    const allowance = await readAllowance(client, exactOrder.token as Address, address, approval.spender);
    if (allowance === undefined) return failure(deps, plan, "RPC_ERROR", "Could not read your current allowance — try again.");
    needsApproval = allowance < normalized.value;
  }

  try {
    if (approval && needsApproval) {
      // Only the approval can be simulated truthfully now: the main call would
      // (correctly) revert against the still-insufficient allowance. It is
      // simulated for real once the approval mines (executePreparedOrder).
      // USDT's approve reverts while a non-zero allowance exists, so it is
      // checked after the reset instead.
      if (!needsAllowanceReset(exactOrder.token)) await simulatePlan(client, address, approval.built);
    } else {
      await simulatePlan(client, address, patched);
    }
  } catch (err) {
    return failure(deps, plan, "SIMULATION_FAILED", `${needsApproval ? "Approval" : "Transaction"} would fail: ${errorMessage(err)}`);
  }

  transition(deps, plan, "READY_FOR_SIGNATURE");
  return { ok: true, plan, built: patched, approval, needsApproval };
}

/** Sign and send a prepared order: approval first when still needed, then the order itself. */
export async function executePreparedOrder(deps: OrderRunnerDeps, prepared: PreparedOrder): Promise<ExecuteResult> {
  const { address, client } = deps;
  const { plan, built, approval } = prepared;
  const order = plan.order;

  if (deps.connectedChainId !== order.chainId) {
    return failure(deps, plan, "WRONG_CHAIN", `Wrong network — switch to chain ${order.chainId} before signing.`);
  }
  if (isPlanExpired(plan)) return failure(deps, plan, "PLAN_EXPIRED", "This plan has expired — refresh and try again.");

  let approvalHash: `0x${string}` | undefined;
  if (approval) {
    const amount = order.amount as bigint;
    const allowance = await readAllowance(client, order.token as Address, address, approval.spender);
    if (allowance === undefined) return failure(deps, plan, "RPC_ERROR", "Could not re-check your allowance — try again.");

    if (allowance < amount) {
      transition(deps, plan, "APPROVAL_PENDING");
      try {
        if (allowance > BigInt(0) && needsAllowanceReset(order.token)) {
          const reset = await submitPlan(deps, { ...approval.built, args: [approval.spender, BigInt(0)] });
          const r = await client.waitForTransactionReceipt({ hash: reset, timeout: CONFIRMATION_TIMEOUT_MS });
          if (r.status === "reverted") return failure(deps, plan, "APPROVAL_FAILED", "Allowance reset reverted on-chain.");
          await simulatePlan(client, address, approval.built);
        }
        approvalHash = await submitPlan(deps, approval.built);
      } catch (err) {
        const c = classifyExecutionError(err, "approval");
        return failure(deps, plan, c.state, c.message);
      }
      transition(deps, plan, "APPROVAL_PENDING", { hash: approvalHash });

      try {
        const receipt = await client.waitForTransactionReceipt({ hash: approvalHash, timeout: CONFIRMATION_TIMEOUT_MS });
        if (receipt.status === "reverted") {
          return { ...failure(deps, plan, "APPROVAL_FAILED", "Approval transaction reverted on-chain."), approvalHash };
        }
      } catch (err) {
        const c = classifyExecutionError(err, "approval");
        return { ...failure(deps, plan, c.state, c.message), approvalHash };
      }
      transition(deps, plan, "APPROVAL_CONFIRMED", { hash: approvalHash });

      // The allowance is live on-chain only now — simulate the real call before the second signature.
      try {
        await simulatePlan(client, address, built);
      } catch (err) {
        return { ...failure(deps, plan, "SIMULATION_FAILED", `Transaction would fail after approval: ${errorMessage(err)}`), approvalHash };
      }
    }
  }

  const record = (status: "confirmed" | "error", suffix: string, hash?: `0x${string}`) =>
    recordExecution({
      type: recordTypeFor(order.type),
      label: `${built.description}${suffix}`,
      asset: order.symbol,
      protocol: String(order.protocol),
      chainId: order.chainId,
      status,
      ...(hash ? { hash } : {}),
    });

  transition(deps, plan, "SUPPLY_PENDING");
  let hash: `0x${string}`;
  try {
    hash = await submitPlan(deps, built);
  } catch (err) {
    const c = classifyExecutionError(err, "supply");
    record("error", " (failed)");
    return { ...failure(deps, plan, c.state, c.message), approvalHash };
  }
  transition(deps, plan, "CONFIRMING", { hash });

  try {
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: CONFIRMATION_TIMEOUT_MS });
    if (receipt.status === "reverted") {
      record("error", " (reverted)", hash);
      return { ...failure(deps, plan, "TRANSACTION_REVERTED", "Transaction reverted on-chain."), hash, approvalHash };
    }
  } catch (err) {
    const c = classifyExecutionError(err, "supply");
    return { ...failure(deps, plan, c.state, c.message), hash, approvalHash };
  }

  transition(deps, plan, "CONFIRMED", { hash });
  record("confirmed", "", hash);
  return { ok: true, hash, approvalHash };
}
