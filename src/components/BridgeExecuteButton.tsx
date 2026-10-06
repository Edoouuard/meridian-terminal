"use client";

import { useAccount } from "wagmi";
import type { TradeLeg } from "@/lib/tradePlan";
import type { Order } from "@/lib/execution";
import { CHAIN_LABEL } from "@/lib/onchain";
import { findToken } from "@/lib/assetMap";
import { resolvePriceFromList, usdToTokenAmount, type PriceEntry } from "@/lib/quote";
import { useBridgeSwapQuote } from "@/hooks/useBridgeSwapQuote";
import { ValidatedExecuteButton } from "@/components/ValidatedExecuteButton";

/** Reverse-match a free-text chain name (from the thesis, e.g. "to Arbitrum") against CHAIN_LABEL. */
function matchChainIdByName(text: string): number | undefined {
  const needle = text.toLowerCase();
  for (const [idStr, label] of Object.entries(CHAIN_LABEL)) {
    if (needle.includes(label.toLowerCase())) return Number(idStr);
  }
  return undefined;
}

/**
 * Live cross-chain bridge execution — Meridian's routing layer (deBridge +
 * LI.FI compared, see lib/mcp/router.ts) quoted via /api/route-quote, then
 * executed through the same validated flow as every other protocol
 * (ValidatedExecuteButton -> useExecuteOrder): live balance check,
 * allowlist-checked destination (routerAllowlist.ts — never signs against
 * an address Meridian hasn't verified), simulation, allowance-aware
 * approval, timeout-safe confirmation.
 *
 * Same-asset bridging only (e.g. "move my USDC to Arbitrum") — the thesis
 * parser (tradePlan.ts) doesn't yet carry a distinct destination asset for
 * a "bridge" leg, so this honestly limits itself to what it can resolve
 * safely rather than guessing one.
 */
export function BridgeExecuteButton({ leg, prices }: { leg: TradeLeg; prices?: PriceEntry[] }) {
  const { address, chain } = useAccount();
  const fromChainId = chain?.id;
  const toChainId = matchChainIdByName(leg.protocol || "");
  const { best, isLoading, error, fetchQuote } = useBridgeSwapQuote();

  if (!address || !fromChainId) {
    return <NotWiredLine reason="Connect a wallet to bridge." />;
  }
  if (!toChainId) {
    return <NotWiredLine reason={`Couldn't identify a destination chain from "${leg.protocol}".`} />;
  }
  if (toChainId === fromChainId) {
    return <NotWiredLine reason={`You're already on ${CHAIN_LABEL[toChainId] ?? `chain ${toChainId}`}.`} />;
  }

  const fromToken = findToken(leg.asset, fromChainId);
  const toToken = findToken(leg.asset, toChainId);
  if (!fromToken) {
    return <NotWiredLine reason={`"${leg.asset}" has no tracked address on ${CHAIN_LABEL[fromChainId] ?? `chain ${fromChainId}`}.`} />;
  }
  if (!toToken) {
    return <NotWiredLine reason={`"${leg.asset}" has no tracked address on ${CHAIN_LABEL[toChainId] ?? `chain ${toChainId}`}.`} />;
  }

  const price = resolvePriceFromList(prices, fromToken.symbol);
  const quote = usdToTokenAmount(fromToken.symbol, leg.sizeUsd, price, fromToken.decimals);
  if (!quote) {
    return <NotWiredLine reason={`No live price for ${fromToken.symbol} — cannot size this bridge safely.`} />;
  }

  if (best) {
    const order: Order = {
      type: "swap",
      protocol: best.provider,
      token: fromToken.address,
      symbol: fromToken.symbol,
      amount: quote.amountBase,
      chainId: fromChainId,
      decimals: fromToken.decimals,
      routerTx: {
        to: best.tx.to as `0x${string}`,
        data: best.tx.data as `0x${string}`,
        value: best.tx.value !== undefined ? BigInt(best.tx.value) : undefined,
      },
    };
    return (
      <>
        <p className="text-muted" style={{ fontSize: 11, margin: "0 0 4px" }}>
          Best route: {best.provider === "lifi" ? "LI.FI" : "deBridge"} → {CHAIN_LABEL[toChainId] ?? toChainId}
        </p>
        <ValidatedExecuteButton order={order} label={`Bridge to ${CHAIN_LABEL[toChainId] ?? toChainId} →`} />
      </>
    );
  }

  return (
    <>
      <button
        className="btn btn-primary"
        style={{ fontSize: 13, marginTop: 6, cursor: "pointer" }}
        disabled={isLoading}
        onClick={() =>
          fetchQuote({
            fromChainId,
            toChainId,
            fromTokenAddress: fromToken.address,
            toTokenAddress: toToken.address,
            fromAmount: quote.amountBase.toString(),
            fromAddress: address,
          })
        }
      >
        {isLoading ? "Fetching best route…" : `Get route to ${CHAIN_LABEL[toChainId] ?? toChainId} →`}
      </button>
      {error && <p style={{ margin: "4px 0 0", fontSize: 11, color: "var(--risk-bad, #c0392b)" }}>{error}</p>}
    </>
  );
}

function NotWiredLine({ reason }: { reason: string }) {
  return (
    <p className="text-muted" style={{ fontSize: 11, margin: "4px 0 0" }}>
      {reason}
    </p>
  );
}
