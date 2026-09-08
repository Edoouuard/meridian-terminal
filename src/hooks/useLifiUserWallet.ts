"use client";

import { useEffect } from "react";
import { getWalletClient } from "@wagmi/core";
import { useAccount, useWalletClient } from "wagmi";
import type { PerpsClient } from "@lifi/perps-sdk";
import { wagmiConfig } from "@/lib/wagmi";

/**
 * Keeps a LI.FI `PerpsClient` instance (Ondo + Lighter) pointed at the
 * currently connected wallet, and lets it switch networks mid-action (e.g.
 * Ondo's deposit leg on a specific chain). `PerpsClient.setUserWallet` takes a
 * plain viem `WalletClient` — exactly what wagmi's `useWalletClient` already
 * returns, no adapter needed.
 *
 * Takes the resolved client explicitly (see `getPerpsClient` in
 * lib/integrations/lifiPerps.ts) rather than importing a singleton, since
 * Ondo's sandbox/production toggle means more than one client instance can
 * exist — each needs the wallet wired the same way.
 */
export function useLifiUserWallet(client: PerpsClient): void {
  const { isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();

  useEffect(() => {
    client.setUserWallet(isConnected ? walletClient : undefined);
    client.setSwitchChain(
      isConnected
        ? async (chainId) => {
            try {
              return await getWalletClient(wagmiConfig, { chainId });
            } catch {
              return undefined;
            }
          }
        : undefined,
    );
  }, [client, isConnected, walletClient]);
}
