"use client";

import { useState, type ReactNode } from "react";
import { useAccount, useReadContract } from "wagmi";
import type { Address } from "viem";
import { ERC20_ABI, CHAIN_LABEL, SUPPORTED_CHAINS } from "@/lib/onchain";
import { findToken } from "@/lib/assetMap";
import { spentSymbol } from "@/lib/fundingPlanner";
import { formatBaseUnits, resolvePriceFromList, usdToTokenAmount, type PriceEntry } from "@/lib/quote";
import type { TradeLeg } from "@/lib/tradePlan";

/** How often the destination balance is re-read while a bridge is in flight. */
const POLL_MS = 10_000;

/**
 * Holds back a leg that a bridge earlier in the strategy is funding: polls the
 * wallet's balance of the leg's token on the leg's chain and only renders the
 * leg's execute button once enough has arrived. Nothing to switch or refresh
 * by hand between "bridge" and "deposit".
 */
export function FundsArrivalGate({
  leg,
  chainId,
  prices,
  from = "bridge",
  children,
  partial,
}: {
  leg: TradeLeg;
  chainId: number;
  prices?: PriceEntry[];
  /** What delivers the funds: a bridge, or a withdrawal from Hyperliquid to Arbitrum. */
  from?: "bridge" | "hyperliquid";
  children: ReactNode;
  /**
   * When less arrived than planned (a fee, a smaller withdrawal) but at least
   * `minUsd`: offer to run the step on what is there, rendered by `render`.
   */
  partial?: { minUsd: number; render: (leg: TradeLeg) => ReactNode };
}) {
  const { address } = useAccount();
  const symbol = spentSymbol(leg, chainId);
  const token = symbol ? findToken(symbol, chainId) : undefined;
  const price = token ? resolvePriceFromList(prices, token.symbol) : null;
  const needed = token ? usdToTokenAmount(token.symbol, leg.sizeUsd, price, token.decimals)?.amountBase : undefined;

  const { data: balance } = useReadContract({
    address: token?.address as Address | undefined,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: chainId as (typeof SUPPORTED_CHAINS)[number]["id"],
    query: { enabled: !!token && !!address, refetchInterval: (q) => (q.state.data !== undefined && needed !== undefined && q.state.data >= needed ? false : POLL_MS) },
  });

  // Once the funds have arrived the leg stays open: executing it spends them,
  // and the gate must not re-lock (and hide the confirmation) when they leave.
  const reached = balance !== undefined && needed !== undefined && balance >= needed;
  const [arrived, setArrived] = useState(false);
  if (reached && !arrived) setArrived(true);
  const [usePartial, setUsePartial] = useState<TradeLeg | null>(null);
  if (usePartial && partial) return <>{partial.render(usePartial)}</>;

  // Can't measure it (unknown token or no price) → don't block; the leg's own
  // pre-signature balance check still applies.
  if (!token || needed === undefined || !address) return <>{children}</>;
  if (reached || arrived) return <>{children}</>;

  const chainLabel = CHAIN_LABEL[chainId] ?? `chain ${chainId}`;
  // What arrived so far, in USD, kept a hair under the balance (the order converts at the live price).
  const haveUsd = balance !== undefined ? Math.floor((Number(balance) / 10 ** token.decimals) * (price ?? 1) * 0.995 * 100) / 100 : 0;
  const canUsePartial = !!partial && haveUsd >= partial.minUsd;
  return (
    <div style={{ margin: "6px 0 0" }}>
      <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
        Waiting for {from === "hyperliquid" ? "the Hyperliquid withdrawal" : "the bridge"} above to deliver {token.symbol} on {chainLabel}:{" "}
        {balance !== undefined ? formatBaseUnits(balance, token.decimals) : "…"} / {formatBaseUnits(needed, token.decimals)} {token.symbol}.
        This step unlocks on its own once the funds arrive ({from === "hyperliquid" ? "usually 3–5 min after the withdrawal" : "usually 1–3 min after the bridge confirms"}).
      </p>
      {canUsePartial && (
        <button type="button" className="btn btn-secondary" style={{ fontSize: 12, marginTop: 6 }} onClick={() => setUsePartial({ ...leg, sizeUsd: haveUsd })}>
          Use the ${haveUsd.toFixed(2)} already there instead →
        </button>
      )}
    </div>
  );
}
