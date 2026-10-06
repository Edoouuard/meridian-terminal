"use client";

import { useCallback, useState } from "react";
import { useAccount, usePublicClient, useSendTransaction, useSwitchChain } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import type { Address } from "viem";
import { CHAIN_LABEL } from "@/lib/onchain";

// ─── Chain name → chain id mapping ──────────────────────────────────

const CHAIN_NAME_TO_ID: Record<string, number> = {
  ethereum: 1, mainnet: 1,
  optimism: 10,
  "bnb chain": 56, bsc: 56,
  gnosis: 100,
  polygon: 137,
  sonic: 146,
  fantom: 250,
  "zksync era": 324, zksync: 324,
  metis: 1088,
  mantle: 5000,
  base: 8453,
  arbitrum: 42161,
  celo: 42220,
  avalanche: 43114,
  linea: 59144,
  scroll: 534352,
};

export function chainIdFromName(name: string): number | undefined {
  return CHAIN_NAME_TO_ID[name.toLowerCase().trim()];
}

// ─── Native token address (deBridge convention) ─────────────────────

/** deBridge uses the zero address for native gas tokens. */
const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000" as Address;

// ─── Common stablecoin addresses per chain (for bridge destinations) ─

const USDC_BY_CHAIN: Record<number, Address> = {
  1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  10: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  56: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  137: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  43114: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  534352: "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4",
};

// ─── Types ──────────────────────────────────────────────────────────

export type BridgeStatus =
  | "idle"
  | "quoting"
  | "quoted"
  | "switching_chain"
  | "approving"
  | "signing"
  | "waiting_receipt"
  | "bridging"
  | "confirmed"
  | "error";

export interface BridgeQuote {
  provider: string;
  fromToken: { symbol: string; chainId: number };
  toToken: { symbol: string; chainId: number };
  fromAmount: string;
  toAmount: string;
  estimatedFeesUsd: number;
  estimatedTimeSeconds: number;
  steps: { type: string; provider: string; fromToken: string; toToken: string }[];
  reason: string;
}

export interface BridgeState {
  status: BridgeStatus;
  quote: BridgeQuote | null;
  srcTxHash: `0x${string}` | null;
  orderId: string | null;
  error: string | null;
}

export interface UseBridgeResult extends BridgeState {
  /** Fetch a bridge quote from the routing layer. */
  fetchQuote: (params: {
    fromChainId: number;
    toChainId: number;
    fromToken: Address;
    toToken: Address;
    fromAmount: string;
  }) => Promise<void>;
  /** Execute the quoted bridge (sign + send the unsigned tx). */
  executeBridge: () => Promise<void>;
  /** Poll the cross-chain order status. */
  checkStatus: () => Promise<{ status: string; dstTxHash?: string } | null>;
  /** Reset to idle. */
  reset: () => void;
}

/**
 * Hook for cross-chain bridge execution via deBridge/LI.FI MCP routing.
 *
 * Flow: fetchQuote → user reviews → executeBridge → track status
 *
 * The hook fetches quotes from /api/bridge (server-side MCP calls),
 * then signs the pre-built unsigned tx client-side via wagmi.
 */
export function useBridge(): UseBridgeResult {
  const { address, chain } = useAccount();
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();

  const [state, setState] = useState<BridgeState>({
    status: "idle",
    quote: null,
    srcTxHash: null,
    orderId: null,
    error: null,
  });

  // Store the full execution plan from the API (not exposed to the component)
  const [executionData, setExecutionData] = useState<{
    request: Record<string, unknown>;
    transactions: { to: string; data: string; value: string; chainId: number }[];
    approvals: { to: string; data: string; value: string; chainId: number }[];
  } | null>(null);

  const fetchQuote = useCallback(
    async (params: {
      fromChainId: number;
      toChainId: number;
      fromToken: Address;
      toToken: Address;
      fromAmount: string;
    }) => {
      if (!address) {
        setState((s) => ({ ...s, status: "error", error: "Wallet not connected" }));
        return;
      }

      setState({ status: "quoting", quote: null, srcTxHash: null, orderId: null, error: null });

      try {
        const res = await fetch("/api/bridge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...params, userAddress: address }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Bridge quote failed" }));
          setState((s) => ({ ...s, status: "error", error: err.error ?? "No route available" }));
          return;
        }

        const data = await res.json();
        const best = data.comparison?.best;
        if (!best) {
          setState((s) => ({ ...s, status: "error", error: "No route returned" }));
          return;
        }

        const quote: BridgeQuote = {
          provider: best.provider,
          fromToken: best.fromToken,
          toToken: best.toToken,
          fromAmount: best.fromAmount,
          toAmount: best.toAmount,
          estimatedFeesUsd: best.estimatedFeesUsd,
          estimatedTimeSeconds: best.estimatedTimeSeconds,
          steps: best.steps ?? [],
          reason: data.comparison.reason,
        };

        setExecutionData({
          request: params,
          transactions: data.execution?.transactions ?? [],
          approvals: data.execution?.approvals ?? [],
        });

        // Extract orderId from routeData if present
        const orderId = best.routeData?.orderId ?? null;

        setState({ status: "quoted", quote, srcTxHash: null, orderId, error: null });
      } catch (err) {
        setState((s) => ({
          ...s,
          status: "error",
          error: err instanceof Error ? err.message : "Quote failed",
        }));
      }
    },
    [address],
  );

  const executeBridge = useCallback(async () => {
    if (!executionData || !address) {
      setState((s) => ({ ...s, status: "error", error: "No quote or wallet" }));
      return;
    }

    const { transactions, approvals } = executionData;
    if (transactions.length === 0) {
      setState((s) => ({ ...s, status: "error", error: "No transactions to execute" }));
      return;
    }

    const targetChainId = transactions[0].chainId;

    try {
      // Switch chain if needed
      if (chain?.id !== targetChainId) {
        setState((s) => ({ ...s, status: "switching_chain" }));
        await switchChainAsync({ chainId: targetChainId as Parameters<typeof switchChainAsync>[0]["chainId"] });
      }

      // Execute approval txs first
      if (approvals.length > 0) {
        setState((s) => ({ ...s, status: "approving" }));
        for (const approval of approvals) {
          const approveHash = await sendTransactionAsync({
            to: approval.to as Address,
            data: approval.data as `0x${string}`,
            value: BigInt(approval.value || "0"),
          });
          if (publicClient) {
            const receipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
            if (receipt.status === "reverted") {
              setState((s) => ({ ...s, status: "error", error: "Approval transaction reverted" }));
              return;
            }
          }
        }
      }

      // Execute the main bridge transaction
      setState((s) => ({ ...s, status: "signing" }));
      const mainTx = transactions[0];
      const hash = await sendTransactionAsync({
        to: mainTx.to as Address,
        data: mainTx.data as `0x${string}`,
        value: BigInt(mainTx.value || "0"),
      });

      setState((s) => ({ ...s, status: "waiting_receipt", srcTxHash: hash }));

      if (publicClient) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status === "reverted") {
          setState((s) => ({ ...s, status: "error", srcTxHash: hash, error: "Bridge transaction reverted on-chain" }));
          return;
        }
      }

      setState((s) => ({ ...s, status: "bridging", srcTxHash: hash }));

      // Invalidate portfolio data
      queryClient.invalidateQueries({ queryKey: ["readContracts"] });
      queryClient.invalidateQueries({ queryKey: ["balance"] });
      queryClient.invalidateQueries({ queryKey: ["readContract"] });

      // After a brief delay, mark as confirmed (cross-chain delivery tracked separately)
      setState((s) => ({ ...s, status: "confirmed" }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Bridge execution failed";
      // User rejected
      if (msg.includes("rejected") || msg.includes("denied")) {
        setState((s) => ({ ...s, status: "quoted", error: null }));
        return;
      }
      setState((s) => ({ ...s, status: "error", error: msg }));
    }
  }, [executionData, address, chain, switchChainAsync, sendTransactionAsync, publicClient, queryClient]);

  const checkStatus = useCallback(async () => {
    if (!state.orderId) return null;
    try {
      const res = await fetch(`/api/bridge?action=status&orderId=${state.orderId}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }, [state.orderId]);

  const reset = useCallback(() => {
    setState({ status: "idle", quote: null, srcTxHash: null, orderId: null, error: null });
    setExecutionData(null);
  }, []);

  return { ...state, fetchQuote, executeBridge, checkStatus, reset };
}
