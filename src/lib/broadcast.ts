/**
 * broadcast.ts — Broadcast + monitoring + alerting layer.
 *
 * Manages the full lifecycle of submitted transactions:
 * 1. Broadcast: submit signed tx to the network
 * 2. Monitor: track confirmation status (pending → confirmed/failed)
 * 3. Cross-chain tracking: poll bridge providers for destination tx
 * 4. Alerting: notify on status changes via callbacks
 *
 * Designed to work with both EOA wallets and smart wallets (Safe, MPC).
 */

import type { Address } from "viem";
import type { McpProviderId, TxStatus, TxTracker } from "./mcp/types";
import * as debridgeProvider from "./mcp/providers/debridge";
import * as lifiProvider from "./mcp/providers/lifi";

// ─── Transaction store ───────────────────────────────────────────────

const txStore = new Map<string, TxTracker>();

export type TxEventType = "submitted" | "confirming" | "confirmed" | "failed" | "bridged" | "expired";

export interface TxEvent {
  type: TxEventType;
  tracker: TxTracker;
  timestamp: number;
}

type TxEventListener = (event: TxEvent) => void;
const listeners: TxEventListener[] = [];

/** Subscribe to transaction status changes. Returns unsubscribe function. */
export function onTxEvent(listener: TxEventListener): () => void {
  listeners.push(listener);
  return () => {
    const idx = listeners.indexOf(listener);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

function emit(type: TxEventType, tracker: TxTracker): void {
  const event: TxEvent = { type, tracker, timestamp: Date.now() };
  for (const listener of listeners) {
    try { listener(event); } catch { /* listeners should not throw */ }
  }
}

// ─── Submit & track ──────────────────────────────────────────────────

/**
 * Register a submitted transaction for monitoring.
 * Call this after the user signs and the tx is broadcast.
 */
export function trackTransaction(opts: {
  hash: string;
  chainId: number;
  provider: McpProviderId;
  destinationChainId?: number;
  /** deBridge order ID or LI.FI route ID for cross-chain tracking. */
  bridgeOrderId?: string;
}): TxTracker {
  const tracker: TxTracker = {
    hash: opts.hash,
    chainId: opts.chainId,
    status: "pending",
    provider: opts.provider,
    destinationChainId: opts.destinationChainId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  txStore.set(opts.hash, tracker);
  emit("submitted", tracker);

  // Start monitoring
  monitorTransaction(opts.hash, opts.bridgeOrderId).catch(() => {});

  return tracker;
}

/** Get a tracked transaction by hash. */
export function getTransaction(hash: string): TxTracker | undefined {
  return txStore.get(hash);
}

/** Get all tracked transactions, optionally filtered by status. */
export function getTransactions(filter?: { status?: TxStatus; chainId?: number }): TxTracker[] {
  const all = Array.from(txStore.values());
  if (!filter) return all;
  return all.filter((t) => {
    if (filter.status && t.status !== filter.status) return false;
    if (filter.chainId && t.chainId !== filter.chainId) return false;
    return true;
  });
}

// ─── Monitoring loop ─────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Poll a transaction's status until it reaches a terminal state.
 * For cross-chain txs, also polls the bridge provider for the destination tx.
 */
async function monitorTransaction(hash: string, bridgeOrderId?: string): Promise<void> {
  const startedAt = Date.now();

  const poll = async () => {
    const tracker = txStore.get(hash);
    if (!tracker) return;

    // Terminal states — stop polling
    if (tracker.status === "confirmed" || tracker.status === "failed") return;

    // Expiry check
    if (Date.now() - tracker.createdAt > EXPIRY_MS) {
      updateStatus(hash, "expired");
      return;
    }

    // Max poll duration
    if (Date.now() - startedAt > MAX_POLL_DURATION_MS) return;

    // Cross-chain: poll bridge provider for destination status
    if (tracker.destinationChainId && tracker.destinationChainId !== tracker.chainId) {
      await pollBridgeStatus(tracker, bridgeOrderId);
    }

    // Schedule next poll
    setTimeout(poll, POLL_INTERVAL_MS);
  };

  // Start first poll after a short delay (give the tx time to propagate)
  setTimeout(poll, 3_000);
}

async function pollBridgeStatus(tracker: TxTracker, bridgeOrderId?: string): Promise<void> {
  try {
    if (tracker.provider === "debridge" && bridgeOrderId) {
      const status = await debridgeProvider.getOrderStatus(bridgeOrderId);
      if (!status) return;

      if (status.status === "fulfilled" || status.status === "claimed") {
        tracker.destinationHash = status.dstTxHash;
        updateStatus(tracker.hash, "confirmed");
        emit("bridged", tracker);
      } else if (status.status === "cancelled") {
        updateStatus(tracker.hash, "failed");
      }
    } else if (tracker.provider === "lifi") {
      const status = await lifiProvider.getRouteStatus(tracker.hash, tracker.chainId);
      if (!status) return;

      if (status.status === "DONE") {
        tracker.destinationHash = status.receiving?.txHash;
        updateStatus(tracker.hash, "confirmed");
        emit("bridged", tracker);
      } else if (status.status === "FAILED") {
        updateStatus(tracker.hash, "failed");
      }
    }
  } catch (err) {
    console.warn("[broadcast] pollBridgeStatus failed:", err);
  }
}

// ─── Status updates ──────────────────────────────────────────────────

function updateStatus(hash: string, status: TxStatus): void {
  const tracker = txStore.get(hash);
  if (!tracker) return;
  const prev = tracker.status;
  if (prev === status) return;

  tracker.status = status;
  tracker.updatedAt = Date.now();

  const eventType: TxEventType =
    status === "confirming" ? "confirming" :
    status === "confirmed" ? "confirmed" :
    status === "failed" ? "failed" :
    status === "expired" ? "expired" :
    "submitted";

  emit(eventType, tracker);
}

/**
 * Manually update a transaction's status (e.g., from a wallet callback
 * or on-chain receipt).
 */
export function setTransactionStatus(hash: string, status: TxStatus, destinationHash?: string): void {
  const tracker = txStore.get(hash);
  if (!tracker) return;
  if (destinationHash) tracker.destinationHash = destinationHash;
  updateStatus(hash, status);
}

// ─── Cleanup ─────────────────────────────────────────────────────────

/** Remove transactions older than maxAgeMs from the store. */
export function pruneOldTransactions(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
  const now = Date.now();
  let pruned = 0;
  for (const [hash, tracker] of txStore.entries()) {
    if (now - tracker.createdAt > maxAgeMs) {
      txStore.delete(hash);
      pruned++;
    }
  }
  return pruned;
}
