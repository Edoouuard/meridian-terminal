"use client";

import { useCallback, useRef, useState } from "react";
import type { Address } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { AAVE_V3_POOL_BY_CHAIN, CHAIN_LABEL, ERC20_ABI } from "@/lib/onchain";
import { applySender, buildExecution, normalizeAmount, type Order } from "@/lib/execution";
import { approveOrderFor } from "@/lib/assetMap";
import {
  classifyExecutionError,
  createAaveSupplyPlan,
  isPlanExpired,
  logTransition,
  validateAaveSupplyPlan,
  type AaveSupplyPlan,
  type SupplyFlowState,
} from "@/lib/executionPlan";
import { recordExecution } from "@/lib/history";

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

export interface AaveSupplyRequest {
  chainId: number;
  token: Address;
  symbol: string;
  decimals: number;
  /** Human-unit decimal string ("1000") or already-base-unit bigint — same contract as execution.ts's Order.amount. */
  amount: bigint | string;
}

export interface AaveSupplyFlow {
  state: SupplyFlowState;
  plan: AaveSupplyPlan | null;
  message: string | null;
  approvalHash?: `0x${string}`;
  supplyHash?: `0x${string}`;
  /** Whether the prepared plan will need an approval signature first (null until known). */
  needsApproval: boolean | null;
  /** Build a plan, validate it (balance/chain/expiry), and simulate the call(s). Never signs anything. */
  prepare: (input: AaveSupplyRequest) => Promise<void>;
  /** Sign (approve if needed, then supply) the currently prepared plan. */
  confirm: () => Promise<void>;
  /** Back to DRAFT — clears plan/hashes/message. Never over-submits: a fresh prepare() is required after. */
  reset: () => void;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type WriteAsync = (args: any) => Promise<`0x${string}`>;
/**
 * A dynamically-typed ExecutionPlan's `abi` is viem's broad `Abi` type, not a
 * literal `as const` ABI — passing it straight into `simulateContract`'s
 * heavily overloaded generic signature makes TS try to enumerate every
 * possible function/args combination and fail with "union type too complex
 * to represent". Same fix as `WriteAsync` above: erase the generic once,
 * here, rather than at every call site.
 */
type SimulateAsync = (args: any) => Promise<unknown>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Meridian's first production-quality execution flow: USDC (connected
 * wallet, one chain) -> Aave v3 supply. A dedicated hook rather than an
 * extension of `useExecute`/`useStrategyExecutor` — every other protocol
 * those two already drive (Lido, Morpho, Uniswap, Spark, Compound, ...)
 * keeps its existing, already-working behavior untouched.
 *
 * State machine (see lib/executionPlan.ts for the full enum):
 *   DRAFT -> VALIDATING -> SIMULATING -> READY_FOR_SIGNATURE
 *     -> [APPROVAL_PENDING -> APPROVAL_CONFIRMED ->] SUPPLY_PENDING -> CONFIRMING -> CONFIRMED
 *
 * Safety properties:
 *   - balance is read live (on-chain) before a plan is ever marked ready;
 *   - the exact call is simulated via `publicClient.simulateContract` before
 *     every signature, including a second simulation of the supply call
 *     right after an approval mines (allowance is only live on-chain then);
 *   - allowance is read live so a sufficient existing approval is never
 *     re-signed — approve is skipped, not forced;
 *   - the approval amount is always exactly `plan.amount`, never unlimited;
 *   - `waitForTransactionReceipt` has an explicit timeout so a stalled RPC
 *     surfaces CONFIRMATION_TIMEOUT instead of hanging the UI forever;
 *   - nothing signs without an explicit `confirm()` call from a user click.
 */
export function useAaveSupply(onConfirmed?: () => void): AaveSupplyFlow {
  const { address, chainId: connectedChainId } = useAccount();
  const { writeContractAsync } = useWriteContract();

  const [plan, setPlan] = useState<AaveSupplyPlan | null>(null);
  const [state, setState] = useState<SupplyFlowState>("DRAFT");
  const [message, setMessage] = useState<string | null>(null);
  const [approvalHash, setApprovalHash] = useState<`0x${string}` | undefined>(undefined);
  const [supplyHash, setSupplyHash] = useState<`0x${string}` | undefined>(undefined);
  const [needsApproval, setNeedsApproval] = useState<boolean | null>(null);

  // No chainId passed: every read/write below only ever runs after we've
  // already gated on connectedChainId === plan.chainId, so the wallet's
  // default-connected-chain client is always the right one — and unlike a
  // literal number, it type-checks against wagmi's generated chain union.
  const publicClient = usePublicClient();
  const busyRef = useRef(false);

  const fail = useCallback(
    (p: AaveSupplyPlan | null, failState: SupplyFlowState, msg: string) => {
      logTransition(p, failState, { message: msg });
      setState(failState);
      setMessage(msg);
    },
    [],
  );

  const reset = useCallback(() => {
    setPlan(null);
    setState("DRAFT");
    setMessage(null);
    setApprovalHash(undefined);
    setSupplyHash(undefined);
    setNeedsApproval(null);
    busyRef.current = false;
  }, []);

  const prepare = useCallback(
    async (input: AaveSupplyRequest) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setApprovalHash(undefined);
      setSupplyHash(undefined);
      setMessage(null);
      try {
        if (!address) {
          fail(null, "WRONG_CHAIN", "Connect a wallet first.");
          return;
        }
        const pool = AAVE_V3_POOL_BY_CHAIN[input.chainId];
        if (!pool) {
          fail(null, "WRONG_CHAIN", `Aave v3 is not supported on ${CHAIN_LABEL[input.chainId] ?? `chain ${input.chainId}`}.`);
          return;
        }
        if (connectedChainId !== input.chainId) {
          fail(null, "WRONG_CHAIN", `Switch your wallet to ${CHAIN_LABEL[input.chainId] ?? `chain ${input.chainId}`} to supply there.`);
          return;
        }

        const normalized = normalizeAmount(input.amount, input.decimals);
        if ("error" in normalized) {
          fail(null, "INVALID_AMOUNT", normalized.error);
          return;
        }

        const newPlan = createAaveSupplyPlan({
          walletAddress: address,
          chainId: input.chainId,
          token: input.token,
          symbol: input.symbol,
          decimals: input.decimals,
          amount: normalized.value,
        });
        setPlan(newPlan);
        setState("VALIDATING");
        logTransition(newPlan, "VALIDATING");

        const client = publicClient;
        if (!client) {
          fail(newPlan, "RPC_ERROR", "No RPC connection available for this chain.");
          return;
        }

        const liveBalance = await client
          .readContract({ address: input.token, abi: ERC20_ABI, functionName: "balanceOf", args: [address] })
          .catch(() => undefined);

        const validation = validateAaveSupplyPlan(newPlan, {
          connectedAddress: address,
          connectedChainId,
          usdcBalance: liveBalance,
        });
        if (!validation.ok) {
          fail(newPlan, validation.state, validation.message);
          return;
        }

        setState("SIMULATING");
        logTransition(newPlan, "SIMULATING");

        const liveAllowance = await client
          .readContract({ address: input.token, abi: ERC20_ALLOWANCE_ABI, functionName: "allowance", args: [address, pool] })
          .catch(() => undefined);
        if (liveAllowance === undefined) {
          fail(newPlan, "RPC_ERROR", "Could not read your current USDC allowance — try again.");
          return;
        }
        const willNeedApproval = liveAllowance < newPlan.amount;
        setNeedsApproval(willNeedApproval);

        const supplyOrder: Order = {
          type: "supply",
          protocol: "aave",
          token: newPlan.token,
          symbol: newPlan.symbol,
          amount: newPlan.amount,
          chainId: newPlan.chainId,
          decimals: newPlan.decimals,
        };

        if (willNeedApproval) {
          // Only the approve call can be simulated truthfully right now — the
          // supply call would (correctly) revert against the current, still-
          // insufficient allowance. It gets simulated again, for real, right
          // after the approval is mined (see confirm()).
          const approveOrder = approveOrderFor(supplyOrder);
          if (!approveOrder) {
            fail(newPlan, "SIMULATION_FAILED", "Could not build the required approval for this order.");
            return;
          }
          const approveBuilt = buildExecution(approveOrder);
          if ("error" in approveBuilt) {
            fail(newPlan, "SIMULATION_FAILED", approveBuilt.error);
            return;
          }
          try {
            await (client.simulateContract as SimulateAsync)({
              account: address,
              address: approveBuilt.address!,
              abi: approveBuilt.abi!,
              functionName: approveBuilt.functionName!,
              args: approveBuilt.args!,
            });
          } catch (err) {
            fail(newPlan, "SIMULATION_FAILED", `Approval would fail: ${err instanceof Error ? err.message : String(err)}`);
            return;
          }
        } else {
          const supplyBuilt = buildExecution(supplyOrder);
          if ("error" in supplyBuilt) {
            fail(newPlan, "SIMULATION_FAILED", supplyBuilt.error);
            return;
          }
          const patched = applySender(supplyBuilt, address);
          if ("error" in patched) {
            fail(newPlan, "SIMULATION_FAILED", patched.error);
            return;
          }
          try {
            await (client.simulateContract as SimulateAsync)({
              account: address,
              address: patched.address!,
              abi: patched.abi!,
              functionName: patched.functionName!,
              args: patched.args!,
            });
          } catch (err) {
            fail(newPlan, "SIMULATION_FAILED", `Supply would fail: ${err instanceof Error ? err.message : String(err)}`);
            return;
          }
        }

        setState("READY_FOR_SIGNATURE");
        logTransition(newPlan, "READY_FOR_SIGNATURE", { needsApproval: willNeedApproval });
      } finally {
        busyRef.current = false;
      }
    },
    [address, connectedChainId, publicClient, fail],
  );

  const confirm = useCallback(async () => {
    if (busyRef.current) return;
    if (!plan || state !== "READY_FOR_SIGNATURE") return;
    busyRef.current = true;
    try {
      const client = publicClient;
      if (!client) {
        fail(plan, "RPC_ERROR", "No RPC connection available for this chain.");
        return;
      }
      if (connectedChainId !== plan.chainId) {
        fail(plan, "WRONG_CHAIN", `Wrong network — switch to ${CHAIN_LABEL[plan.chainId] ?? `chain ${plan.chainId}`} before signing.`);
        return;
      }
      if (isPlanExpired(plan)) {
        fail(plan, "PLAN_EXPIRED", "This plan has expired — refresh the amount and try again.");
        return;
      }
      if (!address) {
        fail(plan, "WRONG_CHAIN", "Wallet not connected.");
        return;
      }

      const pool = AAVE_V3_POOL_BY_CHAIN[plan.chainId];
      const supplyOrder: Order = {
        type: "supply",
        protocol: "aave",
        token: plan.token,
        symbol: plan.symbol,
        amount: plan.amount,
        chainId: plan.chainId,
        decimals: plan.decimals,
      };

      // Re-read allowance fresh — time may have passed since prepare().
      const liveAllowance = pool
        ? await client
            .readContract({ address: plan.token, abi: ERC20_ALLOWANCE_ABI, functionName: "allowance", args: [address, pool] })
            .catch(() => undefined)
        : undefined;
      if (liveAllowance === undefined) {
        fail(plan, "RPC_ERROR", "Could not re-check your USDC allowance — try again.");
        return;
      }
      const stillNeedsApproval = liveAllowance < plan.amount;
      setNeedsApproval(stillNeedsApproval);

      if (stillNeedsApproval) {
        const approveOrder = approveOrderFor(supplyOrder);
        if (!approveOrder) {
          fail(plan, "APPROVAL_FAILED", "Could not build the required approval for this order.");
          return;
        }
        const approveBuilt = buildExecution(approveOrder);
        if ("error" in approveBuilt) {
          fail(plan, "APPROVAL_FAILED", approveBuilt.error);
          return;
        }

        setState("APPROVAL_PENDING");
        logTransition(plan, "APPROVAL_PENDING");
        let hash: `0x${string}`;
        try {
          hash = await (writeContractAsync as WriteAsync)({
            chainId: approveBuilt.chainId,
            address: approveBuilt.address,
            abi: approveBuilt.abi,
            functionName: approveBuilt.functionName,
            args: approveBuilt.args,
          });
        } catch (err) {
          const c = classifyExecutionError(err, "approval");
          fail(plan, c.state, c.message);
          return;
        }
        setApprovalHash(hash);
        logTransition(plan, "APPROVAL_PENDING", { hash });

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
        logTransition(plan, "APPROVAL_CONFIRMED", { hash });

        // Allowance is only live on-chain now — simulate the real supply call
        // for real before asking for the second signature.
        const supplyBuiltForSim = buildExecution(supplyOrder);
        if ("error" in supplyBuiltForSim) {
          fail(plan, "SIMULATION_FAILED", supplyBuiltForSim.error);
          return;
        }
        const patchedForSim = applySender(supplyBuiltForSim, address);
        if ("error" in patchedForSim) {
          fail(plan, "SIMULATION_FAILED", patchedForSim.error);
          return;
        }
        try {
          await (client.simulateContract as SimulateAsync)({
            account: address,
            address: patchedForSim.address!,
            abi: patchedForSim.abi!,
            functionName: patchedForSim.functionName!,
            args: patchedForSim.args!,
          });
        } catch (err) {
          fail(plan, "SIMULATION_FAILED", `Supply would fail after approval: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      }

      const supplyBuilt = buildExecution(supplyOrder);
      if ("error" in supplyBuilt) {
        fail(plan, "RPC_ERROR", supplyBuilt.error);
        return;
      }
      const patchedSupply = applySender(supplyBuilt, address);
      if ("error" in patchedSupply) {
        fail(plan, "RPC_ERROR", patchedSupply.error);
        return;
      }

      setState("SUPPLY_PENDING");
      logTransition(plan, "SUPPLY_PENDING");
      let supplyTxHash: `0x${string}`;
      try {
        supplyTxHash = await (writeContractAsync as WriteAsync)({
          chainId: patchedSupply.chainId,
          address: patchedSupply.address,
          abi: patchedSupply.abi,
          functionName: patchedSupply.functionName,
          args: patchedSupply.args,
        });
      } catch (err) {
        const c = classifyExecutionError(err, "supply");
        fail(plan, c.state, c.message);
        recordExecution({
          type: "custom",
          label: `Supply ${plan.symbol} to Aave (failed)`,
          asset: plan.symbol,
          protocol: "aave",
          chainId: plan.chainId,
          status: "error",
        });
        return;
      }
      setSupplyHash(supplyTxHash);
      setState("CONFIRMING");
      logTransition(plan, "CONFIRMING", { hash: supplyTxHash });

      try {
        const receipt = await client.waitForTransactionReceipt({ hash: supplyTxHash, timeout: CONFIRMATION_TIMEOUT_MS });
        if (receipt.status === "reverted") {
          fail(plan, "TRANSACTION_REVERTED", "Supply transaction reverted on-chain.");
          recordExecution({
            type: "custom",
            label: `Supply ${plan.symbol} to Aave (reverted)`,
            asset: plan.symbol,
            protocol: "aave",
            chainId: plan.chainId,
            status: "error",
            hash: supplyTxHash,
          });
          return;
        }
      } catch (err) {
        const c = classifyExecutionError(err, "supply");
        fail(plan, c.state, c.message);
        return;
      }

      setState("CONFIRMED");
      logTransition(plan, "CONFIRMED", { hash: supplyTxHash });
      recordExecution({
        type: "deposit",
        label: `Supply ${plan.symbol} to Aave v3`,
        asset: plan.symbol,
        protocol: "aave",
        chainId: plan.chainId,
        status: "confirmed",
        hash: supplyTxHash,
      });
      onConfirmed?.();
    } finally {
      busyRef.current = false;
    }
  }, [plan, state, address, connectedChainId, publicClient, writeContractAsync, fail, onConfirmed]);

  return { state, plan, message, approvalHash, supplyHash, needsApproval, prepare, confirm, reset };
}
