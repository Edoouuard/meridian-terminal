"use client";

import { useCallback, useRef, useState } from "react";
import { useAccount, useSendTransaction, useWriteContract, usePublicClient, useSwitchChain } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import type { Address } from "viem";
import { applySender, buildExecution, type ExecutionPlan, type Order } from "@/lib/execution";
import { mainnet, base, arbitrum, optimism, polygon, avalanche, bsc, gnosis, scroll, zkSync, linea, mantle, metis, fantom, sonic, celo } from "wagmi/chains";
import { CHAIN_LABEL, ERC20_ABI, ERC20_ALLOWANCE_ABI } from "@/lib/onchain";
import { needsAllowanceReset } from "@/lib/integrations/usdt";
import { normalizeAmount } from "@/lib/execution";
import { formatBaseUnits } from "@/lib/quote";

export type ExecuteStatus =
  | "idle"
  | "validating"
  | "simulating"
  | "ready"
  | "approving"
  | "confirming"
  | "waiting_receipt"
  | "confirmed"
  | "error";

/**
 * Build a block-explorer tx URL for a chain id + tx hash, for surfacing a
 * confirmed transaction in the UI. Covers all 16 supported chains.
 */
export function explorerUrlFor(chainId: number, hash: `0x${string}`): string {
  const baseUrl: Record<number, string> = {
    [mainnet.id]: "https://etherscan.io/tx/",
    [base.id]: "https://basescan.org/tx/",
    [arbitrum.id]: "https://arbiscan.io/tx/",
    [optimism.id]: "https://optimistic.etherscan.io/tx/",
    [polygon.id]: "https://polygonscan.com/tx/",
    [avalanche.id]: "https://snowtrace.io/tx/",
    [bsc.id]: "https://bscscan.com/tx/",
    [gnosis.id]: "https://gnosisscan.io/tx/",
    [scroll.id]: "https://scrollscan.com/tx/",
    [zkSync.id]: "https://era.zksync.network/tx/",
    [linea.id]: "https://lineascan.build/tx/",
    [mantle.id]: "https://mantlescan.xyz/tx/",
    [metis.id]: "https://andromeda-explorer.metis.io/tx/",
    [fantom.id]: "https://ftmscan.com/tx/",
    [sonic.id]: "https://sonicscan.org/tx/",
    [celo.id]: "https://celoscan.io/tx/",
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
   * Validate, check balance/allowance, simulate, then execute an optional
   * approve step + the main order. Waits for on-chain receipt before reporting
   * confirmed. Skips the approve when the existing allowance is sufficient.
   */
  executeWithApproval: (approve: Order | null, order: Order) => Promise<void>;
  /** Return to idle and clear data/error. */
  reset: () => void;
}

/**
 * Real wagmi write harness with full pre-sign validation:
 *
 * 1. Wallet connected + correct chain (auto-switch offered)
 * 2. Token balance check (rejects insufficient balance before signing)
 * 3. Allowance check (skips approve when existing allowance covers the amount)
 * 4. Transaction simulation via publicClient.simulateContract
 * 5. Wallet signature (writeContractAsync / sendTransactionAsync)
 * 6. Receipt confirmation (waitForTransactionReceipt)
 * 7. Portfolio cache invalidation after confirmed receipt
 *
 * State machine:
 *   idle → validating → simulating → ready → approving? → confirming
 *        → waiting_receipt → confirmed
 *   Any step can → error
 *
 * SAFETY: execution only ever happens on an explicit UI click. Nothing
 * auto-submits. The idempotency guard prevents double-signing.
 */
export function useExecute(): UseExecuteResult {
  const { address, isConnected, chain } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();

  const [state, setState] = useState<ExecuteState>({ status: "idle" });
  const submittingRef = useRef(false);

  /** Build + patch a plan from an order. Returns null and sets error state on failure. */
  const preparePlan = useCallback(
    (order: Order): ExecutionPlan | null => {
      if (!isConnected || !address) {
        setState({ status: "error", error: new Error("wallet not connected") });
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
    [address, isConnected],
  );

  /**
   * Check that the wallet is on the correct chain. Auto-switches if possible.
   * Returns true if ready, false if error was set.
   */
  const ensureChain = useCallback(
    async (order: Order): Promise<boolean> => {
      const connectedChainId = chain?.id;
      if (connectedChainId !== undefined && order.chainId !== connectedChainId) {
        try {
          await switchChainAsync({ chainId: order.chainId as Parameters<typeof switchChainAsync>[0]["chainId"] });
          return true;
        } catch {
          const label = CHAIN_LABEL[order.chainId] ?? `chain ${order.chainId}`;
          setState({ status: "error", error: new Error(`Switch to ${label} to continue`) });
          return false;
        }
      }
      return true;
    },
    [chain, switchChainAsync],
  );

  /**
   * Read the on-chain ERC20 balance of the token for the connected wallet.
   * For native value transfers (ETH), checks native balance instead.
   * Returns the balance in base units, or null on read failure.
   */
  const readTokenBalance = useCallback(
    async (order: Order): Promise<bigint | null> => {
      if (!publicClient || !address) return null;
      // Native transfer — check native balance
      if (order.protocol === "eth" && order.type === "transfer") {
        try {
          return await publicClient.getBalance({ address });
        } catch {
          return null;
        }
      }
      // Payable calls (Lido stake, Rocket Pool, Frax, WETH wrap) — check native balance for value
      if (order.type === "stake" || (order.protocol === "weth" && order.type === "supply")) {
        try {
          return await publicClient.getBalance({ address });
        } catch {
          return null;
        }
      }
      // ERC20 — read balanceOf
      if (!order.token) return null;
      try {
        const result = await publicClient.readContract({
          address: order.token,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [address],
        });
        return result as bigint;
      } catch {
        return null;
      }
    },
    [publicClient, address],
  );

  /**
   * Read the on-chain ERC20 allowance for a token+spender pair.
   * Returns the allowance in base units, or null on read failure.
   */
  const readAllowance = useCallback(
    async (token: Address, spender: Address): Promise<bigint | null> => {
      if (!publicClient || !address) return null;
      try {
        const result = await publicClient.readContract({
          address: token,
          abi: ERC20_ALLOWANCE_ABI,
          functionName: "allowance",
          args: [address, spender],
        });
        return result as bigint;
      } catch {
        return null;
      }
    },
    [publicClient, address],
  );

  /**
   * Simulate a contract call via the public client. Returns true if simulation
   * succeeds, false if it reverts. For native-value-only plans (no ABI),
   * simulation is skipped (nothing to simulate).
   */
  const simulatePlan = useCallback(
    async (plan: ExecutionPlan): Promise<{ ok: boolean; error?: string }> => {
      if (!publicClient || !address) return { ok: true };
      // Native transfer — no contract to simulate
      if (!plan.abi || !plan.functionName || !plan.args) return { ok: true };
      if (!plan.address) return { ok: true };
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const simParams: any = {
          account: address,
          address: plan.address,
          abi: plan.abi,
          functionName: plan.functionName,
          args: [...plan.args],
        };
        if (plan.value !== undefined) simParams.value = plan.value;
        await (publicClient as any).simulateContract(simParams);
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Extract a readable revert reason if present
        const revertMatch = /reverted with reason string '([^']+)'/.exec(msg)
          ?? /reason="([^"]+)"/.exec(msg)
          ?? /Error: ([A-Z_]+)\(/.exec(msg);
        const reason = revertMatch?.[1] ?? msg;
        return { ok: false, error: `Simulation failed: ${reason}` };
      }
    },
    [publicClient, address],
  );

  /**
   * Resolve the required order amount in base units for balance comparison.
   */
  function resolveOrderAmount(order: Order): bigint | null {
    if (typeof order.amount === "bigint") return order.amount;
    if (typeof order.amount === "string") {
      const result = normalizeAmount(order.amount, order.decimals ?? 18);
      if ("value" in result) return result.value;
    }
    return null;
  }

  /**
   * Determine the spender address from an approve order's built plan.
   * For Aave: the pool. For Uniswap: the router. For Morpho: the vault.
   */
  function resolveSpenderFromApprove(approveOrder: Order): Address | null {
    const built = buildExecution(approveOrder);
    if ("error" in built) return null;
    // For approve plans, args[0] is the spender
    if (built.args && built.args.length > 0) return built.args[0] as Address;
    return null;
  }

  /** Invalidate wagmi's cached on-chain reads so portfolio refreshes. */
  const invalidatePortfolio = useCallback(() => {
    // Wagmi stores useReadContracts/useBalance results under TanStack Query
    // keys prefixed with "readContracts" and "balance". Invalidating broadly
    // ensures the portfolio, token balances, and lending positions all refetch.
    queryClient.invalidateQueries({ queryKey: ["readContracts"] });
    queryClient.invalidateQueries({ queryKey: ["balance"] });
    queryClient.invalidateQueries({ queryKey: ["readContract"] });
  }, [queryClient]);

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
          // Wait for on-chain receipt
          setState({ status: "waiting_receipt", data: hash });
          if (publicClient) {
            try {
              const receipt = await publicClient.waitForTransactionReceipt({ hash });
              if (receipt.status === "reverted") {
                setState({ status: "error", data: hash, error: new Error("Transaction reverted on-chain") });
                return;
              }
            } catch (err) {
              setState({ status: "error", data: hash, error: new Error(`Receipt failed: ${err instanceof Error ? err.message : String(err)}`) });
              return;
            }
          }
          setState({ status: "confirmed", data: hash });
          invalidatePortfolio();
        } catch (err) {
          setState({ status: "error", error: err });
        }
      } finally {
        submittingRef.current = false;
      }
    },
    [preparePlan, sendTransactionAsync, writeContractAsync, publicClient, invalidatePortfolio],
  );

  const executeWithApproval = useCallback(
    async (approve: Order | null, order: Order) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      try {
        setState({ status: "validating" });

        // ── 1. Ensure correct chain ──────────────────────────────────
        if (!(await ensureChain(order))) return;

        // ── 2. Balance check ─────────────────────────────────────────
        const requiredAmount = resolveOrderAmount(order);
        if (requiredAmount !== null) {
          const balance = await readTokenBalance(order);
          if (balance !== null && balance < requiredAmount) {
            const decimals = order.decimals ?? 18;
              const humanBalance = formatBaseUnits(balance, decimals);
            const humanRequired = formatBaseUnits(requiredAmount, decimals);
            setState({
              status: "error",
              error: new Error(
                `Insufficient ${order.symbol ?? "token"} balance: you have ${humanBalance} but need ${humanRequired}`,
              ),
            });
            return;
          }
        }

        // ── 3. Allowance check (skip approve if sufficient) ──────────
        let needsApprove = !!approve;
        if (approve && approve.token && requiredAmount !== null) {
          const spender = resolveSpenderFromApprove(approve);
          if (spender) {
            const currentAllowance = await readAllowance(approve.token, spender);
            if (currentAllowance !== null && currentAllowance >= requiredAmount) {
              needsApprove = false; // existing allowance covers the amount
            }
          }
        }

        // ── 4. Build and simulate the main plan ──────────────────────
        setState({ status: "simulating" });
        const mainPlan = preparePlan(order);
        if (!mainPlan) return;

        const simResult = await simulatePlan(mainPlan);
        if (!simResult.ok) {
          setState({ status: "error", error: new Error(simResult.error ?? "Transaction simulation failed") });
          return;
        }

        // ── 5. Approve (if needed) ───────────────────────────────────
        if (needsApprove && approve) {
          setState({ status: "approving" });

          // USDT quirk: reset allowance to 0 first if current > 0
          if (needsAllowanceReset(approve.token) && publicClient) {
            const resetOrder: Order = { ...approve, amount: BigInt(0) };
            const resetPlan = preparePlan(resetOrder);
            if (resetPlan) {
              try {
                const resetHash = await submitPlan(resetPlan, writeContractAsync, sendTransactionAsync);
                await publicClient.waitForTransactionReceipt({ hash: resetHash });
              } catch {
                // If the reset fails (allowance was already 0), continue
              }
            }
          }

          // Set the actual allowance
          const approvePlan = preparePlan(approve);
          if (!approvePlan) return;

          let approveHash: `0x${string}`;
          try {
            approveHash = await submitPlan(approvePlan, writeContractAsync, sendTransactionAsync);
          } catch (err) {
            setState({ status: "error", error: err });
            return;
          }

          // Wait for the approve to be mined
          if (publicClient) {
            try {
              const receipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
              if (receipt.status === "reverted") {
                setState({ status: "error", error: new Error("Approval transaction reverted on-chain") });
                return;
              }
            } catch (err) {
              setState({ status: "error", error: new Error(`Approve tx failed: ${err instanceof Error ? err.message : String(err)}`) });
              return;
            }
          }
        }

        // ── 6. Main transaction ──────────────────────────────────────
        setState({ status: "confirming" });
        // Re-prepare plan in case chain state changed during approval
        const finalPlan = preparePlan(order);
        if (!finalPlan) return;

        let hash: `0x${string}`;
        try {
          hash = await submitPlan(finalPlan, writeContractAsync, sendTransactionAsync);
        } catch (err) {
          setState({ status: "error", error: err });
          return;
        }

        // ── 7. Wait for on-chain receipt ─────────────────────────────
        setState({ status: "waiting_receipt", data: hash });
        if (publicClient) {
          try {
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            if (receipt.status === "reverted") {
              setState({ status: "error", data: hash, error: new Error("Transaction reverted on-chain") });
              return;
            }
          } catch (err) {
            setState({ status: "error", data: hash, error: new Error(`Confirmation failed: ${err instanceof Error ? err.message : String(err)}`) });
            return;
          }
        }

        // ── 8. Confirmed + refresh portfolio ─────────────────────────
        setState({ status: "confirmed", data: hash });
        invalidatePortfolio();
      } finally {
        submittingRef.current = false;
      }
    },
    [
      preparePlan, ensureChain, readTokenBalance, readAllowance, simulatePlan,
      publicClient, writeContractAsync, sendTransactionAsync, invalidatePortfolio,
    ],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);

  return { ...state, execute, executeWithApproval, reset };
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
