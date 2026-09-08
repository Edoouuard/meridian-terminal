"use client";

import { useEffect } from "react";
import { getWalletClient } from "@wagmi/core";
import { useAccount, useWalletClient } from "wagmi";
import { perpsClient } from "@/lib/integrations/lifiPerps";
import { wagmiConfig } from "@/lib/wagmi";

/**
 * Keeps the shared LI.FI `PerpsClient` (Ondo + Lighter) pointed at the
 * currently connected wallet, and lets it switch networks mid-action (e.g.
 * Ondo's deposit leg on a specific chain). `PerpsClient.setUserWallet` takes a
 * plain viem `WalletClient` — exactly what wagmi's `useWalletClient` already
 * returns, no adapter needed. Mount this once near the app root so every
 * Ondo/Lighter hook shares one up-to-date wallet.
 */
export function useLifiUserWallet(): void {
  const { isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();

  useEffect(() => {
    perpsClient.setUserWallet(isConnected ? walletClient : undefined);
    perpsClient.setSwitchChain(
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
  }, [isConnected, walletClient]);
}
