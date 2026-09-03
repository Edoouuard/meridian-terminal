import { useEffect, useState } from "react";
import type { IndexedLendingPosition, IndexedVaultPosition } from "@/app/api/positions/route";

export interface IndexerPositions {
  morpho: IndexedLendingPosition[];
  /** MetaMorpho vault (ERC-4626) positions — what a Morpho "supply" order actually created, and what a "withdraw" order needs to find. */
  vaults: IndexedVaultPosition[];
  loading: boolean;
  error: string | null;
}

/**
 * Fetch indexed on-chain positions (currently Morpho Blue) for a connected
 * wallet, via the server-side /api/positions route. The route talks to the
 * official Morpho indexer (GraphQL) — no API key, positions returned in USD.
 */
export function useIndexedPositions(address?: string, enabled = false): IndexerPositions {
  const [morpho, setMorpho] = useState<IndexedLendingPosition[]>([]);
  const [vaults, setVaults] = useState<IndexedVaultPosition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !address) {
      const t = setTimeout(() => {
        setMorpho([]);
        setVaults([]);
        setError(null);
        setLoading(false);
      }, 0);
      return () => clearTimeout(t);
    }
    let cancelled = false;
    const id = setTimeout(() => {
      setLoading(true);
      setError(null);
      fetch(`/api/positions?address=${encodeURIComponent(address)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("positions request failed"))))
        .then((data) => {
          if (cancelled) return;
          setMorpho(Array.isArray(data?.positions) ? data.positions : []);
          setVaults(Array.isArray(data?.vaults) ? data.vaults : []);
        })
        .catch((e) => {
          if (!cancelled) setError((e as Error).message || "Indexer lookup failed");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [address, enabled]);

  return { morpho, vaults, loading, error };
}
