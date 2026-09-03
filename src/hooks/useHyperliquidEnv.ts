"use client";

import { useSyncExternalStore } from "react";

/**
 * Shared Hyperliquid testnet/mainnet selection — a tiny module-level store
 * (same pattern as useLivePortfolio's shared HL account) so every entry
 * point into Hyperliquid execution (HyperliquidPanel's close-position flow,
 * ThreadCard's PerpExecuteButton for opening a new position from a thesis)
 * agrees on the same environment, instead of each one defaulting/hardcoding
 * its own. Defaults to testnet — switching to mainnet is always an explicit
 * user action via HyperliquidPanel's toggle.
 */
export type HlEnv = "testnet" | "mainnet";

let sharedHlEnv: HlEnv = "testnet";
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
