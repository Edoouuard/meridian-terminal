"use client";

import { useAccount, useSignTypedData } from "wagmi";
import type { Address } from "viem";
import type { PairFill } from "@/lib/perpPair";
import type { PerpVenueName } from "@/lib/planner/markets";
import type { PriceEntry } from "@/lib/quote";
import { cancelTriggerOrders, fetchPerpAccount, hyperliquidEnv, perpMarketOrder, withAgent, type WalletSign } from "@/lib/integrations/hyperliquidTrade";
import { executeExtendedPerp, fetchExtendedBalance, fetchExtendedPositionViews } from "@/lib/integrations/extended-live";
import { repairExtendedVault, useExtendedAccount } from "@/hooks/useExtendedAccount";
import { TXFLOW_NETWORK, fetchTxflowAccount, fetchTxflowMarkets, findTxflowMarket } from "@/lib/integrations/txflow-live";
import { txflowMarketOrder, withTxflowAgent, type TxflowWalletSign } from "@/lib/integrations/txflowTrade";
import { marketBase } from "@/lib/perpVenues";
import { useSharedHlEnv } from "@/hooks/useHyperliquidEnv";

export interface PerpOrder {
  /** The venue's own market name ("ETH" on Hyperliquid, "ETH-USD" on Extended, "ETH-USDC" on TxFlow). */
  market: string;
  isBuy: boolean;
  /** Notional to open, USD (ignored when `qty` is set). */
  sizeUsd?: number;
  /** Exact base quantity (the second leg of a pair, a close). */
  qty?: number;
  leverage: number;
  reduceOnly: boolean;
  /** Reduce-only stop on the venue, this far (%) from the fill: Hyperliquid and TxFlow (Extended: not yet). */
  stopLossPct?: number;
}

export interface PerpTrader {
  address: Address | undefined;
  /** Can this venue trade from here (wallet connected; Extended account linked)? */
  ready: (venue: PerpVenueName) => boolean;
  /** Approve the trading keys the venues need (once per browser): before anything trades, never between two legs. */
  prepare: (venues: PerpVenueName[]) => Promise<void>;
  order: (venue: PerpVenueName, o: PerpOrder) => Promise<PairFill>;
  /** Signed size of the base on that venue (> 0 long, < 0 short). */
  position: (venue: PerpVenueName, market: string) => Promise<number>;
  /** Margin free for a new order, USD. */
  freeMargin: (venue: PerpVenueName, market: string) => Promise<number>;
}

/**
 * One way to trade a perp market on Hyperliquid, Extended or TxFlow from the
 * browser: market orders through each venue's trading key (Hyperliquid and
 * TxFlow agents, the linked Extended account), positions and free margin.
 * Used by the one-click pair and the neutral bot.
 */
export function usePerpTrader(prices?: PriceEntry[]): PerpTrader {
  const { address, chainId } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const signer = useExtendedAccount();
  const envName = useSharedHlEnv();
  const env = hyperliquidEnv(envName === "testnet");
  const walletSign: WalletSign = (td) => signTypedDataAsync(td as Parameters<typeof signTypedDataAsync>[0]);
  const txWalletSign: TxflowWalletSign = (td) => signTypedDataAsync(td as Parameters<typeof signTypedDataAsync>[0]);

  const need = () => {
    if (!address || !chainId) throw new Error("Connect a wallet first.");
    return { user: address, walletChainId: chainId };
  };

  const ready = (venue: PerpVenueName) => !!address && !!chainId && (venue !== "Extended" || !!signer);

  const prepare = async (venues: PerpVenueName[]) => {
    const w = need();
    if (venues.includes("Hyperliquid")) await withAgent({ ...w, env, walletSign }, async () => ({ ok: true }));
    if (venues.includes("TxFlow")) await withTxflowAgent({ ...w, walletSign: txWalletSign }, async () => ({ ok: true }));
  };

  const order = async (venue: PerpVenueName, o: PerpOrder): Promise<PairFill> => {
    const w = need();
    const sizeUsd = o.reduceOnly ? 0 : (o.sizeUsd ?? 0);
    if (venue === "Hyperliquid") {
      const out = await withAgent({ ...w, env, walletSign }, async (key) => {
        const r = await perpMarketOrder(env, key, { coin: o.market, isBuy: o.isBuy, sizeUsd, coinQty: o.qty, leverage: o.leverage, reduceOnly: o.reduceOnly, stopLossPct: o.stopLossPct, user: w.user });
        // A closed position's stop must not act on the next one: clear it once the coin is flat.
        if (r.ok && o.reduceOnly && Math.abs((await fetchPerpAccount(env, w.user, o.market)).position) === 0) await cancelTriggerOrders(env, key, { user: w.user, coin: o.market }).catch(() => null);
        return r;
      });
      return out.ok && out.filled
        ? { ok: true, filledQty: out.filled.totalSz, avgPx: out.filled.avgPx, ref: `hyperliquid:${o.market}:${out.filled.totalSz}@${out.filled.avgPx}` }
        : { ok: false, error: out.error ?? "The order didn't fill (no liquidity within 5% of the mid)." };
    }
    if (venue === "TxFlow") {
      const out = await withTxflowAgent({ ...w, walletSign: txWalletSign }, (key) =>
        txflowMarketOrder(TXFLOW_NETWORK, key, { user: w.user, symbol: o.market, isBuy: o.isBuy, sizeUsd, coinQty: o.qty, leverage: o.leverage, reduceOnly: o.reduceOnly, stopLossPct: o.stopLossPct }),
      );
      return out.ok && out.filled
        ? { ok: true, filledQty: out.filled.totalSz, avgPx: out.filled.avgPx, ref: `txflow:${out.market?.name ?? o.market}:${out.filled.totalSz}@${out.filled.avgPx}` }
        : { ok: false, error: out.error ?? "TxFlow didn't report a fill." };
    }
    if (!signer) return { ok: false, error: "Link your Extended account first (Tools → Extended)." };
    const r = await executeExtendedPerp({ signer, symbol: o.market, isBuy: o.isBuy, sizeUsd: o.sizeUsd ?? 0, prices, leverage: o.leverage, reduceOnly: o.reduceOnly, qtyOverride: o.qty });
    if (r.repairedVaultId) repairExtendedVault(r.repairedVaultId);
    const filled = Number(r.filledQty);
    return r.ok && filled > 0
      ? { ok: true, filledQty: filled, avgPx: Number(r.avgPrice) || undefined, ref: `extended:${r.market}:${r.filledQty}@${r.avgPrice ?? ""}` }
      : { ok: false, error: r.error ?? "Extended didn't report a fill." };
  };

  const position = async (venue: PerpVenueName, market: string): Promise<number> => {
    const w = need();
    if (venue === "Hyperliquid") return (await fetchPerpAccount(env, w.user, market)).position;
    if (venue === "TxFlow") {
      const [acct, markets] = await Promise.all([fetchTxflowAccount(w.user), fetchTxflowMarkets()]);
      const m = findTxflowMarket(markets, market);
      return m ? (acct.positions.find((p) => p.index === m.index)?.size ?? 0) : 0;
    }
    if (!signer) throw new Error("Extended account not linked.");
    const base = marketBase(market);
    const p = (await fetchExtendedPositionViews(signer)).find((x) => x.market === market || marketBase(x.market) === base);
    return p ? (p.side === "short" ? -p.size : p.size) : 0;
  };

  const freeMargin = async (venue: PerpVenueName, market: string): Promise<number> => {
    const w = need();
    if (venue === "Hyperliquid") return (await fetchPerpAccount(env, w.user, market)).freeMargin;
    if (venue === "TxFlow") return (await fetchTxflowAccount(w.user)).withdrawable;
    if (!signer) return 0;
    return (await fetchExtendedBalance(signer).catch(() => null))?.availableForTrade ?? 0;
  };

  return { address, ready, prepare, order, position, freeMargin };
}
