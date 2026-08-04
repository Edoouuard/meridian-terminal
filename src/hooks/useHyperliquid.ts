"use client";

import { useCallback, useState } from "react";
import { useAccount, useSignTypedData } from "wagmi";
import { executeHyperliquidPerp, type ExecuteHyperliquidParams } from "@/lib/integrations/hyperliquid-live";
import type { TypedData } from "@/lib/integrations/types";

export type HlStatus = "idle" | "preparing" | "signing" | "submitting" | "confirmed" | "error";

export interface HlState {
  status: HlStatus;
  result?: Awaited<ReturnType<typeof executeHyperliquidPerp>>;
  error?: string;
}

export interface UseHyperliquidResult extends HlState {
  execute: (p: {
    symbol: string;
    isBuy: boolean;
    sizeUsd: number;
    leverage?: number;
    testnet?: boolean;
    /**
     * Exact coin quantity (from the quote layer) to use for the fill. When
     * provided and positive it is forwarded to the Hyperliquid layer verbatim,
     * so the caller's quoted amount is the one actually submitted.
     */
    coinQty?: number;
    reduceOnly?: boolean;
  }) => Promise<void>;
  reset: () => void;
}

/**
 * Real Hyperliquid perp execution hook. Fetches live asset index + price, signs
 * the EIP-712 order with the connected wallet, and submits to the exchange API
 * (testnet by default). NEVER auto-executes — only on an explicit caller call.
 */
export function useHyperliquid(): UseHyperliquidResult {
  const { address, isConnected } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const [state, setState] = useState<HlState>({ status: "idle" });

  const execute = useCallback(
    async (p: {
      symbol: string;
      isBuy: boolean;
      sizeUsd: number;
      leverage?: number;
      testnet?: boolean;
      coinQty?: number;
      reduceOnly?: boolean;
    }) => {
      if (!isConnected || !address) {
        setState({ status: "error", error: "wallet not connected" });
        return;
      }
      setState({ status: "preparing" });
      const sign = async (typed: TypedData) => {
        setState({ status: "signing" });
        // The typed payload already carries EIP712Domain inside `types`.
        return signTypedDataAsync({
          domain: typed.domain as Parameters<typeof signTypedDataAsync>[0]["domain"],
          types: typed.types as Parameters<typeof signTypedDataAsync>[0]["types"],
          primaryType: typed.primaryType,
          message: typed.message as Parameters<typeof signTypedDataAsync>[0]["message"],
        });
      };
      try {
        setState({ status: "submitting" });
        const params: ExecuteHyperliquidParams = {
          symbol: p.symbol,
          isBuy: p.isBuy,
          sizeUsd: p.sizeUsd,
          leverage: p.leverage,
          signer: address,
          sign,
          testnet: p.testnet,
          coinQty: p.coinQty,
          reduceOnly: p.reduceOnly,
        };
        const result = await executeHyperliquidPerp(params);
        setState({ status: result.ok ? "confirmed" : "error", result, error: result.error });
      } catch (err) {
        setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
      }
    },
    [address, isConnected, signTypedDataAsync],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);

  return { ...state, execute, reset };
}
