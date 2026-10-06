"use client";

import { useQuery, useMutation } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import type { SmartWalletInfo, AerodromePool, MoonwellMarket, OnrampQuote } from "@/lib/mcp/providers/base";
import type { Address } from "viem";

/**
 * useBaseName — Resolve a Basename/ENS name to an address via Base MCP.
 */
export function useBaseName(name: string | undefined) {
  return useQuery({
    queryKey: ["base-resolve", name],
    queryFn: async () => {
      const res = await fetch(`/api/base?action=resolve&name=${encodeURIComponent(name!)}`);
      if (!res.ok) return null;
      const data = await res.json();
      return (data.address as Address) ?? null;
    },
    enabled: !!name && name.length > 0,
    staleTime: 300_000,
  });
}

/**
 * useBaseReverseName — Reverse resolve an address to a Basename.
 */
export function useBaseReverseName(address?: Address) {
  return useQuery({
    queryKey: ["base-reverse", address],
    queryFn: async () => {
      const res = await fetch(`/api/base?action=reverse&address=${address}`);
      if (!res.ok) return null;
      const data = await res.json();
      return (data.name as string) ?? null;
    },
    enabled: !!address,
    staleTime: 300_000,
  });
}

/**
 * useSmartWallet — Detect whether the connected wallet is a smart wallet
 * with paymaster support on Base.
 */
export function useSmartWallet() {
  const { address, isConnected } = useAccount();

  return useQuery({
    queryKey: ["base-smartwallet", address],
    queryFn: async () => {
      const res = await fetch(`/api/base?action=smartwallet&address=${address}`);
      if (!res.ok) return { isSmartWallet: false, paymasterAvailable: false } as SmartWalletInfo;
      return (await res.json()) as SmartWalletInfo;
    },
    enabled: isConnected && !!address,
    staleTime: 300_000,
  });
}

/**
 * useAerodromePools — Fetch top Aerodrome LP pools on Base.
 */
export function useAerodromePools(token?: string, limit = 20) {
  return useQuery({
    queryKey: ["base-aerodrome", token, limit],
    queryFn: async () => {
      const params = new URLSearchParams({ action: "aerodrome", limit: String(limit) });
      if (token) params.set("token", token);
      const res = await fetch(`/api/base?${params}`);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.pools ?? []) as AerodromePool[];
    },
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}

/**
 * useMoonwellMarkets — Fetch Moonwell lending markets on Base.
 */
export function useMoonwellMarkets() {
  return useQuery({
    queryKey: ["base-moonwell"],
    queryFn: async () => {
      const res = await fetch("/api/base?action=moonwell");
      if (!res.ok) return [];
      const data = await res.json();
      return (data.markets ?? []) as MoonwellMarket[];
    },
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}

/**
 * useOnrampQuote — Get a fiat onramp quote for buying crypto on Base.
 */
export function useOnrampQuote(amount: number, currency: string, token: string) {
  return useQuery({
    queryKey: ["base-onramp", amount, currency, token],
    queryFn: async () => {
      const params = new URLSearchParams({
        action: "onramp",
        amount: String(amount),
        currency,
        token,
      });
      const res = await fetch(`/api/base?${params}`);
      if (!res.ok) return null;
      const data = await res.json();
      return (data.quote as OnrampQuote) ?? null;
    },
    enabled: amount > 0,
    staleTime: 30_000,
  });
}

/**
 * useSponsorTransaction — Wrap a tx with Base paymaster sponsorship.
 */
export function useSponsorTransaction() {
  const { address } = useAccount();

  return useMutation({
    mutationFn: async (tx: { to: string; data: string; value?: string }) => {
      const res = await fetch("/api/base", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sponsor", tx, userAddress: address }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Sponsorship failed");
      }
      const data = await res.json();
      return data.tx;
    },
  });
}
