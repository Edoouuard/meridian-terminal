"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { useLifiPerpsSetup } from "@/hooks/useLifiPerpsSetup";
import { LIFI_PROVIDER_LABEL, type LifiPerpsProviderId } from "@/lib/integrations/lifiPerps";

function humanizeAction(type: string): string {
  return type
    .toLowerCase()
    .split("_")
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Connect/onboarding panel for an LI.FI-backed venue (Ondo or Lighter): walks
 * the generic setup checklist (SIWE login, key registration, ...) one signed
 * step at a time, then a first deposit once setup clears. Same component for
 * both venues — the SDK's `checkSetup`/`getDepositFlow` already abstract
 * away each venue's specific auth scheme.
 */
export function LifiPerpsConnectPanel({ provider }: { provider: LifiPerpsProviderId }) {
  const { isConnected } = useAccount();
  const label = LIFI_PROVIDER_LABEL[provider];
  const setup = useLifiPerpsSetup(provider);
  const [amount, setAmount] = useState("");

  return (
    <>
      <div className="hr" style={{ margin: "var(--space-3) 0" }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h6 style={{ color: "var(--color-accent)", margin: 0 }}>{label}</h6>
        {setup.isReady && (
          <span className="tag tag-neutral" style={{ fontSize: 10 }}>
            ready
          </span>
        )}
      </div>

      {!isConnected && (
        <p style={{ fontSize: 11, margin: "6px 0 0" }} className="text-muted">
          Connect a wallet to set up {label}.
        </p>
      )}

      {isConnected && setup.loading && (
        <p style={{ fontSize: 11, margin: "6px 0 0" }} className="text-muted">
          Checking your {label} account…
        </p>
      )}

      {isConnected && !setup.loading && setup.isReady && (
        <p style={{ fontSize: 11, margin: "6px 0 0" }} className="text-muted">
          Connected and funded. Perp legs routed to {label} will sign and submit live.
        </p>
      )}

      {isConnected && !setup.loading && !setup.isReady && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: "var(--space-2)" }}>
          {setup.checklist.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {setup.checklist.map((item, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
                  <span className={item.satisfied ? "text-muted" : undefined}>
                    {item.satisfied ? "✓ " : ""}
                    {humanizeAction(item.descriptor.type)}
                  </span>
                  {!item.satisfied && i === setup.checklist.findIndex((c) => !c.satisfied) && (
                    <button
                      className="btn btn-secondary"
                      style={{ fontSize: 10, padding: "2px 8px" }}
                      onClick={() => setup.runNextStep()}
                      disabled={setup.runningStep}
                    >
                      {setup.runningStep ? "signing…" : "sign"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {setup.checklist.length === 0 && !setup.accountExists && !setup.depositFlow && (
            <p style={{ fontSize: 11, margin: 0 }} className="text-muted">
              No {label} account found for this wallet yet.
            </p>
          )}

          {setup.depositFlow?.kind === "firstDepositPipeline" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <p style={{ fontSize: 11, margin: 0 }} className="text-muted">
                Deposit collateral to {setup.accountExists ? "fund" : "open"} your {label} account.
              </p>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  className="input"
                  style={{ fontSize: 12, flex: 1 }}
                  placeholder="Amount (USDC)"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <button
                  className="btn btn-primary"
                  style={{ fontSize: 12 }}
                  disabled={setup.depositing || !amount}
                  onClick={() => setup.deposit(amount)}
                >
                  {setup.depositing ? "depositing…" : "Deposit"}
                </button>
              </div>
              {setup.depositError && (
                <p style={{ fontSize: 11, margin: 0, color: "var(--risk-bad, #c0392b)" }}>{setup.depositError}</p>
              )}
            </div>
          )}

          {setup.depositFlow?.kind === "lifiSwap" && (
            <p style={{ fontSize: 11, margin: 0 }} className="text-muted">
              {label} funds from any token via a swap — not wired here yet. Deposit directly on {label}&apos;s own
              app for now.
            </p>
          )}

          {setup.error && <p style={{ fontSize: 11, margin: 0, color: "var(--risk-bad, #c0392b)" }}>{setup.error}</p>}
        </div>
      )}
    </>
  );
}
