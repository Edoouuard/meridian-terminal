"use client";

import { useState, useCallback } from "react";

export interface HealthPreview {
  healthFactorBefore: number | null;
  healthFactorAfter: number | null;
  willLiquidate: boolean;
}

export interface UseHealthPreviewResult {
  preview: HealthPreview | null;
  isLoading: boolean;
  error: string | null;
  simulate: (params: {
    address: string;
    chainId: number;
    action: "supply" | "borrow" | "withdraw" | "repay";
    asset: string;
    amount: string;
  }) => Promise<HealthPreview | null>;
}

/**
 * Hook to preview health factor changes before executing an Aave action.
 * Uses the Aave MCP server's preview_action tool for accurate simulation.
 */
export function useHealthPreview(): UseHealthPreviewResult {
  const [preview, setPreview] = useState<HealthPreview | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const simulate = useCallback(
    async (params: {
      address: string;
      chainId: number;
      action: "supply" | "borrow" | "withdraw" | "repay";
      asset: string;
      amount: string;
    }): Promise<HealthPreview | null> => {
      setIsLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/preview-action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setError((err as { error?: string }).error ?? "Preview failed");
          return null;
        }
        const data: HealthPreview = await res.json();
        setPreview(data);
        return data;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Preview failed");
        return null;
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  return { preview, isLoading, error, simulate };
}
