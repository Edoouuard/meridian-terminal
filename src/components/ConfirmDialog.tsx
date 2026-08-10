"use client";

import { ReactNode } from "react";
import type { HealthFactorEstimateResult } from "@/lib/safety";

/**
 * ConfirmDialog — a lightweight confirmation modal shown before any real
 * wallet signature / order submission. Every on-chain or order action goes
 * through this so the user sees exactly what will be signed/submitted first.
 *
 * `guardrail` (optional) carries the health-factor guardrail assessment for
 * HF-lowering Aave actions (borrow/withdraw). When the assessment says the
 * action must be refused (estimated resulting health factor below the floor),
 * the confirm button is disabled and the reason is surfaced. When a live health
 * factor is unavailable (computable=false), the action is flagged louder and the
 * label changes to "I understand — Sign anyway", so every borrow/withdraw at
 * minimum gets an explicit extra confirmation.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  warning,
  guardrail,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  warning?: string;
  guardrail?: HealthFactorEstimateResult | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;

  const mustRefuse = !!guardrail?.refused;
  const isHfLowering = !!guardrail?.lowersHealthFactor;
  const needsExtraConfirm = isHfLowering && !guardrail?.computable;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--space-4)",
      }}
      onClick={onCancel}
    >
      <div
        className="card"
        style={{
          maxWidth: 420,
          width: "100%",
          gap: "var(--space-2)",
          padding: "var(--space-4)",
          background: "var(--color-surface)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h6 style={{ margin: 0, color: "var(--color-accent)" }}>{title}</h6>
        <div style={{ fontSize: 14, lineHeight: 1.5, color: "color-mix(in srgb, var(--color-text) 85%, transparent)" }}>
          {body}
        </div>
        {warning && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--risk-warning)", fontWeight: 600 }}>{warning}</p>
        )}
        {guardrail && guardrail.lowersHealthFactor && (
          <div
            style={{
              margin: 0,
              border: `1px solid var(--risk-warning)`,
              borderRadius: "var(--radius-md)",
              padding: "var(--space-2)",
              background: "color-mix(in srgb, var(--risk-warning) 8%, transparent)",
              fontSize: 12,
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            <strong style={{ color: "var(--risk-warning)" }}>
              {mustRefuse ? "Execution blocked — health-factor guardrail" : "Health-factor-lowering action"}
            </strong>
            {guardrail.reason && <div style={{ color: "var(--risk-warning)" }}>{guardrail.reason}</div>}
            {guardrail.computable && guardrail.estimatedHf != null && (
              <div style={{ color: "var(--color-text)" }}>
                Estimated resulting health factor: ~{guardrail.estimatedHf.toFixed(2)} (floor 1.10).
              </div>
            )}
            {needsExtraConfirm && (
              <div style={{ color: "var(--risk-warning)", fontWeight: 600 }}>
                A live health factor is not available to verify safety. Confirm below that you understand this lowers
                your health factor.
              </div>
            )}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: "var(--space-2)" }}>
          <button className="btn btn-secondary" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className="btn btn-primary" onClick={onConfirm} disabled={mustRefuse}>
            {needsExtraConfirm && !mustRefuse ? "I understand — Sign anyway" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
