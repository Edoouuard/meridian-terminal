"use client";

import { useCallback, useRef, useState } from "react";
import { useAccount, useSendTransaction, useWriteContract, usePublicClient, useSwitchChain } from "wagmi";
import { applySender, buildExecution, type ExecutionPlan, type Order } from "@/lib/execution";
import { approveOrderFor } from "@/lib/assetMap";
import { needsAllowanceReset } from "@/lib/integrations/usdt";
import { CHAIN_LABEL } from "@/lib/onchain";

export type LegStatus = "pending" | "switching-chain" | "approving" | "executing" | "confirmed" | "error" | "skipped";

export interface LegProgress {
  index: number;
  status: LegStatus;
  hash?: `0x${string}`;
  error?: string;
}

export type StrategyStatus = "idle" | "running" | "completed" | "error" | "cancelled";

export interface StrategyProgress {
  status: StrategyStatus;
  legs: LegProgress[];
  /** Index of the leg currently being executed (or the last one attempted). */
  currentLeg: number;
}

export interface UseStrategyExecutorResult {
  progress: StrategyProgress;
  /** Execute a list of orders sequentially. Handles chain switching, approvals, and waiting for receipts. */
  executeAll: (orders: Order[]) => Promise<void>;
  /** Cancel the remaining legs (current in-flight tx still completes). */
  cancel: () => void;
  /** Reset back to idle. */
  reset: () => void;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
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
  if (plan.value !== undefined || plan.data !== undefined) {
    if (!plan.address) throw new Error("native transfer is missing a recipient (address)");
    return sendTransactionAsync({ chainId: plan.chainId, to: plan.address, value: plan.value, data: plan.data });
  }
  throw new Error("execution plan is missing required write fields");
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Orchestrates sequential execution of multiple strategy legs.
 * Handles chain switching, USDT double-approve, approval + main tx flow,
 * and tracks progress per leg.
 */
export function useStrategyExecutor(): UseStrategyExecutorResult {
  const { address, isConnected, chain } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient();

  const [progress, setProgress] = useState<StrategyProgress>({
    status: "idle",
    legs: [],
    currentLeg: 0,
  });

  const cancelledRef = useRef(false);
  const runningRef = useRef(false);

  const updateLeg = useCallback((index: number, update: Partial<LegProgress>) => {
    setProgress((prev) => {
      const legs = [...prev.legs];
      legs[index] = { ...legs[index], ...update };
      return { ...prev, legs, currentLeg: index };
    });
  }, []);

  const executeAll = useCallback(
    async (orders: Order[]) => {
      if (runningRef.current || !isConnected || !address) return;
      runningRef.current = true;
      cancelledRef.current = false;

      const initialLegs: LegProgress[] = orders.map((_, i) => ({ index: i, status: "pending" as const }));
      setProgress({ status: "running", legs: initialLegs, currentLeg: 0 });

      let hasError = false;

      for (let i = 0; i < orders.length; i++) {
        if (cancelledRef.current) {
          for (let j = i; j < orders.length; j++) {
            updateLeg(j, { status: "skipped" });
          }
          setProgress((prev) => ({ ...prev, status: "cancelled" }));
          break;
        }

        const order = orders[i];

        // Step 1: Switch chain if needed
        const connectedChainId = chain?.id;
        if (connectedChainId !== undefined && order.chainId !== connectedChainId) {
          updateLeg(i, { status: "switching-chain" });
          try {
            await switchChainAsync({ chainId: order.chainId as Parameters<typeof switchChainAsync>[0]["chainId"] });
          } catch (err) {
            const label = CHAIN_LABEL[order.chainId] ?? `chain ${order.chainId}`;
            updateLeg(i, { status: "error", error: `Failed to switch to ${label}` });
            hasError = true;
            // Skip remaining legs
            for (let j = i + 1; j < orders.length; j++) {
              updateLeg(j, { status: "skipped" });
            }
            break;
          }
        }

        // Step 2: Build approve if needed
        const approve = approveOrderFor(order);

        // Step 3: Handle USDT double-approve
        if (approve && needsAllowanceReset(approve.token) && publicClient) {
          updateLeg(i, { status: "approving" });
          try {
            const resetOrder: Order = { ...approve, amount: BigInt(0) };
            const resetBuilt = buildExecution(resetOrder);
            if (!("error" in resetBuilt)) {
              const resetPlan = applySender(resetBuilt, address);
              if (!("error" in resetPlan)) {
                const resetHash = await submitPlan(resetPlan, writeContractAsync, sendTransactionAsync);
                await publicClient.waitForTransactionReceipt({ hash: resetHash });
              }
            }
          } catch {
            // If reset fails (allowance already 0), continue
          }
        }

        // Step 4: Approve (if needed)
        if (approve) {
          updateLeg(i, { status: "approving" });
          const approveBuilt = buildExecution(approve);
          if ("error" in approveBuilt) {
            updateLeg(i, { status: "error", error: approveBuilt.error });
            hasError = true;
            for (let j = i + 1; j < orders.length; j++) updateLeg(j, { status: "skipped" });
            break;
          }
          const approvePlan = applySender(approveBuilt, address);
          if ("error" in approvePlan) {
            updateLeg(i, { status: "error", error: approvePlan.error });
            hasError = true;
            for (let j = i + 1; j < orders.length; j++) updateLeg(j, { status: "skipped" });
            break;
          }
          try {
            const approveHash = await submitPlan(approvePlan, writeContractAsync, sendTransactionAsync);
            if (publicClient) {
              await publicClient.waitForTransactionReceipt({ hash: approveHash });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/reject|declined|user denied|4001/i.test(msg)) {
              updateLeg(i, { status: "error", error: "Approval rejected in wallet" });
            } else {
              updateLeg(i, { status: "error", error: `Approval failed: ${msg}` });
            }
            hasError = true;
            for (let j = i + 1; j < orders.length; j++) updateLeg(j, { status: "skipped" });
            break;
          }
        }

        // Step 5: Main transaction
        updateLeg(i, { status: "executing" });
        const built = buildExecution(order);
        if ("error" in built) {
          updateLeg(i, { status: "error", error: built.error });
          hasError = true;
          for (let j = i + 1; j < orders.length; j++) updateLeg(j, { status: "skipped" });
          break;
        }
        const plan = applySender(built, address);
        if ("error" in plan) {
          updateLeg(i, { status: "error", error: plan.error });
          hasError = true;
          for (let j = i + 1; j < orders.length; j++) updateLeg(j, { status: "skipped" });
          break;
        }

        try {
          const hash = await submitPlan(plan, writeContractAsync, sendTransactionAsync);
          // Wait for confirmation before moving to next leg
          if (publicClient) {
            await publicClient.waitForTransactionReceipt({ hash });
          }
          updateLeg(i, { status: "confirmed", hash });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/reject|declined|user denied|4001/i.test(msg)) {
            updateLeg(i, { status: "error", error: "Rejected in wallet" });
          } else {
            updateLeg(i, { status: "error", error: `Transaction failed: ${msg}` });
          }
          hasError = true;
          for (let j = i + 1; j < orders.length; j++) updateLeg(j, { status: "skipped" });
          break;
        }
      }

      if (!cancelledRef.current) {
        setProgress((prev) => ({ ...prev, status: hasError ? "error" : "completed" }));
      }
      runningRef.current = false;
    },
    [address, isConnected, chain, switchChainAsync, publicClient, writeContractAsync, sendTransactionAsync, updateLeg],
  );

  const cancel = useCallback(() => {
    cancelledRef.current = true;
  }, []);

  const reset = useCallback(() => {
    setProgress({ status: "idle", legs: [], currentLeg: 0 });
    cancelledRef.current = false;
    runningRef.current = false;
  }, []);

  return { progress, executeAll, cancel, reset };
}
