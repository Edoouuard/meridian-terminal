"use client";

import { useCallback, useRef, useState } from "react";
import type { Address } from "viem";
import { useAccount, usePublicClient, useSendTransaction, useWriteContract } from "wagmi";
import { ERC20_ABI } from "@/lib/onchain";
import { applySender, buildExecution, normalizeAmount, type ExecutionPlan, type Order } from "@/lib/execution";
import { approveOrderFor } from "@/lib/assetMap";
import {
  classifyExecutionError,
  createOrderPlan,
  isPlanExpired,
  isWalletDebitingAction,
  logTransition,
  validateOrderPlan,
  type OrderFlowState,
  type OrderPlan,
} from "@/lib/executionPlan";
import { recordExecution, type OrderRecordType } from "@/lib/history";

/** Minimal ERC20 allowance read ABI — kept local, same convention execution.ts uses for its own write ABIs. */
const ERC20_ALLOWANCE_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** How long to wait for a tx to confirm before surfacing CONFIRMATION_TIMEOUT instead of hanging forever. */
const CONFIRMATION_TIMEOUT_MS = 120_000;

/* eslint-disable @typescript-eslint/no-explicit-any */
type WriteAsync = (args: any) => Promise<`0x${string}`>;
/**
 * A dynamically-typed ExecutionPlan's `abi` is viem's broad `Abi` type, not a
 * literal `as const` ABI — passing it straight into `simulateContract`'s
 * heavily overloaded generic signature makes TS try to enumerate every
 * possible function/args combination and fail with "union type too complex
 * to represent". Erase the generic once, here, rather than at every call site.
 */
type SimulateAsync = (args: any) => Promise<unknown>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Map an Order's type to the coarse history record type (mirrors ThreadCard's own recordTypeFor). */
function recordTypeFor(orderType: Order["type"]): OrderRecordType {
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

async function submitPlan(plan: ExecutionPlan, writeContractAsync: WriteAsync, sendTransactionAsync: WriteAsync): Promise<`0x${string}`> {
  if (plan.address && plan.abi && plan.functionName && plan.args) {
    return writeContractAsync({
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
    return sendTransactionAsync({ chainId: plan.chainId, to: plan.address, value: plan.value, data: plan.data });
  }
  throw new Error("execution plan is missing required write fields");
}

export interface ExecuteOrderFlow {
  state: OrderFlowState;
  plan: OrderPlan | null;
  /** The built, sender-patched plan — carries `.description`/`.riskNote` for the confirm UI. */
  builtPlan: ExecutionPlan | null;
  message: string | null;
  approvalHash?: `0x${string}`;
  mainHash?: `0x${string}`;
  /** Whether the prepared plan will need an approval signature first (null until known). */
  needsApproval: boolean | null;
  /** Build a plan, validate it (balance/chain/expiry), and simulate the call(s). Never signs anything. */
  prepare: (order: Order) => Promise<void>;
  /** Sign (approve if needed, then the main order) the currently prepared plan. */
  confirm: () => Promise<void>;
  /** Back to DRAFT — clears plan/hashes/message. Never over-submits: a fresh prepare() is required after. */
  reset: () => void;
}

/**
 * Meridian's validated execution flow — works for ANY order `execution.ts`'s
 * `buildExecution` supports (Aave/Spark/Compound/Morpho/Maker/Lido/WETH/
 * Rocket Pool/Frax/Uniswap/deBridge/LI.FI/transfers). A single, generalized
 * hook rather than one per protocol: every protocol already shares the same
 * pure `buildExecution`/`applySender`/`approveOrderFor` primitives, so this
 * is the one place that adds the live safety layer on top of all of them.
 *
 * State machine (see lib/executionPlan.ts for the full enum):
 *   DRAFT -> VALIDATING -> SIMULATING -> READY_FOR_SIGNATURE
 *     -> [APPROVAL_PENDING -> APPROVAL_CONFIRMED ->] SUPPLY_PENDING -> CONFIRMING -> CONFIRMED
 *
 * Safety properties:
 *   - for any wallet-debiting order (see isWalletDebitingAction), balance is
 *     read live (on-chain) before a plan is ever marked ready;
 *   - the exact call is simulated via `publicClient.simulateContract` before
 *     every signature, including a second simulation of the main order right
 *     after an approval mines (allowance is only live on-chain then);
 *   - allowance is read live so a sufficient existing approval is never
 *     re-signed — approve is skipped, not forced;
 *   - the approval amount is always exactly the order's amount, never unlimited;
 *   - `waitForTransactionReceipt` has an explicit timeout so a stalled RPC
 *     surfaces CONFIRMATION_TIMEOUT instead of hanging the UI forever;
 *   - nothing signs without an explicit `confirm()` call from a user click.
 */
export function useExecuteOrder(onConfirmed?: () => void): ExecuteOrderFlow {
  const { address, chainId: connectedChainId } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();
  // No chainId passed: every read/write below only ever runs after we've
  // already gated on connectedChainId === order.chainId, so the wallet's
  // default-connected-chain client is always the right one — and unlike a
  // literal number, it type-checks against wagmi's generated chain union.
  const publicClient = usePublicClient();

  const [plan, setPlan] = useState<OrderPlan | null>(null);
  const [builtPlan, setBuiltPlan] = useState<ExecutionPlan | null>(null);
  const [state, setState] = useState<OrderFlowState>("DRAFT");
  const [message, setMessage] = useState<string | null>(null);
  const [approvalHash, setApprovalHash] = useState<`0x${string}` | undefined>(undefined);
  const [mainHash, setMainHash] = useState<`0x${string}` | undefined>(undefined);
  const [needsApproval, setNeedsApproval] = useState<boolean | null>(null);

  const busyRef = useRef(false);

  const fail = useCallback((p: OrderPlan | null, failState: OrderFlowState, msg: string) => {
    logTransition(p ? { planId: p.planId, chainId: p.order.chainId, symbol: p.order.symbol } : null, failState, { message: msg });
    setState(failState);
    setMessage(msg);
  }, []);

  const reset = useCallback(() => {
    setPlan(null);
    setBuiltPlan(null);
    setState("DRAFT");
    setMessage(null);
    setApprovalHash(undefined);
    setMainHash(undefined);
    setNeedsApproval(null);
    busyRef.current = false;
  }, []);

  /** Resolve the approve order + its target spender (from the built approve plan's own args), when one applies. */
  const resolveApproval = useCallback(
    (order: Order): { approveOrder: Order; built: ExecutionPlan; spender: Address } | { approveOrder: null } | { error: string } => {
      const approveOrder = approveOrderFor(order);
      if (!approveOrder) return { approveOrder: null };
      const built = buildExecution(approveOrder);
      if ("error" in built) return { error: built.error };
      const spender = built.args?.[0] as Address | undefined;
      if (!spender) return { error: "could not resolve the approval spender" };
      return { approveOrder, built, spender };
    },
    [],
  );

  const prepare = useCallback(
    async (order: Order) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setApprovalHash(undefined);
      setMainHash(undefined);
      setMessage(null);
      try {
        if (!address) {
          fail(null, "WRONG_CHAIN", "Connect a wallet first.");
          return;
        }
        if (connectedChainId !== order.chainId) {
          fail(null, "WRONG_CHAIN", `Switch your wallet to chain ${order.chainId} before continuing.`);
          return;
        }
        const client = publicClient;
        if (!client) {
          fail(null, "RPC_ERROR", "No RPC connection available for this chain.");
          return;
        }

        const normalized = normalizeAmount(order.amount, order.decimals ?? 18);
        if ("error" in normalized) {
          fail(null, "INVALID_AMOUNT", normalized.error);
          return;
        }
        const orderWithExactAmount: Order = { ...order, amount: normalized.value };

        const newPlan = createOrderPlan(address, orderWithExactAmount);
        setPlan(newPlan);
        setState("VALIDATING");
        logTransition({ planId: newPlan.planId, chainId: newPlan.order.chainId, symbol: newPlan.order.symbol }, "VALIDATING");

        const built = buildExecution(orderWithExactAmount);
        if ("error" in built) {
          fail(newPlan, "SIMULATION_FAILED", built.error);
          return;
        }
        const patched = applySender(built, address);
        if ("error" in patched) {
          fail(newPlan, "SIMULATION_FAILED", patched.error);
          return;
        }
        setBuiltPlan(patched);

        let liveBalance: bigint | undefined;
        if (isWalletDebitingAction(orderWithExactAmount)) {
          if (patched.value !== undefined && patched.value > BigInt(0)) {
            liveBalance = await client.getBalance({ address }).catch(() => undefined);
          } else if (orderWithExactAmount.token) {
            liveBalance = await client
              .readContract({ address: orderWithExactAmount.token, abi: ERC20_ABI, functionName: "balanceOf", args: [address] })
              .catch(() => undefined);
          }
        }

        const validation = validateOrderPlan(newPlan, { connectedAddress: address, connectedChainId, liveBalance });
        if (!validation.ok) {
          fail(newPlan, validation.state, validation.message);
          return;
        }

        setState("SIMULATING");
        logTransition({ planId: newPlan.planId, chainId: newPlan.order.chainId, symbol: newPlan.order.symbol }, "SIMULATING");

        const approval = resolveApproval(orderWithExactAmount);
        if ("error" in approval) {
          fail(newPlan, "SIMULATION_FAILED", approval.error);
          return;
        }

        if (approval.approveOrder) {
          const liveAllowance = await client
            .readContract({
              address: orderWithExactAmount.token as Address,
              abi: ERC20_ALLOWANCE_ABI,
              functionName: "allowance",
              args: [address, approval.spender],
            })
            .catch(() => undefined);
          if (liveAllowance === undefined) {
            fail(newPlan, "RPC_ERROR", "Could not read your current allowance — try again.");
            return;
          }
          const willNeedApproval = liveAllowance < normalized.value;
          setNeedsApproval(willNeedApproval);

          try {
            if (willNeedApproval) {
              // Only the approve call can be simulated truthfully right now —
              // the main call would (correctly) revert against the current,
              // still-insufficient allowance. It gets simulated again, for
              // real, right after the approval is mined (see confirm()).
              await (client.simulateContract as SimulateAsync)({
                account: address,
                address: approval.built.address!,
                abi: approval.built.abi!,
                functionName: approval.built.functionName!,
                args: approval.built.args!,
              });
            } else if (patched.abi && patched.functionName && patched.args) {
              await (client.simulateContract as SimulateAsync)({
                account: address,
                address: patched.address!,
                abi: patched.abi,
                functionName: patched.functionName,
                args: patched.args,
                ...(patched.value !== undefined ? { value: patched.value } : {}),
              });
            } else if (patched.data !== undefined) {
              // Allowance already sufficient for a raw-calldata plan (e.g. a
              // router swap) — eth_call it directly, same as the no-approval path.
              await client.call({ account: address, to: patched.address, data: patched.data, value: patched.value });
            }
          } catch (err) {
            fail(newPlan, "SIMULATION_FAILED", `${willNeedApproval ? "Approval" : "Transaction"} would fail: ${err instanceof Error ? err.message : String(err)}`);
            return;
          }
        } else {
          setNeedsApproval(false);
          try {
            if (patched.abi && patched.functionName && patched.args) {
              await (client.simulateContract as SimulateAsync)({
                account: address,
                address: patched.address!,
                abi: patched.abi,
                functionName: patched.functionName,
                args: patched.args,
                ...(patched.value !== undefined ? { value: patched.value } : {}),
              });
            } else if (patched.data !== undefined) {
              // A raw-calldata plan (a router's quoted swap/bridge tx) has no
              // ABI to simulateContract against — eth_call it directly so a
              // revert is still caught before the wallet ever opens.
              await client.call({ account: address, to: patched.address, data: patched.data, value: patched.value });
            }
            // A plain native send (no abi, no data) has nothing meaningful to
            // simulate — the wallet's own gas estimation at signing time is
            // the check for that shape.
          } catch (err) {
            fail(newPlan, "SIMULATION_FAILED", `Transaction would fail: ${err instanceof Error ? err.message : String(err)}`);
            return;
          }
        }

        setState("READY_FOR_SIGNATURE");
        logTransition({ planId: newPlan.planId, chainId: newPlan.order.chainId, symbol: newPlan.order.symbol }, "READY_FOR_SIGNATURE");
      } finally {
        busyRef.current = false;
      }
    },
    [address, connectedChainId, publicClient, fail, resolveApproval],
  );

  const confirm = useCallback(async () => {
    if (busyRef.current) return;
    if (!plan || !builtPlan || state !== "READY_FOR_SIGNATURE") return;
    busyRef.current = true;
    try {
      const client = publicClient;
      if (!client) {
        fail(plan, "RPC_ERROR", "No RPC connection available for this chain.");
        return;
      }
      if (connectedChainId !== plan.order.chainId) {
        fail(plan, "WRONG_CHAIN", `Wrong network — switch to chain ${plan.order.chainId} before signing.`);
        return;
      }
      if (isPlanExpired(plan)) {
        fail(plan, "PLAN_EXPIRED", "This plan has expired — refresh and try again.");
        return;
      }
      if (!address) {
        fail(plan, "WRONG_CHAIN", "Wallet not connected.");
        return;
      }

      const order = plan.order;
      const approval = resolveApproval(order);
      if ("error" in approval) {
        fail(plan, "SIMULATION_FAILED", approval.error);
        return;
      }

      if (approval.approveOrder) {
        const liveAllowance = await client
          .readContract({
            address: order.token as Address,
            abi: ERC20_ALLOWANCE_ABI,
            functionName: "allowance",
            args: [address, approval.spender],
          })
          .catch(() => undefined);
        if (liveAllowance === undefined) {
          fail(plan, "RPC_ERROR", "Could not re-check your allowance — try again.");
          return;
        }
        const stillNeedsApproval = liveAllowance < (order.amount as bigint);
        setNeedsApproval(stillNeedsApproval);

        if (stillNeedsApproval) {
          setState("APPROVAL_PENDING");
          logTransition({ planId: plan.planId, chainId: order.chainId, symbol: order.symbol }, "APPROVAL_PENDING");
          let hash: `0x${string}`;
          try {
            hash = await (writeContractAsync as WriteAsync)({
              chainId: approval.built.chainId,
              address: approval.built.address,
              abi: approval.built.abi,
              functionName: approval.built.functionName,
              args: approval.built.args,
            });
          } catch (err) {
            const c = classifyExecutionError(err, "approval");
            fail(plan, c.state, c.message);
            return;
          }
          setApprovalHash(hash);
          logTransition({ planId: plan.planId, chainId: order.chainId, symbol: order.symbol }, "APPROVAL_PENDING", { hash });

          try {
            const receipt = await client.waitForTransactionReceipt({ hash, timeout: CONFIRMATION_TIMEOUT_MS });
            if (receipt.status === "reverted") {
              fail(plan, "APPROVAL_FAILED", "Approval transaction reverted on-chain.");
              return;
            }
          } catch (err) {
            const c = classifyExecutionError(err, "approval");
            fail(plan, c.state, c.message);
            return;
          }
          setState("APPROVAL_CONFIRMED");
          logTransition({ planId: plan.planId, chainId: order.chainId, symbol: order.symbol }, "APPROVAL_CONFIRMED", { hash });

          // Allowance is only live on-chain now — simulate the real main call
          // for real before asking for the second signature.
          try {
            if (builtPlan.abi && builtPlan.functionName && builtPlan.args) {
              await (client.simulateContract as SimulateAsync)({
                account: address,
                address: builtPlan.address!,
                abi: builtPlan.abi,
                functionName: builtPlan.functionName,
                args: builtPlan.args,
                ...(builtPlan.value !== undefined ? { value: builtPlan.value } : {}),
              });
            } else if (builtPlan.data !== undefined) {
              await client.call({ account: address, to: builtPlan.address, data: builtPlan.data, value: builtPlan.value });
            }
          } catch (err) {
            fail(plan, "SIMULATION_FAILED", `Transaction would fail after approval: ${err instanceof Error ? err.message : String(err)}`);
            return;
          }
        }
      }

      setState("SUPPLY_PENDING");
      logTransition({ planId: plan.planId, chainId: order.chainId, symbol: order.symbol }, "SUPPLY_PENDING");
      let hash: `0x${string}`;
      try {
        hash = await submitPlan(builtPlan, writeContractAsync as WriteAsync, sendTransactionAsync as WriteAsync);
      } catch (err) {
        const c = classifyExecutionError(err, "supply");
        fail(plan, c.state, c.message);
        recordExecution({
          type: recordTypeFor(order.type),
          label: `${builtPlan.description} (failed)`,
          asset: order.symbol,
          protocol: String(order.protocol),
          chainId: order.chainId,
          status: "error",
        });
        return;
      }
      setMainHash(hash);
      setState("CONFIRMING");
      logTransition({ planId: plan.planId, chainId: order.chainId, symbol: order.symbol }, "CONFIRMING", { hash });

      try {
        const receipt = await client.waitForTransactionReceipt({ hash, timeout: CONFIRMATION_TIMEOUT_MS });
        if (receipt.status === "reverted") {
          fail(plan, "TRANSACTION_REVERTED", "Transaction reverted on-chain.");
          recordExecution({
            type: recordTypeFor(order.type),
            label: `${builtPlan.description} (reverted)`,
            asset: order.symbol,
            protocol: String(order.protocol),
            chainId: order.chainId,
            status: "error",
            hash,
          });
          return;
        }
      } catch (err) {
        const c = classifyExecutionError(err, "supply");
        fail(plan, c.state, c.message);
        return;
      }

      setState("CONFIRMED");
      logTransition({ planId: plan.planId, chainId: order.chainId, symbol: order.symbol }, "CONFIRMED", { hash });
      recordExecution({
        type: recordTypeFor(order.type),
        label: builtPlan.description,
        asset: order.symbol,
        protocol: String(order.protocol),
        chainId: order.chainId,
        status: "confirmed",
        hash,
      });
      onConfirmed?.();
    } finally {
      busyRef.current = false;
    }
  }, [plan, builtPlan, state, address, connectedChainId, publicClient, writeContractAsync, sendTransactionAsync, fail, resolveApproval, onConfirmed]);

  return { state, plan, builtPlan, message, approvalHash, mainHash, needsApproval, prepare, confirm, reset };
}
