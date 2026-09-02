import { useQuery } from "@tanstack/react-query";
import type { VaultRisk } from "@/lib/integrations/philidor";

/**
 * Live vault risk scores from Philidor (see /api/vault-risk). Optionally
 * scoped to a comma-separated list of Meridian protocol display names
 * ("Aave,Morpho") and/or an asset symbol. Protocols Philidor doesn't cover
 * (Hyperliquid, Extended, Variational, Lido, Pendle) simply return no rows.
 */
export function useVaultRisk(
  params: { protocol?: string; asset?: string; chain?: string; limit?: number; enabled?: boolean } = {},
) {
  const { protocol, asset, chain, limit, enabled = true } = params;
  return useQuery<VaultRisk[]>({
    queryKey: ["vault-risk", protocol ?? null, asset ?? null, chain ?? null, limit ?? null],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (protocol) qs.set("protocol", protocol);
      if (asset) qs.set("asset", asset);
      if (chain) qs.set("chain", chain);
      if (limit) qs.set("limit", String(limit));
      const res = await fetch(`/api/vault-risk?${qs.toString()}`);
      if (!res.ok) throw new Error("vault-risk fetch failed");
      return res.json();
    },
    enabled,
    staleTime: 5 * 60_000,
  });
}
