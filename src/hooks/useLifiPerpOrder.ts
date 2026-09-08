"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useAccount } from "wagmi";
import type { ExecuteActionResponse } from "@lifi/perps-sdk";
import {
  OrderSide,
  OrderType,
  getPerpsClient,
  resolveLifiMarket,
  type LifiPerpsProviderId,
} from "@/lib/integrations/lifiPerps";
import { resolvePriceFromList, type PriceEntry } from "@/lib/quote";
import { worstCasePrice } from "@/lib/integrations/extended-live";
import { useLifiUserWallet } from "@/hooks/useLifiUserWallet";
import { useSharedOndoEnv } from "@/hooks/useOndoEnv";

export type LifiOrderStatus = "idle" | "submitting" | "confirmed" | "error";

export interface LifiOrderState {
  status: LifiOrderStatus;
  result?: ExecuteActionResponse;
  error?: string;
}

export interface LifiPerpOrderInput {
  symbol: string;
  isBuy: boolean;
  /** USD notional to size from a live price. Ignored when `qtyOverride` is set. */
  sizeUsd: number;
  prices?: PriceEntry[];
  reduceOnly?: boolean;
  /**
   * Exact base-asset quantity to use verbatim instead of deriving one from
   * `sizeUsd` / a live price — for closing a known position exactly (a
   * price-derived qty would drift from the real position size).
   */
  qtyOverride?: number;
}

export interface UseLifiPerpOrderResult extends LifiOrderState {
  execute: (p: LifiPerpOrderInput) => Promise<void>;
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
  const ondoEnv = useSharedOndoEnv();
  const client = useMemo(() => getPerpsClient(ondoEnv), [ondoEnv]);
  useLifiUserWallet(client);
  const { address } = useAccount();
  const [state, setState] = useState<LifiOrderState>({ status: "idle" });
  const submittingRef = useRef(false);

  const execute = useCallback(
    async (p: LifiPerpOrderInput) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      try {
        if (!address) {
          setState({ status: "error", error: "wallet not connected" });
          return;
        }
        setState({ status: "submitting" });
        const resolved = await resolveLifiMarket(client, provider, p.symbol);
        if (!resolved) {
          setState({ status: "error", error: `${p.symbol} has no active market on ${provider}.` });
          return;
        }
        const price = resolvePriceFromList(p.prices, p.symbol);
        if (price === null) {
          setState({ status: "error", error: `No live price for ${p.symbol} — cannot size this order safely.` });
          return;
        }
        const hasOverride = p.qtyOverride !== undefined;
        if (hasOverride && !(Number.isFinite(p.qtyOverride) && (p.qtyOverride as number) > 0)) {
          setState({ status: "error", error: `Quantity for ${p.symbol} must be positive.` });
          return;
        }
        const qty = hasOverride ? (p.qtyOverride as number) : p.sizeUsd / price;
        if (!(Number.isFinite(qty) && qty > 0)) {
          setState({ status: "error", error: `Computed a non-positive size for ${p.symbol} — refusing to submit.` });
          return;
        }
        const plugin = client.client.getProvider(provider);
        const size = plugin?.formatOrderSize ? plugin.formatOrderSize(resolved.market, qty) : String(qty);
        const limitPrice = worstCasePrice(price, p.isBuy);
        const wirePrice = plugin?.formatOrderPrice ? plugin.formatOrderPrice(resolved.market, limitPrice) : String(limitPrice);

        const result = await client.placeOrder({
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
    [client, provider, address],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);

  return { ...state, execute, reset };
}
