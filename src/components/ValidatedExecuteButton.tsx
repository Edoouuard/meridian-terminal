"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import type { Order } from "@/lib/execution";
import { CHAIN_LABEL } from "@/lib/onchain";
import { formatBaseUnits } from "@/lib/quote";
import { explorerUrlFor } from "@/lib/explorer";
import { useExecuteOrder } from "@/hooks/useExecuteOrder";
import { useLivePortfolio } from "@/hooks/useLivePortfolio";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { guardrailFromSimulation } from "@/lib/safety";
import { useHealthPreview } from "@/hooks/useHealthPreview";
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
export function ValidatedExecuteButton({
  order,
  label,
  onConfirmed,
}: {
  order: Order;
  label: string;
  /** Called once with the main tx hash after it confirms on-chain. */
  onConfirmed?: (hash: `0x${string}`) => void;
}) {
  const { isConnected, address } = useAccount();
  const portfolio = useLivePortfolio();
  const { state, message, builtPlan, approvalHash, mainHash, needsApproval, prepare, confirm, reset } = useExecuteOrder(() => {
    void portfolio.refetchPortfolio();
  });
  // The dialog is open while the plan awaits a signature, until the user
  // confirms or cancels that specific plan (derived — no state sync effect).
  const [dismissedPlan, setDismissedPlan] = useState<typeof builtPlan>(null);
  const dialogOpen = state === "READY_FOR_SIGNATURE" && builtPlan !== dismissedPlan;

  useEffect(() => {
    if (state === "CONFIRMED" && mainHash) onConfirmed?.(mainHash);
  }, [state, mainHash, onConfirmed]);

  // Health-factor guardrail for REAL-money borrow/withdraw. On Aave the
  // resulting health factor is simulated by the Aave MCP (preview_action) as
  // soon as the confirmation opens; the guardrail then shows before → after
  // and blocks anything below the floor. Other venues (and an unreachable
  // MCP) fall back to an explicit extra confirmation — never an invented HF.
  const { preview, isLoading: previewLoading, simulate } = useHealthPreview();
  const simulatesHf = order.protocol === "aave" && (order.type === "borrow" || order.type === "withdraw");
  const confirmOpen = dialogOpen && state === "READY_FOR_SIGNATURE";

  useEffect(() => {
    if (!confirmOpen || !simulatesHf || !address || !order.token || typeof order.amount !== "bigint") return;
    void simulate({
      address,
      chainId: order.chainId,
      action: order.type as "borrow" | "withdraw",
      asset: order.token,
      amount: formatBaseUnits(order.amount, order.decimals ?? 18),
    });
  }, [confirmOpen, simulatesHf, address, order.token, order.amount, order.decimals, order.chainId, order.type, simulate]);

  const guardrail = useMemo(
    () => guardrailFromSimulation(order.type, simulatesHf ? preview : null),
    [order.type, simulatesHf, preview],
  );

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
        open={confirmOpen}
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
            {simulatesHf && previewLoading && (
              <div style={{ marginTop: 6, fontSize: 12, color: "var(--color-neutral-500)" }}>
                Simulating your Aave health factor…
              </div>
            )}
          </div>
        }
        confirmLabel={needsApproval ? "Approve & Confirm" : "Confirm"}
        warning="This moves real funds from your wallet."
        guardrail={guardrail}
        confirmDisabled={simulatesHf && previewLoading}
        onConfirm={() => {
          setDismissedPlan(builtPlan);
          void confirm();
        }}
        onCancel={() => {
          setDismissedPlan(builtPlan);
          reset();
        }}
      />
      {mustRefuse && dialogOpen && (
        <p style={{ margin: "4px 0 0", fontSize: 11, color: "var(--risk-bad, #c0392b)" }}>{guardrail.reason}</p>
      )}
    </>
  );
}
