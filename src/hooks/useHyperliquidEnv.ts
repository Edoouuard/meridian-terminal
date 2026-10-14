"use client";

import { useSyncExternalStore } from "react";

/**
 * Shared Hyperliquid testnet/mainnet selection — a tiny module-level store
 * (same pattern as useLivePortfolio's shared HL account) so every entry
 * point into Hyperliquid execution (HyperliquidPanel's close-position flow,
 * ThreadCard's PerpExecuteButton for opening a new position from a thesis)
 * agrees on the same environment, instead of each one defaulting/hardcoding
 * its own. Defaults to mainnet: a strategy deposits real USDC into the user's
 * Hyperliquid account, so its hedge has to open there too (a testnet short
 * hedges nothing). Testnet stays one click away in HyperliquidPanel, and
 * every mainnet order goes through a "real funds" confirmation.
 */
export type HlEnv = "testnet" | "mainnet";

let sharedHlEnv: HlEnv = "mainnet";
const listeners = new Set<() => void>();

export function setSharedHlEnv(env: HlEnv): void {
  sharedHlEnv = env;
  listeners.forEach((l) => l());
}

export function getSharedHlEnv(): HlEnv {
  return sharedHlEnv;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribe to the shared Hyperliquid env (returns the current value reactively). */
export function useSharedHlEnv(): HlEnv {
  return useSyncExternalStore(subscribe, getSharedHlEnv, getSharedHlEnv);
}
