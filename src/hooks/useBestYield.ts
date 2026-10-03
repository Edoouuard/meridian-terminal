import { useQuery } from "@tanstack/react-query";
import type { BestYieldEntry } from "@/app/api/best-yield/route";

/** Live-ranked lending/LP yields for one asset symbol across every protocol /api/best-yield tracks (DefiLlama-backed). */
export function useBestYield(symbol: string, enabled = true) {
  return useQuery<BestYieldEntry[]>({
    queryKey: ["best-yield", symbol],
    queryFn: async () => {
      const res = await fetch(`/api/best-yield?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
      if (!res.ok) throw new Error("best-yield fetch failed");
      return res.json();
    },
    enabled: enabled && !!symbol,
    staleTime: 5 * 60_000,
  });
}
