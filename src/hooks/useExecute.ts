"use client";

import { useCallback, useState } from "react";
import { useAccount, useSendTransaction, useWriteContract } from "wagmi";
import { applySender, buildExecution, type ExecutionPlan, type Order } from "@/lib/execution";

export type ExecuteStatus = "idle" | "confirming" | "confirmed" | "error";

export interface ExecuteState {
  status: ExecuteStatus;
  /** Transaction hash once the wallet signs and the tx is broadcast. */
  data?: `0x${string}`;
  /** Signer rejection or any other execution error. */
  error?: unknown;
}

export interface UseExecuteResult extends ExecuteState {
  /** Build a plan from an order and submit it to the wallet (NEVER auto-called — only from an explicit UI click). */
  execute: (order: Order) => Promise<void>;
  /** Return to idle and clear data/error. */
  reset: () => void;
}

/**
 * Real wagmi write harness. Reads the connected account, refuses to execute when
 * disconnected, converts the order into a plan, patches the onBehalfOf sender,
 * then submits via useWriteContract (Aave) or useSendTransaction (native ETH).
 * Uses the promise-returning `*Async` variants so we own the
 * idle → confirming → confirmed / error state machine ourselves.
 *
 * SAFETY: `execute` is only ever invoked by an explicit UI click. Nothing here
 * auto-submits; we never simulate — the wallet itself must sign and broadcast.
 * The ABI/args are validated by `buildExecution` (pure) before any write.
 */
export function useExecute(): UseExecuteResult {
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();

  const [state, setState] = useState<ExecuteState>({ status: "idle" });

  const execute = useCallback(
    async (order: Order) => {
      setState({ status: "idle" });

      if (!isConnected || !address) {
        setState({ status: "error", error: new Error("wallet not connected") });
        return;
      }

      const built = buildExecution(order);
      if ("error" in built) {
        setState({ status: "error", error: new Error(built.error) });
        return;
      }

      const plan = applySender(built, address);
      if ("error" in plan) {
        setState({ status: "error", error: new Error(plan.error) });
        return;
      }

      setState({ status: "confirming" });
      try {
        const hash = await submitPlan(plan, writeContractAsync, sendTransactionAsync);
        setState({ status: "confirmed", data: hash });
      } catch (err) {
        // Catches both user signer-rejection (e.g. code 4001) and RPC failures.
        setState({ status: "error", error: err });
      }
    },
    [address, isConnected, sendTransactionAsync, writeContractAsync],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);

  return { ...state, execute, reset };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Route a finished plan to the right wagmi call. Native transfers carry `value`;
 * everything else is a contract write against the plan's ABI.
 *
 * The plan's runtime ABI is intentionally cleared to `any` here: `buildExecution`
 * guarantees abi/functionName/args are a self-consistent set, but wagmi's
 * compile-time literal typing can't know values that arrived from a serializable
 * plan, so we bypass its per-literal narrowing once (the plan is already validated).
 */
type WriteAsync = (args: any) => Promise<`0x${string}`>;

async function submitPlan(
  plan: ExecutionPlan,
  writeContractAsync: WriteAsync,
  sendTransactionAsync: WriteAsync,
): Promise<`0x${string}`> {
  if (plan.value !== undefined) {
    if (!plan.address) throw new Error("native transfer is missing a recipient (address)");
    return sendTransactionAsync({ chainId: plan.chainId, to: plan.address, value: plan.value });
  }
  if (!plan.address || !plan.abi || !plan.functionName || !plan.args) {
    throw new Error("execution plan is missing required write fields");
  }
  return writeContractAsync({
    chainId: plan.chainId,
    address: plan.address,
    abi: plan.abi,
    functionName: plan.functionName,
    args: plan.args,
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */
