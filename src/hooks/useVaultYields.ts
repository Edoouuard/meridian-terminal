"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchVaultApr, hyperliquidEnv, HLP_VAULT_ADDRESS } from "@/lib/integrations/hyperliquid-live";
import { fetchLighterLlpApr } from "@/lib/integrations/lighter-vault";

/**
 * Live APR for Hyperliquid's HLP vault — mainnet only, read-only (no
 * signing). HLP has no testnet equivalent worth showing, so this always
 * queries mainnet regardless of the shared perp testnet/mainnet toggle.
 */
export function useHlpApr() {
  return useQuery<number | null>({
    queryKey: ["hlp-apr"],
    queryFn: () => fetchVaultApr(HLP_VAULT_ADDRESS, hyperliquidEnv(false)),
    staleTime: 5 * 60_000,
  });
}

/** Live APR for Lighter's LLP vault — see lighter-vault.ts for the honesty caveats on this one (best-effort field parsing, LIT lock-up not yet modelled). */
export function useLlpApr() {
  return useQuery<number | null>({
    queryKey: ["llp-apr"],
    queryFn: fetchLighterLlpApr,
    staleTime: 5 * 60_000,
  });
}
