"use client";

import { useCallback, useRef, useState } from "react";
import { useAccount, useConfig, useSendTransaction, useSwitchChain, useWriteContract } from "wagmi";
import { getAccount, getPublicClient } from "wagmi/actions";
import { useQueryClient } from "@tanstack/react-query";
import type { Order } from "@/lib/execution";
import { CHAIN_LABEL } from "@/lib/onchain";
import { executePreparedOrder, prepareOrder, type OrderRunnerClient, type WriteAsync } from "@/lib/orderRunner";

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

/**
 * Runs a multi-leg strategy sequentially. Every leg goes through the same
 * validated path as a single order (`lib/orderRunner`): live balance and
 * allowance reads, exact approvals, simulation before each signature. The
 * user confirms the whole strategy once; a leg that fails validation or
 * simulation stops the run before anything is signed for it.
 */
export function useStrategyExecutor(): UseStrategyExecutorResult {
  const { address, isConnected } = useAccount();
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();
  const queryClient = useQueryClient();

  const [progress, setProgress] = useState<StrategyProgress>({ status: "idle", legs: [], currentLeg: 0 });
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
      setProgress({ status: "running", legs: orders.map((_, i) => ({ index: i, status: "pending" as const })), currentLeg: 0 });

      const stopAt = (i: number, error: string) => {
        updateLeg(i, { status: "error", error });
        for (let j = i + 1; j < orders.length; j++) updateLeg(j, { status: "skipped" });
      };

      let hasError = false;
      for (let i = 0; i < orders.length; i++) {
        if (cancelledRef.current) {
          for (let j = i; j < orders.length; j++) updateLeg(j, { status: "skipped" });
          setProgress((prev) => ({ ...prev, status: "cancelled" }));
          break;
        }
        const order = orders[i];

        // Read the live connected chain (the hook's render-time value goes stale after a switch).
        if (getAccount(config).chainId !== order.chainId) {
          updateLeg(i, { status: "switching-chain" });
          try {
            await switchChainAsync({ chainId: order.chainId as Parameters<typeof switchChainAsync>[0]["chainId"] });
          } catch {
            stopAt(i, `Failed to switch to ${CHAIN_LABEL[order.chainId] ?? `chain ${order.chainId}`}`);
            hasError = true;
            break;
          }
        }

        const client = getPublicClient(config, { chainId: order.chainId as Parameters<typeof switchChainAsync>[0]["chainId"] });
        if (!client) {
          stopAt(i, `No RPC connection for ${CHAIN_LABEL[order.chainId] ?? `chain ${order.chainId}`}`);
          hasError = true;
          break;
        }
        const deps = {
          address,
          connectedChainId: getAccount(config).chainId,
          client: client as unknown as OrderRunnerClient,
          writeContract: writeContractAsync as WriteAsync,
          sendTransaction: sendTransactionAsync as WriteAsync,
          onState: (s: string) => {
            if (s === "APPROVAL_PENDING") updateLeg(i, { status: "approving" });
            if (s === "SUPPLY_PENDING") updateLeg(i, { status: "executing" });
          },
        };

        const prepared = await prepareOrder(deps, order);
        if (!prepared.ok) {
          stopAt(i, prepared.message);
          hasError = true;
          break;
        }
        const result = await executePreparedOrder(deps, prepared);
        if (!result.ok) {
          stopAt(i, result.message);
          hasError = true;
          break;
        }
        updateLeg(i, { status: "confirmed", hash: result.hash });
      }

      if (!cancelledRef.current) setProgress((prev) => ({ ...prev, status: hasError ? "error" : "completed" }));
      // Refresh portfolio reads after execution.
      queryClient.invalidateQueries({ queryKey: ["readContracts"] });
      queryClient.invalidateQueries({ queryKey: ["balance"] });
      queryClient.invalidateQueries({ queryKey: ["readContract"] });
      runningRef.current = false;
    },
    [address, isConnected, config, switchChainAsync, writeContractAsync, sendTransactionAsync, updateLeg, queryClient],
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
