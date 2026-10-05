"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { Order } from "@/lib/execution";
import { CHAIN_LABEL } from "@/lib/onchain";
import { formatBaseUnits } from "@/lib/quote";
import { explorerUrlFor } from "@/hooks/useExecute";
import { useAaveSupply } from "@/hooks/useAaveSupply";
import { useLivePortfolio } from "@/hooks/useLivePortfolio";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import type { SupplyFlowState } from "@/lib/executionPlan";

const STATUS_LABEL: Partial<Record<SupplyFlowState, string>> = {
  VALIDATING: "Checking your balance…",
  SIMULATING: "Simulating the transaction…",
  APPROVAL_PENDING: "Awaiting approval signature…",
  APPROVAL_CONFIRMED: "Approval confirmed — preparing supply…",
  SUPPLY_PENDING: "Awaiting supply signature…",
  CONFIRMING: "Confirming on-chain…",
};

/**
 * The production USDC -> Aave v3 supply flow (see docs/execution-audit.md):
 * prepares a versioned plan (live balance check + simulation), shows exactly
 * what will happen before any signature, then signs (approve-if-needed, then
 * supply) through `useAaveSupply`'s explicit state machine. On confirmation,
 * refetches the live portfolio so the new position shows up without a reload.
 *
 * Drop-in replacement for the generic `ExecuteButton` for Aave supply orders
 * specifically — every other protocol/order-type keeps using `ExecuteButton`.
 */
export function AaveSupplyExecuteButton({ order, label }: { order: Order; label: string }) {
  const { isConnected } = useAccount();
  const portfolio = useLivePortfolio();
  const { state, message, approvalHash, supplyHash, needsApproval, prepare, confirm, reset } = useAaveSupply(() => {
    void portfolio.refetchPortfolio();
  });
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    if (state === "READY_FOR_SIGNATURE") setDialogOpen(true);
    if (state === "DRAFT") setDialogOpen(false);
  }, [state]);

  const amountLabel =
    typeof order.amount === "bigint" ? formatBaseUnits(order.amount, order.decimals ?? 6) : String(order.amount);
  const chainLabel = CHAIN_LABEL[order.chainId] ?? `chain ${order.chainId}`;

  if (state === "CONFIRMED" && supplyHash) {
    const url = explorerUrlFor(order.chainId, supplyHash);
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-accent-700)" }}>
        Supplied onchain ·{" "}
        <a href={url} target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "underline" }}>
          view {supplyHash.slice(0, 10)}…
        </a>
        <button
          onClick={reset}
          style={{ marginLeft: 8, background: "none", border: "none", cursor: "pointer", color: "var(--color-neutral-500)", fontSize: 11 }}
        >
          clear
        </button>
      </p>
    );
  }

  const statusText = STATUS_LABEL[state as keyof typeof STATUS_LABEL];
  if (statusText) {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)" }}>
        {statusText}
        {approvalHash && state !== "APPROVAL_PENDING" && (
          <>
            {" "}
            ·{" "}
            <a href={explorerUrlFor(order.chainId, approvalHash)} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
              approval {approvalHash.slice(0, 8)}…
            </a>
          </>
        )}
      </p>
    );
  }

  const isFailure = state !== "DRAFT" && state !== "READY_FOR_SIGNATURE" && message !== null && !statusText;
  if (isFailure) {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--risk-bad, #c0392b)" }}>
        {message}
        <button
          onClick={reset}
          style={{ marginLeft: 8, background: "none", border: "none", cursor: "pointer", color: "var(--color-neutral-500)", fontSize: 11 }}
        >
          Retry
        </button>
      </p>
    );
  }

  return (
    <>
      <button
        className="btn btn-primary"
        style={{ fontSize: 13, marginTop: 6, cursor: "pointer" }}
        onClick={() =>
          prepare({
            chainId: order.chainId,
            token: order.token!,
            symbol: order.symbol ?? "USDC",
            decimals: order.decimals ?? 6,
            amount: order.amount,
          })
        }
        title={isConnected ? undefined : "Connect a wallet first"}
      >
        {label}
      </button>
      <ConfirmDialog
        open={dialogOpen && state === "READY_FOR_SIGNATURE"}
        title="Supply to Aave v3"
        body={
          <div>
            Supply <strong>{amountLabel}</strong> {order.symbol ?? "USDC"} to Aave v3 on {chainLabel}.{" "}
            {needsApproval ? (
              <>
                This needs <strong>two signatures</strong>: first an approval for exactly this amount, then the
                supply itself.
              </>
            ) : (
              <>
                Your existing allowance already covers this amount — <strong>one signature</strong> is needed.
              </>
            )}{" "}
            The transaction has already been simulated against live chain state.
          </div>
        }
        confirmLabel={needsApproval ? "Approve & Supply" : "Supply"}
        warning="This moves real funds from your wallet."
        onConfirm={() => {
          setDialogOpen(false);
          void confirm();
        }}
        onCancel={() => {
          setDialogOpen(false);
          reset();
        }}
      />
    </>
  );
}
