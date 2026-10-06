"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { Order } from "@/lib/execution";
import { CHAIN_LABEL } from "@/lib/onchain";
import { formatBaseUnits } from "@/lib/quote";
import { explorerUrlFor } from "@/hooks/useExecute";
import { useExecuteOrder } from "@/hooks/useExecuteOrder";
import { useLivePortfolio } from "@/hooks/useLivePortfolio";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { assessHealthFactorGuardrail } from "@/lib/safety";
import type { OrderFlowState } from "@/lib/executionPlan";

const STATUS_LABEL: Partial<Record<OrderFlowState, string>> = {
  VALIDATING: "Checking your balance…",
  SIMULATING: "Simulating the transaction…",
  APPROVAL_PENDING: "Awaiting approval signature…",
  APPROVAL_CONFIRMED: "Approval confirmed — preparing the transaction…",
  SUPPLY_PENDING: "Awaiting wallet signature…",
  CONFIRMING: "Confirming on-chain…",
};

/**
 * The production validated-execution flow (see docs/execution-audit.md):
 * prepares a versioned plan (live balance check + simulation), shows exactly
 * what will happen before any signature — reusing `buildExecution`'s own
 * `description`/`riskNote` rather than hand-rolled per-protocol text — then
 * signs (approve-if-needed, then the main order) through `useExecuteOrder`'s
 * explicit state machine. On confirmation, refetches the live portfolio so
 * the new position shows up without a reload.
 *
 * Drop-in replacement for the generic `ExecuteButton` — works for any order
 * `buildExecution` supports (Aave/Spark/Compound/Morpho/Maker/Lido/WETH/
 * Rocket Pool/Frax/Uniswap/deBridge/LI.FI/transfers).
 */
export function ValidatedExecuteButton({ order, label }: { order: Order; label: string }) {
  const { isConnected } = useAccount();
  const portfolio = useLivePortfolio();
  const { state, message, builtPlan, approvalHash, mainHash, needsApproval, prepare, confirm, reset } = useExecuteOrder(() => {
    void portfolio.refetchPortfolio();
  });
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    if (state === "READY_FOR_SIGNATURE") setDialogOpen(true);
    if (state === "DRAFT") setDialogOpen(false);
  }, [state]);

  // Health-factor guardrail for REAL-money Aave/Spark/Compound borrow/
  // withdraw. No live health factor is available at signing time in this
  // harness, so the helper honestly reports computable=false and requires
  // an explicit extra confirmation for any HF-lowering action.
  const guardrail = assessHealthFactorGuardrail({ orderType: order.type });

  const amountLabel =
    typeof order.amount === "bigint" ? formatBaseUnits(order.amount, order.decimals ?? 18) : String(order.amount);
  const chainLabel = CHAIN_LABEL[order.chainId] ?? `chain ${order.chainId}`;

  if (state === "CONFIRMED" && mainHash) {
    const url = explorerUrlFor(order.chainId, mainHash);
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-accent-700)" }}>
        Signed onchain ·{" "}
        <a href={url} target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "underline" }}>
          view {mainHash.slice(0, 10)}…
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

  const statusText = STATUS_LABEL[state];
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
    const friendly =
      /reject|declined|user denied/i.test(message ?? "")
        ? "Signature rejected in your wallet."
        : message;
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--risk-bad, #c0392b)" }}>
        {friendly}
        <button
          onClick={reset}
          style={{ marginLeft: 8, background: "none", border: "none", cursor: "pointer", color: "var(--color-neutral-500)", fontSize: 11 }}
        >
          Retry
        </button>
      </p>
    );
  }

  const mustRefuse = !!guardrail.refused;

  return (
    <>
      <button
        className="btn btn-primary"
        style={{ fontSize: 13, marginTop: 6, cursor: "pointer" }}
        onClick={() => prepare(order)}
        title={isConnected ? undefined : "Connect a wallet first"}
      >
        {label}
      </button>
      <ConfirmDialog
        open={dialogOpen && state === "READY_FOR_SIGNATURE"}
        title="Confirm transaction"
        body={
          <div>
            {builtPlan ? builtPlan.description : `${order.type} ${amountLabel} ${order.symbol ?? ""} on ${chainLabel}`}.{" "}
            {needsApproval === true && (
              <>
                This needs <strong>two signatures</strong>: first an approval for exactly this amount, then the
                transaction itself.
              </>
            )}
            {needsApproval === false && <>Your existing allowance already covers this — one signature is needed.</>}{" "}
            {builtPlan?.riskNote}
          </div>
        }
        confirmLabel={needsApproval ? "Approve & Confirm" : "Confirm"}
        warning="This moves real funds from your wallet."
        guardrail={guardrail}
        onConfirm={() => {
          setDialogOpen(false);
          void confirm();
        }}
        onCancel={() => {
          setDialogOpen(false);
          reset();
        }}
      />
      {mustRefuse && dialogOpen && (
        <p style={{ margin: "4px 0 0", fontSize: 11, color: "var(--risk-bad, #c0392b)" }}>{guardrail.reason}</p>
      )}
    </>
  );
}
