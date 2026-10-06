"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import type { ChainBalance, YieldPosition, YieldOpportunity } from "@/lib/mcp/types";
import type { TradeRecord } from "@/lib/mcp/providers/haiku";

/**
 * useHaikuPortfolio — Enriches the portfolio with multi-chain data from Haiku MCP.
 *
 * Haiku aggregates token balances, DeFi positions, and yield opportunities
 * across all supported chains in a single call. This complements the existing
 * useLivePortfolio hook (which reads on-chain via wagmi multicall) by adding
 * protocols and chains that wagmi doesn't track directly.
 *
 * Data is fetched via /api/haiku which proxies to mcp.haiku.trade/sse.
 */

export interface HaikuPortfolioData {
  balances: ChainBalance[];
  positions: YieldPosition[];
  totalBalancesUsd: number;
  totalPositionsUsd: number;
  isLoading: boolean;
  error: string | null;
}

export function useHaikuPortfolio(): HaikuPortfolioData {
  const { address, isConnected } = useAccount();

  const balancesQuery = useQuery({
    queryKey: ["haiku-balances", address],
    queryFn: async () => {
      const res = await fetch(`/api/haiku?action=balances&address=${address}`);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.balances ?? []) as ChainBalance[];
    },
    enabled: isConnected && !!address,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const positionsQuery = useQuery({
    queryKey: ["haiku-positions", address],
    queryFn: async () => {
      const res = await fetch(`/api/haiku?action=positions&address=${address}`);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.positions ?? []) as YieldPosition[];
    },
    enabled: isConnected && !!address,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const balances = balancesQuery.data ?? [];
  const positions = positionsQuery.data ?? [];

  return {
    balances,
    positions,
    totalBalancesUsd: balances.reduce((sum, b) => sum + b.totalUsd, 0),
    totalPositionsUsd: positions.reduce((sum, p) => sum + p.depositedUsd, 0),
    isLoading: balancesQuery.isLoading || positionsQuery.isLoading,
    error: balancesQuery.error?.message ?? positionsQuery.error?.message ?? null,
  };
}

/**
 * useHaikuYields — Fetch yield opportunities from Haiku MCP.
 */
export function useHaikuYields(asset?: string, minApy?: number) {
  return useQuery({
    queryKey: ["haiku-yields", asset, minApy],
    queryFn: async () => {
      const params = new URLSearchParams({ action: "yields" });
      if (asset) params.set("asset", asset);
      if (minApy) params.set("minApy", String(minApy));
      const res = await fetch(`/api/haiku?${params}`);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.opportunities ?? []) as YieldOpportunity[];
    },
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}

/**
 * useHaikuHistory — Fetch trade history from Haiku MCP.
 */
export function useHaikuHistory(limit = 50) {
  const { address, isConnected } = useAccount();

  return useQuery({
    queryKey: ["haiku-history", address, limit],
    queryFn: async () => {
      const res = await fetch(`/api/haiku?action=history&address=${address}&limit=${limit}`);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.history ?? []) as TradeRecord[];
    },
    enabled: isConnected && !!address,
    staleTime: 30_000,
  });
}
