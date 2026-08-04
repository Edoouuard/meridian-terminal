import { useEffect, useState } from "react";

/**
 * Meridian local order-history / activity store.
 *
 * A tiny localStorage-backed log of executions (and future activity) so the
 * terminal keeps a recent-order history across reloads. Real executions
 * (ThreadCard's `useExecute` / `useHyperliquid` run sites) should call
 * `recordExecution(...)` so the panel updates live via `useHistory()`.
 *
 * This module is client-only in spirit (it touches `window.localStorage` and
 * React), but the pure storage functions (`recordExecution`, `getHistory`,
 * `clearHistory`) are side-effect free enough to run under node by mirroring
 * `window.localStorage` — useful for a quick roundtrip sanity check.
 */

export const HISTORY_KEY = "meridian:orderHistory";
/** Hard cap on how many records we keep (oldest are dropped first). */
export const HISTORY_LIMIT = 100;

export type OrderStatus = "confirmed" | "error" | "pending";
export type OrderRecordType =
  | "buy"
  | "sell"
  | "swap"
  | "deposit"
  | "withdraw"
  | "claim"
  | "close"
  | "custom";

export interface OrderRecord {
  /** Stable unique id (randomUUID when available). */
  id: string;
  /** Coarse kind — used for future icons/grouping, kept loose on purpose. */
  type: OrderRecordType;
  /** Human-readable headline, e.g. "Buy 1.2 ETH" or "Lock fixed yield". */
  label: string;
  /** Formatted amount string, e.g. "1.2" (optional). */
  amount?: string;
  /** Asset symbol, e.g. "ETH". */
  asset?: string;
  /** Protocol / venue, e.g. "Pendle", "Aave", "Hyperliquid". */
  protocol?: string;
  /** Chain id the order executed on, if known. */
  chainId?: number;
  /** confirmed | error | pending. */
  status: OrderStatus;
  /** Optional transaction / order hash. */
  hash?: string;
  /** Epoch ms the order was recorded at. */
  ts: number;
}

export type RecordExecutionInput = Omit<OrderRecord, "id" | "ts"> & { ts?: number };

type Listener = () => void;
const listeners = new Set<Listener>();

function emitChange(): void {
  listeners.forEach((l) => l());
}

/** Subscribe to store changes. Returns an unsubscribe fn. */
export function subscribeHistory(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isOrderRecord(value: unknown): value is OrderRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.label === "string" &&
    typeof v.status === "string" &&
    typeof v.ts === "number"
  );
}

function readRaw(): OrderRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isOrderRecord);
  } catch {
    // Corrupt or unparseable payload — treat as empty rather than crash.
    return [];
  }
}

function persist(items: OrderRecord[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
  } catch {
    // Quota / private-mode failure — non-fatal, just don't persist.
  }
}

function makeId(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Log an order / activity record. Newest-first; keeps at most HISTORY_LIMIT.
 * Returns the stored (normalised) record so callers can read back its id/ts.
 */
export function recordExecution(input: RecordExecutionInput): OrderRecord {
  const record: OrderRecord = {
    ...input,
    id: makeId(),
    ts: input.ts ?? Date.now(),
  };
  const next = [record, ...readRaw()].slice(0, HISTORY_LIMIT);
  persist(next);
  emitChange();
  return record;
}

/** All recorded orders, newest-first. */
export function getHistory(): OrderRecord[] {
  return readRaw().sort((a, b) => b.ts - a.ts);
}

/** Wipe the order history (panel + localStorage). */
export function clearHistory(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(HISTORY_KEY);
  } catch {
    // ignore
  }
  emitChange();
}

/**
 * React hook — live-renders the order history. Re-renders when a record is
 * added/cleared in this tab (local emitter) or another (storage event).
 */
export function useHistory(): OrderRecord[] {
  const [items, setItems] = useState<OrderRecord[]>(() => getHistory());

  useEffect(() => {
    const refresh = () => setItems(getHistory());
    const onStorage = (e: StorageEvent) => {
      if (e.key === HISTORY_KEY) refresh();
    };
    const unsubscribe = subscribeHistory(refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      unsubscribe();
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return items;
}
