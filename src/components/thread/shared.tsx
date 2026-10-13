"use client";

import type { RiskTier } from "@/lib/integrations/philidor";
import { fmtUsd } from "@/lib/data";
import type { Order } from "@/lib/execution";

export const RISK_TIER_COLOR: Record<RiskTier, string> = {
  Prime: "var(--risk-good)",
  Core: "var(--risk-warning)",
  Edge: "var(--risk-serious)",
};

export function OrderRow({ label, value, valueColor }: { label: string; value: React.ReactNode; valueColor?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span className="text-muted">{label}</span>
      <span style={{ color: valueColor }}>{value}</span>
    </div>
  );
}

/**
 * Honest "not wired yet" — never fakes a success for a venue the harness
 * can't sign. Styled to visually read as unavailable (dashed border, muted
 * background) with a "Building" tag, so it's obvious at a glance before
 * reading the text.
 */
export function NotWired({ venue, reason }: { venue: string; reason: string }) {
  return (
    <div
      style={{
        margin: "6px 0 0",
        padding: "6px 8px",
        borderRadius: 6,
        border: "1px dashed var(--color-divider)",
        background: "var(--color-neutral-100)",
        display: "flex",
        flexDirection: "column",
        gap: 3,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span className="tag tag-neutral" style={{ fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase" }}>
          Building
        </span>
        <span style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>{venue} isn&apos;t live yet</span>
      </div>
      <span className="text-muted" style={{ fontSize: 11 }}>
        {reason}
      </span>
    </div>
  );
}

export function legRowValue(leg: { asset: string; protocol: string; chain?: string; toChain?: string; sizeUsd?: number; leverage?: number }): string {
  return `${leg.asset} · ${leg.protocol}${leg.chain ? ` · ${leg.chain}${leg.toChain ? ` → ${leg.toChain}` : ""}` : ""}${leg.sizeUsd ? ` · ${fmtUsd(leg.sizeUsd)}` : ""}${leg.leverage ? ` · ${leg.leverage}x` : ""}`;
}

/**
 * Type predicate to disambiguate an unsupported result from an `Order`. `Order`
 * carries a `[k: string]: unknown` index signature, so a bare `"unsupported" in r`
 * check cannot narrow it — this predicate gives TS an explicit narrowing on both
 * branches (true → `{ unsupported: string }`, false → `Order`).
 */
export function isUnsupported(r: Order | { unsupported: string }): r is { unsupported: string } {
  return "unsupported" in r && typeof r.unsupported === "string";
}
