"use client";

import { useCallback, useRef, useState } from "react";
import type { Signer as ExtendedSigner } from "@blackcube/extended-sdk";
import { executeExtendedPerp, type ExecuteExtendedResult } from "@/lib/integrations/extended-live";
import type { PriceEntry } from "@/lib/quote";

export type ExtendedPerpStatus = "idle" | "submitting" | "confirmed" | "error";

export interface ExtendedPerpState {
  status: ExtendedPerpStatus;
  result?: ExecuteExtendedResult;
  error?: string;
}

export interface UseExtendedPerpResult extends ExtendedPerpState {
  execute: (p: { signer: ExtendedSigner; symbol: string; isBuy: boolean; sizeUsd: number; prices?: PriceEntry[]; reduceOnly?: boolean }) => Promise<void>;
  reset: () => void;
}

/**
 * Real Extended perp execution hook. Unlike Hyperliquid, signing happens with
 * the connected account's own Stark key (see extended-live.ts) rather than a
 * wallet EIP-712 signature, so there is no wagmi sign step here — this hook
 * exists purely to give the UI the same idle/submitting/confirmed/error
 * lifecycle and anti-double-submission guard as every other execute path.
 */
export function useExtendedPerp(): UseExtendedPerpResult {
  const [state, setState] = useState<ExtendedPerpState>({ status: "idle" });
  const submittingRef = useRef(false);

  const execute = useCallback(
    async (p: { signer: ExtendedSigner; symbol: string; isBuy: boolean; sizeUsd: number; prices?: PriceEntry[]; reduceOnly?: boolean }) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      try {
        setState({ status: "submitting" });
        const result = await executeExtendedPerp(p);
        setState({ status: result.ok ? "confirmed" : "error", result, error: result.error });
      } catch (err) {
        setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
      } finally {
        submittingRef.current = false;
      }
    },
    [],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);

  return { ...state, execute, reset };
}
