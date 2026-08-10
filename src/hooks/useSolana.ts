"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchSolBalance,
  fetchSplBalances,
  parsePubkey,
  type SolSplBalance,
} from "@/lib/solana";

export interface SolanaBalance {
  /** Native SOL balance. */
  sol: number;
  /** Curated SPL token balances. */
  spl: SolSplBalance[];
}

export interface UseSolanaResult {
  loading: boolean;
  /** Combined SOL + SPL balances. Empty until the first successful / any fetch. */
  balances: SolanaBalance;
  /** Non-fatal error message (e.g. RPC hiccup), or null. */
  error: string | null;
  /** Force a refresh now (ignores whether the key is valid). */
  refresh: () => Promise<void>;
}

/** Auto-refresh interval for the Solana balances (ms). */
export const SOLANA_REFRESH_MS = 60_000;

/**
 * Real Solana read hook. Given a Solana public key (user-entered, base58),
 * fetches the native SOL balance plus curated SPL token balances from the
 * public mainnet RPC, refreshing on a 60s interval. Errors never throw —
 * they surface as non-fatal `error` and empty balances.
 */
export function useSolana(pubkey: string | null): UseSolanaResult {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balances, setBalances] = useState<SolanaBalance>({ sol: 0, spl: [] });

  const load = useCallback(async (key: string) => {
    const parsed = parsePubkey(key);
    if (!parsed) {
      setBalances({ sol: 0, spl: [] });
      setError("Invalid Solana address");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [sol, spl] = await Promise.all([fetchSolBalance(parsed), fetchSplBalances(parsed)]);
      const errs = [sol.error, spl.error].filter(Boolean) as string[];
      setBalances({ sol: sol.sol, spl: spl.balances });
      setError(errs.length > 0 ? errs[0] : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (pubkey) await load(pubkey);
  }, [pubkey, load]);

  useEffect(() => {
    if (!pubkey) return;
    // Run immediately, then every SOLANA_REFRESH_MS while a valid key is present.
    const run = () => {
      if (parsePubkey(pubkey)) load(pubkey);
    };
    run();
    const id = setInterval(run, SOLANA_REFRESH_MS);
    return () => clearInterval(id);
  }, [pubkey, load]);

  return { loading, balances, error, refresh };
}