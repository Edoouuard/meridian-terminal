"use client";

import { useCallback, useRef, useState } from "react";
import { useAccount, useSignTypedData } from "wagmi";
import {
  cancelPerpOrder,
  hyperliquidEnv,
  modifyPerpLimit,
  perpLimitOrder,
  perpMarketOrder,
  spotMarketBuy,
  spotMarketSell,
  withAgent,
  type MarketOrderResult,
  type WalletSign,
} from "@/lib/integrations/hyperliquidTrade";

/** "approving": the wallet signs the one-time trading-key approval. */
export type HlStatus = "idle" | "preparing" | "approving" | "submitting" | "confirmed" | "error";

export interface HlResult {
  ok: boolean;
  /** Mid price the order was priced from. */
  marketPrice: number | null;
  /** Size sent, in coin units. */
  size?: number;
  /** What actually filled (IOC orders fill now or not at all). */
  filled?: { totalSz: number; avgPx: number };
  /** Stop-loss / take-profit placed after the fill. */
  protection?: MarketOrderResult["protection"];
  /** A limit order resting on the book (not filled yet). */
  resting?: { oid: number };
  error?: string;
}

export interface HlState {
  status: HlStatus;
  result?: HlResult;
  error?: string;
}

export interface UseHyperliquidResult extends HlState {
  /** Perp market order (open, or close with reduceOnly). */
  execute: (p: {
    symbol: string;
    isBuy: boolean;
    sizeUsd: number;
    leverage?: number;
    testnet?: boolean;
    /** Exact coin quantity; when positive it is used instead of sizeUsd / mid. */
    coinQty?: number;
    reduceOnly?: boolean;
    /** Reduce-only stop-loss / take-profit, in % of price from the fill. */
    stopLossPct?: number;
    takeProfitPct?: number;
  }) => Promise<void>;
  /** Perp limit order: rests on the book (GTC) or post-only (ALO). */
  placeLimit: (p: { symbol: string; isBuy: boolean; px: number; sizeUsd: number; leverage?: number; postOnly?: boolean; testnet?: boolean }) => Promise<void>;
  /** Cancel a resting order (limit, stop-loss, take-profit). */
  cancelOrder: (p: { coin: string; oid: number; testnet?: boolean }) => Promise<void>;
  /** Move a resting limit order to a new price. */
  modifyOrder: (p: { coin: string; oid: number; isBuy: boolean; size: number; px: number; reduceOnly?: boolean; testnet?: boolean }) => Promise<void>;
  /** Sell a spot token (UETH, UBTC, HYPE…) for USDC on Hyperliquid spot; at most what the account holds. */
  sellSpot: (p: { token: string; amount?: number; testnet?: boolean }) => Promise<void>;
  /** Buy a spot token (UETH, UBTC…) with USDC from the Hyperliquid spot balance. */
  buySpot: (p: { token: string; usd: number; testnet?: boolean }) => Promise<void>;
  reset: () => void;
}

/**
 * Hyperliquid trading with the official signing scheme (lib/integrations/
 * hyperliquidTrade.ts): the first trade asks the wallet to approve a trading
 * key once; orders are then signed by that key and sent straight to
 * Hyperliquid. Never runs on its own — only on an explicit call.
 */
export function useHyperliquid(): UseHyperliquidResult {
  const { address, isConnected, chainId } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const [state, setState] = useState<HlState>({ status: "idle" });
  /** One order in flight at a time: a double-click never sends a second order. */
  const submittingRef = useRef(false);

  const run = useCallback(
    async (
      testnet: boolean | undefined,
      order: (env: ReturnType<typeof hyperliquidEnv>, agentKey: `0x${string}`) => Promise<MarketOrderResult>,
      /** Market orders must fill now; a limit, a cancel or a modify succeeds without a fill. */
      expectFill = true,
    ) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      try {
        if (!isConnected || !address || !chainId) {
          setState({ status: "error", error: "Connect a wallet first." });
          return;
        }
        setState({ status: "preparing" });
        const env = hyperliquidEnv(testnet !== false);
        const walletSign: WalletSign = (typedData) => signTypedDataAsync(typedData as Parameters<typeof signTypedDataAsync>[0]);
        let last: MarketOrderResult = { ok: false };
        const out = await withAgent(
          { user: address, env, walletSign, walletChainId: chainId, onApproving: () => setState({ status: "approving" }) },
          async (agentKey) => {
            setState({ status: "submitting" });
            last = await order(env, agentKey);
            return last;
          },
        );
        const result: HlResult = {
          ok: out.ok,
          marketPrice: last.mid ?? null,
          size: last.size,
          filled: out.filled,
          protection: last.protection,
          resting: out.resting,
          error: out.error,
        };
        // An IOC order that didn't fill at all is not a success, whatever the transport said.
        if (expectFill && out.ok && out.filled === undefined) {
          setState({ status: "error", result, error: "The order didn't fill (no liquidity within 5% of the mid). Nothing was traded." });
          return;
        }
        setState({ status: out.ok ? "confirmed" : "error", result, error: out.error });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setState({ status: "error", error: /user rejected|denied/i.test(msg) ? "Signature declined in the wallet." : msg });
      } finally {
        submittingRef.current = false;
      }
    },
    [address, isConnected, chainId, signTypedDataAsync],
  );

  const execute = useCallback<UseHyperliquidResult["execute"]>(
    (p) =>
      run(p.testnet, (env, key) =>
        perpMarketOrder(env, key, {
          coin: p.symbol,
          isBuy: p.isBuy,
          sizeUsd: p.sizeUsd,
          coinQty: p.coinQty,
          leverage: p.leverage,
          reduceOnly: p.reduceOnly,
          stopLossPct: p.stopLossPct,
          takeProfitPct: p.takeProfitPct,
          user: address,
        }),
      ),
    [run, address],
  );

  const sellSpot = useCallback<UseHyperliquidResult["sellSpot"]>(
    (p) => run(p.testnet, (env, key) => spotMarketSell(env, key, { user: address!, base: p.token, amount: p.amount })),
    [run, address],
  );

  const buySpot = useCallback<UseHyperliquidResult["buySpot"]>(
    (p) => run(p.testnet, (env, key) => spotMarketBuy(env, key, { user: address!, base: p.token, usd: p.usd })),
    [run, address],
  );

  const placeLimit = useCallback<UseHyperliquidResult["placeLimit"]>(
    (p) =>
      run(
        p.testnet,
        (env, key) => perpLimitOrder(env, key, { coin: p.symbol, isBuy: p.isBuy, px: p.px, sizeUsd: p.sizeUsd, leverage: p.leverage, postOnly: p.postOnly, user: address }),
        false,
      ),
    [run, address],
  );

  const cancelOrder = useCallback<UseHyperliquidResult["cancelOrder"]>(
    (p) => run(p.testnet, (env, key) => cancelPerpOrder(env, key, { coin: p.coin, oid: p.oid }), false),
    [run],
  );

  const modifyOrder = useCallback<UseHyperliquidResult["modifyOrder"]>(
    (p) => run(p.testnet, (env, key) => modifyPerpLimit(env, key, p), false),
    [run],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);

  return { ...state, execute, placeLimit, cancelOrder, modifyOrder, sellSpot, buySpot, reset };
}

/** One line for a filled order: "0.0198 @ $2,431.20". */
export function describeFill(r: HlResult | undefined): string {
  if (!r?.filled) return "submitted";
  return `${r.filled.totalSz} @ $${r.filled.avgPx.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
}
