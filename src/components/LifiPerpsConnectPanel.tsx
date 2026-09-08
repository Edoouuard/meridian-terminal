"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { getPositions, PositionSide } from "@lifi/perps-sdk";
import { useLifiPerpsSetup } from "@/hooks/useLifiPerpsSetup";
import { useLifiPerpOrder } from "@/hooks/useLifiPerpOrder";
import { useLivePrices } from "@/hooks/useLivePrices";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { fmtUsd } from "@/lib/data";
import { getPerpsClient, LIFI_PROVIDER_LABEL, type LifiPerpsProviderId } from "@/lib/integrations/lifiPerps";
import { setSharedOndoEnv, useSharedOndoEnv } from "@/hooks/useOndoEnv";

function humanizeAction(type: string): string {
  return type
    .toLowerCase()
    .split("_")
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

function fmtPx(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "-";
  return n >= 100 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n < 1 ? n.toFixed(4) : n.toFixed(2);
}

/**
 * Positions read + close for a ready LI.FI-backed venue. Reads are
 * direct-to-venue (`getPositions` bypasses LI.FI's backend — see
 * lifiPerps.ts); closing reuses `useLifiPerpOrder` with the position's own
 * exact size, same pattern as ExtendedConnectPanel/HyperliquidPanel.
 */
function LifiPositions({ provider }: { provider: LifiPerpsProviderId }) {
  const { address } = useAccount();
  const ondoEnv = useSharedOndoEnv();
  const client = useMemo(() => getPerpsClient(ondoEnv), [ondoEnv]);
  const { data: prices } = useLivePrices();
  const { status, result, error: execError, execute, reset } = useLifiPerpOrder(provider);
  const [closing, setClosing] = useState<{ symbol: string; qty: number; side: "long" | "short" } | null>(null);
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["lifi-positions", provider, ondoEnv, address],
    queryFn: () => getPositions(client.client, { provider, address: address! }),
    enabled: !!address,
    refetchInterval: 30_000,
  });

  useEffect(() => {
    if (status === "confirmed") queryClient.invalidateQueries({ queryKey: ["lifi-positions"] });
  }, [status, queryClient]);

  if (!address) return null;
  if (isLoading) return <p style={{ fontSize: 11, margin: "6px 0 0" }} className="text-muted">Reading positions…</p>;
  if (error) return <p style={{ fontSize: 11, margin: "6px 0 0", color: "var(--risk-warning)" }}>{error instanceof Error ? error.message : String(error)}</p>;
  const positions = data?.positions ?? [];
  if (positions.length === 0) return <p style={{ fontSize: 11, margin: "6px 0 0" }} className="text-muted">No open {LIFI_PROVIDER_LABEL[provider]} positions.</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: "var(--space-2)" }}>
      {positions.map((p, i) => {
        const pnl = Number(p.unrealizedPnl);
        const ok = pnl >= 0;
        const isShort = p.side === PositionSide.SHORT;
        return (
          <div key={i} style={{ border: "1px solid var(--color-divider)", borderRadius: "var(--radius-sm)", padding: "6px 8px", fontSize: 11, display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontWeight: 600, fontFamily: "var(--font-heading)" }}>
                {p.market.baseAsset.displaySymbol} {isShort ? "SHORT" : "LONG"}
              </span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{Math.abs(Number(p.size)).toFixed(4)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }} className="text-muted">
              <span>Entry {fmtPx(Number(p.entryPrice))} · liq {fmtPx(Number(p.liquidationPrice))} · {p.leverage}x</span>
              <span style={{ color: ok ? "var(--risk-good)" : "var(--risk-serious)", fontVariantNumeric: "tabular-nums" }}>
                {ok ? "+" : ""}
                {fmtUsd(pnl)}
              </span>
            </div>
            <button
              className="btn btn-secondary"
              style={{ fontSize: 10, padding: "2px 8px", alignSelf: "flex-end" }}
              onClick={() => setClosing({ symbol: p.market.baseAsset.displaySymbol, qty: Math.abs(Number(p.size)), side: isShort ? "short" : "long" })}
            >
              Close
            </button>
          </div>
        );
      })}

      {status !== "idle" && (
        <p style={{ fontSize: 11 }}>
          {status === "submitting"
            ? "Closing…"
            : status === "confirmed" && result
              ? `Close submitted: ${JSON.stringify(result.results)}`
              : `Error: ${execError ?? "failed"}`}
          <button onClick={reset} style={{ marginLeft: 6, background: "none", border: "none", cursor: "pointer", color: "var(--color-neutral-500)", fontSize: 10 }}>
            clear
          </button>
        </p>
      )}

      <ConfirmDialog
        open={!!closing}
        title={closing ? `Close ${closing.symbol}` : "Close position"}
        body={closing ? <div>Reduce-only market order to close {closing.qty.toFixed(4)} {closing.symbol} ({closing.side}) on {LIFI_PROVIDER_LABEL[provider]}.</div> : null}
        confirmLabel="Sign & close"
        warning={provider === "ondo" && ondoEnv === "sandbox" ? "SANDBOX — no real funds." : "Real funds. Confirm carefully."}
        onConfirm={() => {
          if (closing) {
            execute({
              symbol: closing.symbol,
              isBuy: closing.side === "short",
              sizeUsd: 0,
              qtyOverride: closing.qty,
              reduceOnly: true,
              prices,
            });
          }
          setClosing(null);
        }}
        onCancel={() => setClosing(null)}
      />
    </div>
  );
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
  const ondoEnv = useSharedOndoEnv();
  const setup = useLifiPerpsSetup(provider);
  const [amount, setAmount] = useState("");

  return (
    <>
      <div className="hr" style={{ margin: "var(--space-3) 0" }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h6 style={{ color: "var(--color-accent)", margin: 0 }}>{label}</h6>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {provider === "ondo" && (
            <>
              <span className="text-muted" style={{ fontSize: 10 }}>
                {ondoEnv}
              </span>
              <button
                className="btn btn-secondary"
                style={{ fontSize: 10, padding: "2px 8px" }}
                onClick={() => setSharedOndoEnv(ondoEnv === "sandbox" ? "production" : "sandbox")}
              >
                switch
              </button>
            </>
          )}
          {setup.isReady && (
            <span className="tag tag-neutral" style={{ fontSize: 10 }}>
              ready
            </span>
          )}
        </div>
      </div>

      {provider === "lighter" && (
        <p style={{ fontSize: 10, margin: "4px 0 0", color: "var(--risk-warning)" }}>
          Mainnet only — Lighter has no testnet in this integration. Every order here is real funds.
        </p>
      )}
      {provider === "ondo" && ondoEnv === "sandbox" && (
        <p style={{ fontSize: 10, margin: "4px 0 0" }} className="text-muted">
          Sandbox — no real funds. Switch to production once you&apos;ve verified the flow.
        </p>
      )}
      {provider === "ondo" && ondoEnv === "production" && (
        <p style={{ fontSize: 10, margin: "4px 0 0", color: "var(--risk-warning)" }}>
          Production — real funds. Sandbox and production use separate Ondo sessions.
        </p>
      )}

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
        <>
          <p style={{ fontSize: 11, margin: "6px 0 0" }} className="text-muted">
            Connected and funded. Perp legs routed to {label} will sign and submit live.
          </p>
          <LifiPositions provider={provider} />
        </>
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
