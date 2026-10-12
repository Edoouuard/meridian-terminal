"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import type { Order } from "@/lib/execution";

// ─── Chain name → chain id mapping ──────────────────────────────────

const CHAIN_NAME_TO_ID: Record<string, number> = {
  ethereum: 1, mainnet: 1,
  optimism: 10,
  "bnb chain": 56, bsc: 56,
  gnosis: 100,
  polygon: 137,
  sonic: 146,
  fantom: 250,
  "zksync era": 324, zksync: 324,
  metis: 1088,
  mantle: 5000,
  base: 8453,
  arbitrum: 42161,
  celo: 42220,
  avalanche: 43114,
  linea: 59144,
  scroll: 534352,
};

export function chainIdFromName(name: string): number | undefined {
  return CHAIN_NAME_TO_ID[name.toLowerCase().trim()];
}

// ─── Native USDC per chain (all 6 decimals on these chains) ─────────

export const USDC_BY_CHAIN: Record<number, Address> = {
  1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  10: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  137: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
};

// ─── Types ──────────────────────────────────────────────────────────

export type BridgeStatus =
  | "idle"
  | "quoting"
  | "quoted"
  | "bridging" // source tx confirmed, waiting for delivery on the destination chain
  | "delivered"
  | "failed"
  | "error";

export interface BridgeQuote {
  provider: "debridge" | "lifi";
  fromChainId: number;
  toChainId: number;
  /** Destination amount estimate, base units. */
  toAmount: string;
  estimatedTimeSeconds: number;
  reason: string;
}

export interface BridgeState {
  status: BridgeStatus;
  quote: BridgeQuote | null;
  /**
   * The quoted route as an Order for the validated execution flow
   * (`ValidatedExecuteButton`): allowlisted entrypoint check, exact-amount
   * approval read live on-chain, simulation, then signature. This hook never
   * signs anything itself.
   */
  order: Order | null;
  srcTxHash: `0x${string}` | null;
  orderId: string | null;
  /** Raw destination status from the provider (e.g. "Created", "Fulfilled", "PENDING", "DONE"). */
  deliveryStatus: string | null;
  error: string | null;
}

export interface BridgeQuoteParams {
  fromChainId: number;
  toChainId: number;
  fromToken: Address;
  toToken: Address;
  /** Base units. */
  fromAmount: string;
  symbol: string;
  decimals: number;
}

export interface UseBridgeResult extends BridgeState {
  fetchQuote: (params: BridgeQuoteParams) => Promise<void>;
  /** Call once the source-chain tx is confirmed: starts delivery tracking. */
  onSourceConfirmed: (hash: `0x${string}`) => void;
  reset: () => void;
}

const POLL_MS = 20_000;
const DELIVERED = new Set(["Fulfilled", "SentUnlock", "ClaimedUnlock", "DONE"]);
const FAILED = new Set(["Cancelled", "FAILED"]);

interface ApiRouteQuote {
  provider: "debridge" | "lifi";
  tx: { to: string; data: string; value?: string; chainId: number };
  toAmountEstimate?: string;
  etaSeconds?: number;
  orderId?: string;
}

const INITIAL: BridgeState = {
  status: "idle",
  quote: null,
  order: null,
  srcTxHash: null,
  orderId: null,
  deliveryStatus: null,
  error: null,
};

/**
 * Cross-chain bridge via Meridian's routing layer (deBridge + LI.FI compared
 * server-side by /api/bridge).
 *
 * Flow: fetchQuote → render `order` with ValidatedExecuteButton (which does
 * every safety check and the signing) → onSourceConfirmed(hash) → this hook
 * polls /api/bridge?action=status until the funds land on the destination.
 */
export function useBridge(): UseBridgeResult {
  const { address } = useAccount();
  const [state, setState] = useState<BridgeState>(INITIAL);

  const fetchQuote = useCallback(
    async (params: BridgeQuoteParams) => {
      if (!address) {
        setState({ ...INITIAL, status: "error", error: "Connect a wallet first." });
        return;
      }
      setState({ ...INITIAL, status: "quoting" });

      try {
        const res = await fetch("/api/bridge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fromChainId: params.fromChainId,
            toChainId: params.toChainId,
            fromToken: params.fromToken,
            toToken: params.toToken,
            fromAmount: params.fromAmount,
            userAddress: address,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setState({ ...INITIAL, status: "error", error: data.error ?? "No route available." });
          return;
        }

        const best = data.best as ApiRouteQuote | undefined;
        if (!best?.tx) {
          setState({ ...INITIAL, status: "error", error: "No route returned." });
          return;
        }

        const order: Order = {
          type: "swap",
          protocol: best.provider,
          token: params.fromToken,
          symbol: params.symbol,
          amount: BigInt(params.fromAmount),
          chainId: params.fromChainId,
          decimals: params.decimals,
          routerTx: {
            to: best.tx.to as Address,
            data: best.tx.data as `0x${string}`,
            value: best.tx.value !== undefined ? BigInt(best.tx.value) : undefined,
          },
        };

        setState({
          ...INITIAL,
          status: "quoted",
          order,
          orderId: best.orderId ?? null,
          quote: {
            provider: best.provider,
            fromChainId: params.fromChainId,
            toChainId: params.toChainId,
            toAmount: best.toAmountEstimate ?? "0",
            estimatedTimeSeconds: best.etaSeconds ?? 120,
            reason: data.comparison?.reason ?? "",
          },
        });
      } catch (err) {
        setState({ ...INITIAL, status: "error", error: err instanceof Error ? err.message : "Quote failed." });
      }
    },
    [address],
  );

  const onSourceConfirmed = useCallback((hash: `0x${string}`) => {
    setState((s) => (s.srcTxHash === hash ? s : { ...s, status: "bridging", srcTxHash: hash }));
  }, []);

  // Poll destination delivery while bridging.
  useEffect(() => {
    if (state.status !== "bridging" || !state.quote || !state.srcTxHash) return;
    const { provider, fromChainId, toChainId } = state.quote;
    const url =
      provider === "debridge" && state.orderId
        ? `/api/bridge?action=status&provider=debridge&orderId=${state.orderId}`
        : `/api/bridge?action=status&provider=lifi&txHash=${state.srcTxHash}&fromChainId=${fromChainId}&toChainId=${toChainId}`;

    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(url);
        if (!res.ok || cancelled) return; // not indexed yet — keep polling
        const data = (await res.json()) as { status?: string };
        const status = data.status ?? null;
        if (cancelled || !status) return;
        setState((s) => ({
          ...s,
          deliveryStatus: status,
          status: DELIVERED.has(status) ? "delivered" : FAILED.has(status) ? "failed" : s.status,
        }));
      } catch {
        // transient — keep polling
      }
    };
    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [state.status, state.quote, state.srcTxHash, state.orderId]);

  const reset = useCallback(() => setState(INITIAL), []);

  return { ...state, fetchQuote, onSourceConfirmed, reset };
}
