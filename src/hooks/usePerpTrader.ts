"use client";

import { useAccount, useSignTypedData } from "wagmi";
import type { Address } from "viem";
import type { PerpVenueName } from "@/lib/planner/markets";
import type { PriceEntry } from "@/lib/quote";
import { hyperliquidEnv, withAgent, type WalletSign } from "@/lib/integrations/hyperliquidTrade";
import { repairExtendedVault, useExtendedAccount } from "@/hooks/useExtendedAccount";
import { withTxflowAgent, type TxflowWalletSign } from "@/lib/integrations/txflowTrade";
import { useSharedHlEnv } from "@/hooks/useHyperliquidEnv";
import { perpCore, type PerpCore } from "@/lib/perpCore";

export type { PerpOrder } from "@/lib/perpCore";

export interface PerpTrader extends PerpCore {
  address: Address | undefined;
  /** Can this venue trade from here (wallet connected; Extended account linked)? */
  ready: (venue: PerpVenueName) => boolean;
  /** Approve the trading keys the venues need (once per browser): before anything trades, never between two legs. */
  prepare: (venues: PerpVenueName[]) => Promise<void>;
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

  const core = perpCore({
    user: (address ?? "0x0000000000000000000000000000000000000000") as Address,
    hlEnv: env,
    withHl: (fn) => withAgent({ ...need(), env, walletSign }, fn),
    withTxflow: (fn) => withTxflowAgent({ ...need(), walletSign: txWalletSign }, fn),
    extended: signer,
    prices,
    onExtendedVault: repairExtendedVault,
  });
  const guard =
    <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
    (...a: A) => {
      need();
      return f(...a);
    };

  return { address, ready, prepare, order: guard(core.order), position: guard(core.position), freeMargin: guard(core.freeMargin), maker: core.maker };
}
