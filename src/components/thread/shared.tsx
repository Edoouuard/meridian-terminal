"use client";

import type { RiskTier } from "@/lib/integrations/philidor";
import { fmtUsd } from "@/lib/data";
import type { Order } from "@/lib/execution";
import { BuildingBadge } from "@/components/BuildingBadge";

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
 * Why a step has no button — never a fake success. `building`: the venue or
 * action isn't available in Meridian yet (dashed, muted, a "Building" tag).
 * Otherwise it's what the user has to do or why nothing can run now (connect
 * a wallet, a minimum, no balance): a plain note, no "Building" tag.
 */
export function NotWired({ venue, reason, building = false }: { venue: string; reason: string; building?: boolean }) {
  if (!building) {
    return (
      <p className="text-muted" style={{ margin: "6px 0 0", fontSize: 11 }}>
        {reason}
      </p>
    );
  }
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
        <BuildingBadge />
        <span style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>{venue} isn&apos;t available in Meridian yet</span>
      </div>
      <span className="text-muted" style={{ fontSize: 11 }}>
        {reason}
      </span>
    </div>
  );
}

export function legRowValue(leg: { asset: string; fromAsset?: string; protocol: string; chain?: string; toChain?: string; sizeUsd?: number; leverage?: number }): string {
  return `${leg.fromAsset && leg.fromAsset !== leg.asset ? `${leg.fromAsset} → ` : ""}${leg.asset} · ${leg.protocol}${leg.chain ? ` · ${leg.chain}${leg.toChain ? ` → ${leg.toChain}` : ""}` : ""}${leg.sizeUsd ? ` · ${fmtUsd(leg.sizeUsd)}` : ""}${leg.leverage ? ` · ${leg.leverage}x` : ""}`;
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
