"use client";

import { useCallback, useState } from "react";
import type { RouteQuote } from "@/lib/mcp/router";

export interface BridgeSwapQuoteInput {
  fromChainId: number;
  toChainId: number;
  fromTokenAddress: string;
  toTokenAddress: string;
  fromAmount: string;
  fromAddress: string;
  toAddress?: string;
  slippageBps?: number;
}

export interface UseBridgeSwapQuoteResult {
  best: RouteQuote | null;
  alternatives: RouteQuote[];
  isLoading: boolean;
  error: string | null;
  fetchQuote: (input: BridgeSwapQuoteInput) => Promise<RouteQuote | null>;
}

/**
 * Client-side hook for Meridian's routing layer: POSTs to /api/route-quote
 * (deBridge + LI.FI compared server-side, see lib/mcp/router.ts) and
 * returns the best unsigned route. Read-only — building a signable order
 * from the result happens separately (see BridgeExecuteButton).
 */
export function useBridgeSwapQuote(): UseBridgeSwapQuoteResult {
  const [best, setBest] = useState<RouteQuote | null>(null);
  const [alternatives, setAlternatives] = useState<RouteQuote[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchQuote = useCallback(async (input: BridgeSwapQuoteInput): Promise<RouteQuote | null> => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/route-quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError((err as { error?: string }).error ?? "Route quote failed");
        setBest(null);
        setAlternatives([]);
        return null;
      }
      const data = (await res.json()) as { best: RouteQuote | null; alternatives: RouteQuote[] };
      setBest(data.best);
      setAlternatives(data.alternatives ?? []);
      return data.best;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Route quote failed");
      setBest(null);
      setAlternatives([]);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { best, alternatives, isLoading, error, fetchQuote };
}
