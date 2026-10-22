/**
 * perpCore.ts — market orders, positions, free margin and post-only orders
 * on Hyperliquid, TxFlow and Extended, from whatever holds the trading keys.
 * The browser (hooks/usePerpTrader) runs them through the wallet-approved
 * agents; the server bot (lib/neutralBot/serverBot.ts) through the keys the
 * user delegated to it. Same orders either way.
 */

import type { Address, Hex } from "viem";
import type { Signer as ExtendedSigner } from "@blackcube/extended-sdk";
import type { PairFill } from "@/lib/perpPair";
import type { PerpVenueName } from "@/lib/planner/markets";
import type { PriceEntry } from "@/lib/quote";
import type { ExchangeOutcome } from "@/lib/integrations/hyperliquidExchange";
import { cancelPerpOrder, cancelTriggerOrders, fetchBestBidAsk, fetchPerpAccount, perpLimitOrder, perpMarketOrder, protectPosition } from "@/lib/integrations/hyperliquidTrade";
import type { HyperliquidEnv } from "@/lib/integrations/hyperliquid-live";
import { executeExtendedPerp, fetchExtendedBalance, fetchExtendedPositionViews } from "@/lib/integrations/extended-live";
import { TXFLOW_NETWORK, fetchTxflowAccount, fetchTxflowMarkets, findTxflowMarket } from "@/lib/integrations/txflow-live";
import { txflowMarketOrder } from "@/lib/integrations/txflowTrade";
import { marketBase } from "@/lib/perpVenues";

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

export interface PerpMaker {
  book: (market: string) => Promise<{ bid: number; ask: number } | null>;
  post: (market: string, o: { isBuy: boolean; qty: number; px: number; reduceOnly: boolean; leverage: number }) => Promise<{ ok: boolean; oid?: number; error?: string }>;
  cancel: (market: string, oid: number) => Promise<void>;
  protect: (market: string, o: { isLong: boolean; qty: number; entry: number; stopLossPct: number }) => Promise<void>;
}

export interface PerpCore {
  order: (venue: PerpVenueName, o: PerpOrder) => Promise<PairFill>;
  /** Signed size of the base on that venue (> 0 long, < 0 short). */
  position: (venue: PerpVenueName, market: string) => Promise<number>;
  /** Margin free for a new order, USD. */
  freeMargin: (venue: PerpVenueName, market: string) => Promise<number>;
  /** Post-only orders on Hyperliquid (the neutral bot's maker mode). */
  maker: PerpMaker;
}

export interface PerpKeys {
  user: Address;
  hlEnv: HyperliquidEnv;
  /** Runs `fn` with the Hyperliquid agent key. */
  withHl: (fn: (key: Hex) => Promise<ExchangeOutcome>) => Promise<ExchangeOutcome>;
  /** Runs `fn` with the TxFlow agent key. */
  withTxflow: <T extends { ok: boolean; error?: string }>(fn: (key: Hex) => Promise<T>) => Promise<T>;
  extended: ExtendedSigner | null;
  prices?: PriceEntry[];
  /** Extended answered with the account's real vault id: keep it. */
  onExtendedVault?: (vaultId: string) => void;
}

export function perpCore(k: PerpKeys): PerpCore {
  const env = k.hlEnv;
  const user = k.user;

  const order = async (venue: PerpVenueName, o: PerpOrder): Promise<PairFill> => {
    const sizeUsd = o.reduceOnly ? 0 : (o.sizeUsd ?? 0);
    if (venue === "Hyperliquid") {
      const out = await k.withHl(async (key) => {
        const r = await perpMarketOrder(env, key, { coin: o.market, isBuy: o.isBuy, sizeUsd, coinQty: o.qty, leverage: o.leverage, reduceOnly: o.reduceOnly, stopLossPct: o.stopLossPct, user });
        // A closed position's stop must not act on the next one: clear it once the coin is flat.
        if (r.ok && o.reduceOnly && Math.abs((await fetchPerpAccount(env, user, o.market)).position) === 0) await cancelTriggerOrders(env, key, { user, coin: o.market }).catch(() => null);
        return r;
      });
      return out.ok && out.filled
        ? { ok: true, filledQty: out.filled.totalSz, avgPx: out.filled.avgPx, ref: `hyperliquid:${o.market}:${out.filled.totalSz}@${out.filled.avgPx}` }
        : { ok: false, error: out.error ?? "The order didn't fill (no liquidity within 5% of the mid)." };
    }
    if (venue === "TxFlow") {
      const out = await k.withTxflow((key) =>
        txflowMarketOrder(TXFLOW_NETWORK, key, { user, symbol: o.market, isBuy: o.isBuy, sizeUsd, coinQty: o.qty, leverage: o.leverage, reduceOnly: o.reduceOnly, stopLossPct: o.stopLossPct }),
      );
      return out.ok && out.filled
        ? { ok: true, filledQty: out.filled.totalSz, avgPx: out.filled.avgPx, ref: `txflow:${out.market?.name ?? o.market}:${out.filled.totalSz}@${out.filled.avgPx}` }
        : { ok: false, error: out.error ?? "TxFlow didn't report a fill." };
    }
    if (!k.extended) return { ok: false, error: "Link your Extended account first (Tools → Extended)." };
    const r = await executeExtendedPerp({ signer: k.extended, symbol: o.market, isBuy: o.isBuy, sizeUsd: o.sizeUsd ?? 0, prices: k.prices, leverage: o.leverage, reduceOnly: o.reduceOnly, qtyOverride: o.qty });
    if (r.repairedVaultId) k.onExtendedVault?.(r.repairedVaultId);
    const filled = Number(r.filledQty);
    return r.ok && filled > 0
      ? { ok: true, filledQty: filled, avgPx: Number(r.avgPrice) || undefined, ref: `extended:${r.market}:${r.filledQty}@${r.avgPrice ?? ""}` }
      : { ok: false, error: r.error ?? "Extended didn't report a fill." };
  };

  const position = async (venue: PerpVenueName, market: string): Promise<number> => {
    if (venue === "Hyperliquid") return (await fetchPerpAccount(env, user, market)).position;
    if (venue === "TxFlow") {
      const [acct, markets] = await Promise.all([fetchTxflowAccount(user), fetchTxflowMarkets()]);
      const m = findTxflowMarket(markets, market);
      return m ? (acct.positions.find((p) => p.index === m.index)?.size ?? 0) : 0;
    }
    if (!k.extended) throw new Error("Extended account not linked.");
    const base = marketBase(market);
    const p = (await fetchExtendedPositionViews(k.extended)).find((x) => x.market === market || marketBase(x.market) === base);
    return p ? (p.side === "short" ? -p.size : p.size) : 0;
  };

  const freeMargin = async (venue: PerpVenueName, market: string): Promise<number> => {
    if (venue === "Hyperliquid") return (await fetchPerpAccount(env, user, market)).freeMargin;
    if (venue === "TxFlow") return (await fetchTxflowAccount(user)).withdrawable;
    if (!k.extended) return 0;
    return (await fetchExtendedBalance(k.extended).catch(() => null))?.availableForTrade ?? 0;
  };

  const maker: PerpMaker = {
    book: (market) => fetchBestBidAsk(env, market),
    post: async (market, o) => {
      const out = await k.withHl((key) => perpLimitOrder(env, key, { coin: market, isBuy: o.isBuy, px: o.px, coinQty: o.qty, leverage: o.leverage, reduceOnly: o.reduceOnly, postOnly: true, user }));
      return out.ok && out.resting ? { ok: true, oid: out.resting.oid } : { ok: false, error: out.error ?? (out.filled ? "filled at once" : "not resting") };
    },
    cancel: async (market, oid) => {
      await k.withHl((key) => cancelPerpOrder(env, key, { coin: market, oid })).catch(() => undefined);
    },
    protect: async (market, o) => {
      await k.withHl((key) => protectPosition(env, key, { coin: market, isLong: o.isLong, size: o.qty, entry: o.entry, stopLossPct: o.stopLossPct }));
    },
  };

  return { order, position, freeMargin, maker };
}
