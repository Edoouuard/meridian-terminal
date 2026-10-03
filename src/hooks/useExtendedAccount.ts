"use client";

import { useSyncExternalStore } from "react";
import { starkPublicKey } from "@blackcube/extended-sdk";
import type { Signer as ExtendedSigner, Network as ExtendedNetwork } from "@blackcube/extended-sdk";

/**
 * useExtendedAccount.ts — client-side connection state for Extended (ex-X10).
 *
 * Unlike Hyperliquid (whose orders are authorized entirely by the connected
 * wallet's EIP-712 signature — no separate account setup), Extended is a
 * StarkEx/Starknet perp venue: orders are signed with a Stark L2 keypair, and
 * trading requires an Extended account with an API key + a vault (position)
 * id, both issued by Extended's own dashboard (extended.exchange -> API
 * management). A browser wallet cannot produce a Stark-curve signature on its
 * own, so there is no "just connect your wallet" path here — the user pastes
 * the API key, Stark private key, and vault id Extended already gave them for
 * their account, exactly as they would for any other bot/API integration.
 *
 * These credentials are stored ONLY in this browser's localStorage and are
 * used ONLY to sign requests sent directly from the browser to Extended's own
 * API — Meridian has no backend that ever sees them. That said, the Stark
 * private key can authorize withdrawals as well as orders on Extended's side,
 * so treat it like a hot-wallet key: scope it to a sub-account you're
 * comfortable automating, on a device you trust. Meridian itself never calls
 * anything beyond order placement with it.
 */

const STORAGE_KEY = "meridian:extendedSigner:v1";

export class ExtendedKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtendedKeyError";
  }
}

export interface ConnectExtendedInput {
  apiKey: string;
  /** Stark L2 private key, as given by Extended's API management page (hex, with or without "0x"). */
  l2PrivateKey: string;
  vaultId: string;
  network: ExtendedNetwork;
}

function normalizeHex(v: string): `0x${string}` {
  const t = v.trim();
  const hex = t.startsWith("0x") || t.startsWith("0X") ? t.slice(2) : t;
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length === 0) {
    throw new ExtendedKeyError("That doesn't look like a valid Stark private key (expected hex).");
  }
  return `0x${hex}`;
}

function loadFromStorage(): ExtendedSigner | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ExtendedSigner;
    if (!parsed.apiKey || !parsed.l2PrivateKey || !parsed.l2PublicKey || !parsed.vaultId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function persist(next: ExtendedSigner | null): void {
  if (typeof window === "undefined") return;
  try {
    if (next) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode / quota) — the session still works,
    // it just won't remember the connection across reloads.
  }
}

let signer: ExtendedSigner | null = loadFromStorage();
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

/**
 * Validate + store an Extended signer. Derives the Stark public key from the
 * pasted private key (via `@scure/starknet`, the same library the settlement
 * signature itself uses) rather than trusting whatever the caller typed, so a
 * mistyped key fails loudly here instead of surfacing as a rejected order
 * later. Throws `ExtendedKeyError` on a malformed key.
 */
export function connectExtendedAccount(input: ConnectExtendedInput): ExtendedSigner {
  const apiKey = input.apiKey.trim();
  const vaultId = input.vaultId.trim();
  if (!apiKey) throw new ExtendedKeyError("An Extended API key is required.");
  if (!vaultId) throw new ExtendedKeyError("A vault (position) id is required.");

  const l2PrivateKey = normalizeHex(input.l2PrivateKey);
  let l2PublicKey: `0x${string}`;
  try {
    l2PublicKey = normalizeHex(starkPublicKey(l2PrivateKey));
  } catch (err) {
    throw new ExtendedKeyError(
      `Could not derive a public key from that private key — double-check it was copied in full. (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const next: ExtendedSigner = { apiKey, l2PrivateKey, l2PublicKey, vaultId, network: input.network };
  signer = next;
  persist(next);
  emit();
  return next;
}

export function disconnectExtendedAccount(): void {
  signer = null;
  persist(null);
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ExtendedSigner | null {
  return signer;
}

function getServerSnapshot(): ExtendedSigner | null {
  return null;
}

/** The connected Extended signer, or `null` when no account is connected yet. */
export function useExtendedAccount(): ExtendedSigner | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
