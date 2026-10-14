"use client";

import { useCallback, useRef, useState } from "react";
import { useAccount, usePublicClient, useSendTransaction, useWriteContract } from "wagmi";
import type { ExecutionPlan, Order } from "@/lib/execution";
import { logTransition, type OrderFlowState, type OrderPlan } from "@/lib/executionPlan";
import { reportExecution } from "@/lib/execLog";
import {
  executePreparedOrder,
  prepareOrder,
  type OrderRunnerClient,
  type OrderRunnerDeps,
  type PreparedOrder,
  type WriteAsync,
} from "@/lib/orderRunner";

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
 * React state machine around `lib/orderRunner` — the single validated
 * execution path (live balance + allowance reads, exact approvals,
 * simulation before every signature, receipt timeouts). See orderRunner.ts.
 *
 *   DRAFT -> VALIDATING -> SIMULATING -> READY_FOR_SIGNATURE
 *     -> [APPROVAL_PENDING -> APPROVAL_CONFIRMED ->] SUPPLY_PENDING -> CONFIRMING -> CONFIRMED
 *
 * Nothing signs without an explicit `confirm()` call from a user click.
 */
export function useExecuteOrder(onConfirmed?: () => void): ExecuteOrderFlow {
  const { address, chainId: connectedChainId } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();
  // The runner refuses to run unless the wallet is on the order's chain, so
  // the connected chain's client is always the right one.
  const publicClient = usePublicClient();

  const [prepared, setPrepared] = useState<PreparedOrder | null>(null);
  const [plan, setPlan] = useState<OrderPlan | null>(null);
  const [state, setState] = useState<OrderFlowState>("DRAFT");
  const [message, setMessage] = useState<string | null>(null);
  const [approvalHash, setApprovalHash] = useState<`0x${string}` | undefined>(undefined);
  const [mainHash, setMainHash] = useState<`0x${string}` | undefined>(undefined);

  const busyRef = useRef(false);

  const reset = useCallback(() => {
    setPrepared(null);
    setPlan(null);
    setState("DRAFT");
    setMessage(null);
    setApprovalHash(undefined);
    setMainHash(undefined);
    busyRef.current = false;
  }, []);

  const deps = useCallback((): OrderRunnerDeps | null => {
    if (!address || !publicClient) return null;
    return {
      address,
      connectedChainId,
      client: publicClient as unknown as OrderRunnerClient,
      writeContract: writeContractAsync as WriteAsync,
      sendTransaction: sendTransactionAsync as WriteAsync,
      onState: (s, info) => {
        setState(s);
        if (s === "APPROVAL_PENDING" && info?.hash) setApprovalHash(info.hash);
        if (s === "CONFIRMING" && info?.hash) setMainHash(info.hash);
      },
    };
  }, [address, connectedChainId, publicClient, writeContractAsync, sendTransactionAsync]);

  const prepare = useCallback(
    async (order: Order) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setPrepared(null);
      setPlan(null);
      setApprovalHash(undefined);
      setMainHash(undefined);
      setMessage(null);
      try {
        const d = deps();
        if (!d) {
          const msg = address ? "No RPC connection available for this chain." : "Connect a wallet first.";
          const s = address ? "RPC_ERROR" : "WRONG_CHAIN";
          logTransition(null, s, { message: msg });
          if (address) reportExecution({ state: s, chainId: order.chainId, protocol: order.protocol, type: order.type, symbol: order.symbol, address, reason: msg });
          setState(s);
          setMessage(msg);
          return;
        }
        const res = await prepareOrder(d, order);
        if (!res.ok) {
          setPlan(res.plan ?? null);
          setMessage(res.message);
          return;
        }
        setPlan(res.plan);
        setPrepared(res);
      } finally {
        busyRef.current = false;
      }
    },
    [deps, address],
  );

  const confirm = useCallback(async () => {
    if (busyRef.current || !prepared || state !== "READY_FOR_SIGNATURE") return;
    busyRef.current = true;
    try {
      const d = deps();
      if (!d) {
        setState("WRONG_CHAIN");
        setMessage("Wallet not connected.");
        return;
      }
      const res = await executePreparedOrder(d, prepared);
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      onConfirmed?.();
    } finally {
      busyRef.current = false;
    }
  }, [prepared, state, deps, onConfirmed]);

  return {
    state,
    plan,
    builtPlan: prepared?.built ?? null,
    message,
    approvalHash,
    mainHash,
    needsApproval: prepared ? prepared.needsApproval : null,
    prepare,
    confirm,
    reset,
  };
}
