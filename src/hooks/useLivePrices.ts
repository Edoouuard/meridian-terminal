import { useQuery } from "@tanstack/react-query";
import type { LivePrice } from "@/app/api/prices/route";

export function useLivePrices() {
  return useQuery<LivePrice[]>({
    queryKey: ["live-prices"],
    queryFn: async () => {
      const res = await fetch("/api/prices");
      if (!res.ok) throw new Error("prices fetch failed");
      return res.json();
    },
    refetchInterval: 45_000,
    staleTime: 30_000,
  });
}
