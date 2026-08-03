"use client";

import { ReactNode } from "react";

/**
 * ConfirmDialog — a lightweight confirmation modal shown before any real
 * wallet signature / order submission. Every on-chain or order action goes
 * through this so the user sees exactly what will be signed/submitted first.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  warning,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  warning?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
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
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: "var(--space-2)" }}>
          <button className="btn btn-secondary" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className="btn btn-primary" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
