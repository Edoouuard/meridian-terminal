import { useEffect, useState } from "react";
import type { IndexedLendingPosition } from "@/app/api/positions/route";

export interface IndexerPositions {
  morpho: IndexedLendingPosition[];
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !address) {
      setMorpho([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/positions?address=${encodeURIComponent(address)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("positions request failed"))))
      .then((data) => {
        if (cancelled) return;
        setMorpho(Array.isArray(data?.positions) ? data.positions : []);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message || "Indexer lookup failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address, enabled]);

  return { morpho, loading, error };
}
