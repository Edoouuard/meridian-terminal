"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useExecute } from "@/hooks/useExecute";
import { formatBaseUnits } from "@/lib/quote";
import type { Order } from "@/lib/execution";
import {
  LIDO_GET_WITHDRAWAL_REQUESTS_ABI,
  LIDO_GET_WITHDRAWAL_STATUS_ABI,
  LIDO_WITHDRAWAL_QUEUE_ADDRESS,
  isClaimable,
  type LidoWithdrawalRequest,
} from "@/lib/integrations/lido";

/**
 * LidoWithdrawalsPanel — the other half of Lido unstaking that ThreadCard's
 * LidoUnstakeButton can't cover: a withdrawal request isn't instant (Lido's
 * oracle finalizes it over time), so someone has to show its status and let
 * the user claim the ETH once it's ready. Reads getWithdrawalRequests +
 * getWithdrawalStatus directly (mainnet only, same address verified in
 * lib/integrations/lido.ts) rather than through an indexer — Lido's own
 * contract already exposes exactly this for free.
 */
export function LidoWithdrawalsPanel() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId: 1 });
  const [requests, setRequests] = useState<LidoWithdrawalRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState<LidoWithdrawalRequest | null>(null);

  const { status, data: claimTxHash, error: claimError, execute, reset } = useExecute();

  const refresh = useCallback(async () => {
    if (!address || !publicClient) return;
    setLoading(true);
    setError(null);
    try {
      const ids = await publicClient.readContract({
        address: LIDO_WITHDRAWAL_QUEUE_ADDRESS,
        abi: LIDO_GET_WITHDRAWAL_REQUESTS_ABI,
        functionName: "getWithdrawalRequests",
        args: [address],
      });
      if (!ids || ids.length === 0) {
        setRequests([]);
        return;
      }
      const statuses = await publicClient.readContract({
        address: LIDO_WITHDRAWAL_QUEUE_ADDRESS,
        abi: LIDO_GET_WITHDRAWAL_STATUS_ABI,
        functionName: "getWithdrawalStatus",
        args: [ids],
      });
      setRequests(
        ids.map((id, i) => ({
          id,
          amountOfStETH: statuses[i].amountOfStETH,
          timestamp: statuses[i].timestamp,
          isFinalized: statuses[i].isFinalized,
          isClaimed: statuses[i].isClaimed,
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [address, publicClient]);

  useEffect(() => {
    if (isConnected && address) {
      const id = setTimeout(() => refresh(), 0);
      return () => clearTimeout(id);
    }
  }, [isConnected, address, refresh]);

  if (!isConnected || !address) return null;

  const pending = requests.filter((r) => !r.isClaimed);
  // Nothing pending and nothing wrong — stay out of the way rather than
  // permanently occupying sidebar space for a feature most visits won't use.
  if (!loading && pending.length === 0 && !error) return null;

  return (
    <>
      <div className="hr" style={{ margin: "var(--space-3) 0" }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h6 style={{ color: "var(--color-accent)", margin: 0 }}>Lido withdrawals</h6>
        <button className="btn btn-secondary" style={{ fontSize: 10, padding: "2px 8px" }} onClick={refresh}>
          refresh
        </button>
      </div>

      {loading && (
        <p className="text-muted" style={{ fontSize: 11, margin: "6px 0 0" }}>
          Reading your withdrawal requests…
        </p>
      )}
      {error && <p style={{ fontSize: 11, margin: "6px 0 0", color: "var(--risk-warning)" }}>{error}</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: pending.length > 0 ? "var(--space-2)" : 0 }}>
        {pending.map((r) => (
          <div
            key={r.id.toString()}
            style={{
              border: "1px solid var(--color-divider)",
              borderRadius: "var(--radius-sm)",
              padding: "6px 8px",
              fontSize: 11,
              display: "flex",
              flexDirection: "column",
              gap: 3,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontWeight: 600, fontFamily: "var(--font-heading)" }}>
                #{r.id.toString()} · {formatBaseUnits(r.amountOfStETH, 18)} stETH
              </span>
              <span style={{ color: isClaimable(r) ? "var(--risk-good)" : "var(--color-neutral-500)" }}>
                {isClaimable(r) ? "claimable" : "pending finalization"}
              </span>
            </div>
            {isClaimable(r) && (
              <button
                className="btn btn-secondary"
                style={{ fontSize: 10, padding: "2px 8px", alignSelf: "flex-end" }}
                onClick={() => setClaiming(r)}
              >
                Claim
              </button>
            )}
          </div>
        ))}
      </div>

      {status !== "idle" && (
        <p style={{ fontSize: 11, marginTop: 6 }}>
          {status === "confirming"
            ? "Awaiting wallet signature…"
            : status === "confirmed" && claimTxHash
              ? `Claimed: ${claimTxHash.slice(0, 10)}…`
              : `Error: ${claimError instanceof Error ? claimError.message : String(claimError ?? "failed")}`}
          <button
            onClick={() => {
              reset();
              refresh();
            }}
            style={{ marginLeft: 6, background: "none", border: "none", cursor: "pointer", color: "var(--color-neutral-500)", fontSize: 10 }}
          >
            clear
          </button>
        </p>
      )}

      <ConfirmDialog
        open={!!claiming}
        title={claiming ? `Claim withdrawal #${claiming.id}` : "Claim"}
        body={
          claiming ? (
            <div>
              Send the finalized {formatBaseUnits(claiming.amountOfStETH, 18)} ETH from request #{claiming.id.toString()} to your
              wallet.
            </div>
          ) : null
        }
        confirmLabel="Claim ETH"
        warning="Moves real ETH to your wallet."
        onConfirm={() => {
          if (!claiming) return;
          const order: Order = { type: "claim", protocol: "lido", amount: "0", decimals: 18, chainId: 1, requestId: claiming.id };
          setClaiming(null);
          execute(order);
        }}
        onCancel={() => setClaiming(null)}
      />
    </>
  );
}
