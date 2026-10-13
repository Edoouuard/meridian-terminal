import type { Address } from "viem";
import type { BestYieldEntry } from "@/app/api/best-yield/route";
import { findToken } from "@/lib/assetMap";
import type { FundingDeps, WalletAsset } from "@/lib/fundingPlanner";
import type { RouteQuote } from "@/lib/mcp/router";
import { resolvePriceFromList, usdToTokenAmount, type PriceEntry } from "@/lib/quote";

/**
 * Browser implementation of fundingPlanner's network reads: the bridge cost
 * comes from a live /api/route-quote (amount sent minus amount the best route
 * delivers), the per-chain APY from /api/best-yield (DefiLlama). Any failure
 * returns null, which fundPlan treats as "unknown" — it then keeps the plan's
 * own chain choice rather than guessing.
 */
export function browserFundingDeps(opts: {
  address: Address;
  assets: WalletAsset[];
  prices: PriceEntry[] | undefined;
  connectedChainId?: number;
}): FundingDeps {
  const yieldCache = new Map<string, Promise<BestYieldEntry[]>>();
  const yieldsFor = (symbol: string) => {
    if (!yieldCache.has(symbol)) {
      yieldCache.set(
        symbol,
        fetch(`/api/best-yield?symbol=${encodeURIComponent(symbol)}`)
          .then((r) => (r.ok ? (r.json() as Promise<BestYieldEntry[]>) : []))
          .catch(() => []),
      );
    }
    return yieldCache.get(symbol)!;
  };

  return {
    assets: opts.assets,
    connectedChainId: opts.connectedChainId,

    async bridgeCostUsd(fromChainId, toChainId, symbol, amountUsd) {
      const from = findToken(symbol, fromChainId);
      const to = findToken(symbol, toChainId);
      const price = from ? resolvePriceFromList(opts.prices, from.symbol) : null;
      const amount = from ? usdToTokenAmount(from.symbol, amountUsd, price, from.decimals) : null;
      if (!from || !to || !amount || price === null) return null;
      try {
        const res = await fetch("/api/route-quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fromChainId,
            toChainId,
            fromTokenAddress: from.address,
            toTokenAddress: to.address,
            fromAmount: amount.amountBase.toString(),
            fromAddress: opts.address,
          }),
        });
        if (!res.ok) return null;
        const { best } = (await res.json()) as { best: RouteQuote | null };
        if (!best?.toAmountEstimate) return null;
        const received = Number(best.toAmountEstimate) / 10 ** to.decimals;
        const sent = Number(amount.amountBase) / 10 ** from.decimals;
        return Math.max(0, (sent - received) * price);
      } catch {
        return null;
      }
    },

    async apyFor(protocol, symbol, chainLabel) {
      const entries = await yieldsFor(symbol);
      const match = entries.find(
        (e) => e.kind === "lending" && e.chain.toLowerCase() === chainLabel.toLowerCase() && e.protocol.toLowerCase() === protocol.toLowerCase(),
      );
      return match ? match.apy : null;
    },
  };
}
