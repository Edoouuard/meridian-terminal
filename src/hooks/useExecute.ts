"use client";

import { useCallback, useRef, useState } from "react";
import { useAccount, useSendTransaction, useWriteContract, usePublicClient } from "wagmi";
import { applySender, buildExecution, type ExecutionPlan, type Order } from "@/lib/execution";
import { mainnet, base, arbitrum, optimism, polygon, avalanche } from "wagmi/chains";
import { CHAIN_LABEL } from "@/lib/onchain";
import { needsAllowanceReset } from "@/lib/integrations/usdt";

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
  /**
   * Execute an optional approve step, WAIT for it to be mined on-chain, then
   * execute the main order. This is required for any flow where the main tx
   * depends on allowance set by the approve (Morpho deposit, Aave supply,
   * Uniswap swap, Lido unstake). Without waiting for the approve to be mined,
   * the main tx reverts because the allowance doesn't exist yet.
   */
  executeWithApproval: (approve: Order | null, order: Order) => Promise<void>;
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
  const publicClient = usePublicClient();

  const [state, setState] = useState<ExecuteState>({ status: "idle" });
  /**
   * Idempotency guard: once a submission is in flight (or already confirmed),
   * any further call to `execute` is a no-op. A double-click / rapid re-click can
   * therefore never fire a second signature or a second broadcast. Reset only
   * via `reset`. Also guards against React 18 double-invocation of the callback.
   */
  const submittingRef = useRef(false);

  /** Validate common preconditions (wallet connected, correct chain). Returns the built+patched plan or sets error state and returns null. */
  const preparePlan = useCallback(
    (order: Order): ExecutionPlan | null => {
      if (!isConnected || !address) {
        setState({ status: "error", error: new Error("wallet not connected") });
        return null;
      }
      const connectedChainId = chain?.id;
      if (connectedChainId !== undefined && order.chainId !== connectedChainId) {
        const label = CHAIN_LABEL[order.chainId] ?? `chain ${order.chainId}`;
        setState({ status: "error", error: new Error(`Wrong network - switch to ${label} before signing`) });
        return null;
      }
      const built = buildExecution(order);
      if ("error" in built) {
        setState({ status: "error", error: new Error(built.error) });
        return null;
      }
      const plan = applySender(built, address);
      if ("error" in plan) {
        setState({ status: "error", error: new Error(plan.error) });
        return null;
      }
      return plan;
    },
    [address, isConnected, chain],
  );

  const execute = useCallback(
    async (order: Order) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      try {
        setState({ status: "idle" });
        const plan = preparePlan(order);
        if (!plan) return;

        setState({ status: "confirming" });
        try {
          const hash = await submitPlan(plan, writeContractAsync, sendTransactionAsync);
          setState({ status: "confirmed", data: hash });
        } catch (err) {
          setState({ status: "error", error: err });
        }
      } finally {
        submittingRef.current = false;
      }
    },
    [preparePlan, sendTransactionAsync, writeContractAsync],
  );

  const executeWithApproval = useCallback(
    async (approve: Order | null, order: Order) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      try {
        setState({ status: "idle" });

        // Step 1: approve (if needed) — sign, broadcast, and WAIT for it to be mined.
        // USDT quirk: its approve() reverts if the current allowance is > 0.
        // We must first approve(spender, 0) and wait for it to mine, then
        // approve(spender, amount). This is harmless for standard ERC20s but
        // required for USDT on every chain.
        if (approve) {
          // Step 1a: for USDT-like tokens, reset allowance to 0 first.
          if (needsAllowanceReset(approve.token) && publicClient) {
            const resetOrder: Order = { ...approve, amount: BigInt(0) };
            const resetPlan = preparePlan(resetOrder);
            if (!resetPlan) return;

            setState({ status: "confirming" });
            try {
              const resetHash = await submitPlan(resetPlan, writeContractAsync, sendTransactionAsync);
              await publicClient.waitForTransactionReceipt({ hash: resetHash });
            } catch (err) {
              // If the reset fails (e.g. allowance was already 0), continue —
              // the actual approve below will either succeed or give its own error.
            }
          }

          // Step 1b: set the actual allowance.
          const approvePlan = preparePlan(approve);
          if (!approvePlan) return;

          setState({ status: "confirming" });
          let approveHash: `0x${string}`;
          try {
            approveHash = await submitPlan(approvePlan, writeContractAsync, sendTransactionAsync);
          } catch (err) {
            setState({ status: "error", error: err });
            return;
          }

          // Wait for the approve tx to be mined so the allowance is live on-chain
          // before we submit the main tx. Without this, the main tx (deposit/swap)
          // reverts because the allowance doesn't exist yet.
          if (publicClient) {
            try {
              await publicClient.waitForTransactionReceipt({ hash: approveHash });
            } catch (err) {
              setState({ status: "error", error: new Error(`Approve tx failed on-chain: ${err instanceof Error ? err.message : String(err)}`) });
              return;
            }
          }
        }

        // Step 2: main order (deposit/swap/supply) — now that allowance is confirmed on-chain.
        const mainPlan = preparePlan(order);
        if (!mainPlan) return;

        setState({ status: "confirming" });
        try {
          const hash = await submitPlan(mainPlan, writeContractAsync, sendTransactionAsync);
          setState({ status: "confirmed", data: hash });
        } catch (err) {
          setState({ status: "error", error: err });
        }
      } finally {
        submittingRef.current = false;
      }
    },
    [preparePlan, publicClient, sendTransactionAsync, writeContractAsync],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);

  return { ...state, execute, executeWithApproval, reset };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Route a finished plan to the right wagmi call:
 *   - a plan with an ABI (Aave, Lido's payable `submit`, ...) is a contract
 *     write — `value` rides along when the call is itself payable (Lido).
 *   - a plan with no ABI but a `value` is a plain native transfer.
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
  if (plan.value !== undefined) {
    if (!plan.address) throw new Error("native transfer is missing a recipient (address)");
    return sendTransactionAsync({ chainId: plan.chainId, to: plan.address, value: plan.value });
  }
  throw new Error("execution plan is missing required write fields");
}
/* eslint-enable @typescript-eslint/no-explicit-any */
