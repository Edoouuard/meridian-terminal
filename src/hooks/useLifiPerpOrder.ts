"use client";

import { useCallback, useRef, useState } from "react";
import { useAccount } from "wagmi";
import type { ExecuteActionResponse } from "@lifi/perps-sdk";
import {
  OrderSide,
  OrderType,
  perpsClient,
  resolveLifiMarket,
  type LifiPerpsProviderId,
} from "@/lib/integrations/lifiPerps";
import { resolvePriceFromList, type PriceEntry } from "@/lib/quote";
import { worstCasePrice } from "@/lib/integrations/extended-live";
import { useLifiUserWallet } from "@/hooks/useLifiUserWallet";

export type LifiOrderStatus = "idle" | "submitting" | "confirmed" | "error";

export interface LifiOrderState {
  status: LifiOrderStatus;
  result?: ExecuteActionResponse;
  error?: string;
}

export interface UseLifiPerpOrderResult extends LifiOrderState {
  execute: (p: { symbol: string; isBuy: boolean; sizeUsd: number; prices?: PriceEntry[]; reduceOnly?: boolean }) => Promise<void>;
  reset: () => void;
}

/**
 * Places a live order on Ondo or Lighter through the shared LI.FI
 * `PerpsClient`. Sizes off Meridian's own live price feed (hard-fail without
 * one, same as every other execute path here) rather than a venue-specific
 * quote, resolves the market's opaque id/category, and formats size/price
 * through the provider plugin's own `formatOrderSize`/`formatOrderPrice` so
 * rounding follows each market's real tick/lot — never guessed decimals.
 */
export function useLifiPerpOrder(provider: LifiPerpsProviderId): UseLifiPerpOrderResult {
  useLifiUserWallet();
  const { address } = useAccount();
  const [state, setState] = useState<LifiOrderState>({ status: "idle" });
  const submittingRef = useRef(false);

  const execute = useCallback(
    async (p: { symbol: string; isBuy: boolean; sizeUsd: number; prices?: PriceEntry[]; reduceOnly?: boolean }) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      try {
        if (!address) {
          setState({ status: "error", error: "wallet not connected" });
          return;
        }
        setState({ status: "submitting" });
        const resolved = await resolveLifiMarket(provider, p.symbol);
        if (!resolved) {
          setState({ status: "error", error: `${p.symbol} has no active market on ${provider}.` });
          return;
        }
        const price = resolvePriceFromList(p.prices, p.symbol);
        if (price === null) {
          setState({ status: "error", error: `No live price for ${p.symbol} — cannot size this order safely.` });
          return;
        }
        const qty = p.sizeUsd / price;
        if (!(Number.isFinite(qty) && qty > 0)) {
          setState({ status: "error", error: `Computed a non-positive size for ${p.symbol} — refusing to submit.` });
          return;
        }
        const plugin = perpsClient.client.getProvider(provider);
        const size = plugin?.formatOrderSize ? plugin.formatOrderSize(resolved.market, qty) : String(qty);
        const limitPrice = worstCasePrice(price, p.isBuy);
        const wirePrice = plugin?.formatOrderPrice ? plugin.formatOrderPrice(resolved.market, limitPrice) : String(limitPrice);

        const result = await perpsClient.placeOrder({
          provider,
          address,
          market: resolved.ref,
          side: p.isBuy ? OrderSide.BUY : OrderSide.SELL,
          type: OrderType.MARKET,
          size,
          price: wirePrice,
          reduceOnly: p.reduceOnly,
        });
        setState({ status: "confirmed", result });
      } catch (err) {
        setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
      } finally {
        submittingRef.current = false;
      }
    },
    [provider, address],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);

  return { ...state, execute, reset };
}
