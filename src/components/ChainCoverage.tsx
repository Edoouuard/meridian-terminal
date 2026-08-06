"use client";

import { useState } from "react";
import { ALL_CHAINS, countStatus, type IntegrationStatus } from "@/lib/chains";

const STATUS_LABEL: Record<IntegrationStatus, string> = {
  live: "live",
  read: "read",
  planned: "planned",
};

const STATUS_COLOR: Record<IntegrationStatus, string> = {
  live: "var(--risk-good)",
  read: "var(--color-accent-700)",
  planned: "var(--color-neutral-500)",
};

/**
 * ChainCoverage — a compact "chain × protocol" coverage map for the terminal.
 * Shows each chain Meridian tracks, how many of its top protocols are live /
 * readable / planned, and lets you expand a chain to see the protocol list.
 */
export function ChainCoverage() {
  const [open, setOpen] = useState<string | null>(null);
  const live = ALL_CHAINS.reduce((s, c) => s + countStatus(c, "live"), 0);
  const read = ALL_CHAINS.reduce((s, c) => s + countStatus(c, "read"), 0);
  const planned = ALL_CHAINS.reduce((s, c) => s + countStatus(c, "planned"), 0);

  return (
    <>
      <div className="hr" style={{ margin: "var(--space-3) 0" }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h6 style={{ color: "var(--color-accent)", margin: 0 }}>Chains</h6>
        <span className="text-muted" style={{ fontSize: 11 }}>
          {ALL_CHAINS.length} chains · {live} live · {read} read · {planned} planned
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", marginTop: "var(--space-2)" }}>
        {ALL_CHAINS.map((chain) => {
          const isOpen = open === chain.id;
          return (
            <div
              key={chain.id}
              style={{ borderBottom: "1px solid var(--color-divider)", fontSize: 12, padding: "4px 0" }}
            >
              <button
                onClick={() => setOpen(isOpen ? null : chain.id)}
                style={{
                  width: "100%",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--color-text)",
                  padding: "2px 0",
                  textAlign: "left",
                }}
              >
                <span style={{ fontFamily: "var(--font-heading)", fontWeight: 600 }}>
                  {chain.name}
                  {chain.walletAdapter === "wagmi" ? " · EVM" : chain.id === "hyperliquid" ? " · HL" : ""}
                </span>
                <span className="text-muted" style={{ fontSize: 11 }}>
                  {countStatus(chain, "live")} live · {countStatus(chain, "read")} read · {countStatus(chain, "planned")} planned
                </span>
              </button>

              {isOpen && (
                <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "4px 0 6px" }}>
                  <p className="text-muted" style={{ margin: 0, fontSize: 11 }}>
                    {chain.sdk ? `Runtime: ${chain.sdk}` : ""}
                  </p>
                  {chain.protocols.map((p) => (
                    <div key={p.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                      <span>
                        {p.name}
                        {p.token ? ` · ${p.token}` : ""}
                      </span>
                      <span style={{ color: STATUS_COLOR[p.status], fontSize: 11, flex: "none" }}>{STATUS_LABEL[p.status]}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-muted" style={{ fontSize: 10, margin: "var(--space-2) 0 0" }}>
        Status is honest: live = executable today, read = balances/positions readable, planned = inventoried, to wire next.
      </p>
    </>
  );
}
