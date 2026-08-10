"use client";

import { useCallback, useRef, useState } from "react";
import { useAccount, useSendTransaction, useWriteContract } from "wagmi";
import { applySender, buildExecution, type ExecutionPlan, type Order } from "@/lib/execution";
import { mainnet, base, arbitrum, optimism, polygon, avalanche } from "wagmi/chains";
import { CHAIN_LABEL } from "@/lib/onchain";

export type ExecuteStatus = "idle" | "confirming" | "confirmed" | "error";

/**
 * Build a block-explorer tx URL for a chain id + tx hash, for surfacing a
 * confirmed transaction in the UI. Additive helper — `useExecute` itself is
 * unchanged in signature.
 */
export function explorerUrlFor(chainId: number, hash: `0x${string}`): string {
  const baseUrl: Record<number, string> = {
    [mainnet.id]: "https://etherscan.io/tx/",
    [base.id]: "https://basescan.org/tx/",
    [arbitrum.id]: "https://arbiscan.io/tx/",
    [optimism.id]: "https://optimistic.etherscan.io/tx/",
    [polygon.id]: "https://polygonscan.com/tx/",
    [avalanche.id]: "https://snowtrace.io/tx/",
  };
  return `${baseUrl[chainId] ?? `https://etherscan.io/tx/`}${hash}`;
}

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
  const { address, isConnected, chain } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();

  const [state, setState] = useState<ExecuteState>({ status: "idle" });
  /**
   * Idempotency guard: once a submission is in flight (or already confirmed),
   * any further call to `execute` is a no-op. A double-click / rapid re-click can
   * therefore never fire a second signature or a second broadcast. Reset only
   * via `reset`. Also guards against React 18 double-invocation of the callback.
   */
  const submittingRef = useRef(false);

  const execute = useCallback(
    async (order: Order) => {
      // ANTI DOUBLE-SUBMISSION: no-op while a submission is in flight. Repeat
      // clicks never re-sign or re-broadcast. Guard also resets on error.
      if (submittingRef.current) return;
      submittingRef.current = true;
      try {
        setState({ status: "idle" });

        if (!isConnected || !address) {
          setState({ status: "error", error: new Error("wallet not connected") });
          return;
        }

        // CHAIN-MATCH CHECK before building/signing: the order is for a specific
        // chainId; the wallet must be connected to that exact chain. If not, refuse
        // to build or sign so we never broadcast an order on the wrong network.
        const connectedChainId = chain?.id;
        if (connectedChainId !== undefined && order.chainId !== connectedChainId) {
          const label = CHAIN_LABEL[order.chainId] ?? `chain ${order.chainId}`;
          setState({ status: "error", error: new Error(`Wrong network - switch to ${label} before signing`) });
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
      } finally {
        submittingRef.current = false;
      }
    },
    [address, isConnected, chain, sendTransactionAsync, writeContractAsync],
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
