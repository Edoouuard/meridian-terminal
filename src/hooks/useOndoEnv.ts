"use client";

import { useSyncExternalStore } from "react";

/**
 * Shared Ondo sandbox/production selection — same tiny external-store pattern
 * as `useHyperliquidEnv.ts`, so every Ondo entry point (connect panel,
 * ThreadCard's execute button, a future positions panel) agrees on which
 * environment it's touching. Defaults to SANDBOX: switching to production is
 * always an explicit user action.
 *
 * Unlike Hyperliquid, Lighter has no equivalent testnet in the SDK this app
 * depends on (`@lifi/perps-sdk-provider-lighter` exposes only its mainnet and
 * Robinhood-Chain deployments) — there is deliberately no env toggle for it.
 */
export type OndoEnv = "sandbox" | "production";

let sharedOndoEnv: OndoEnv = "sandbox";
const listeners = new Set<() => void>();

export function setSharedOndoEnv(env: OndoEnv): void {
  sharedOndoEnv = env;
  listeners.forEach((l) => l());
}

export function getSharedOndoEnv(): OndoEnv {
  return sharedOndoEnv;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSharedOndoEnv(): OndoEnv {
  return useSyncExternalStore(subscribe, getSharedOndoEnv, getSharedOndoEnv);
}
