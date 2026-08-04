"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { useHyperliquid } from "@/hooks/useHyperliquid";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { fmtUsd } from "@/lib/data";
import { setSharedHlAccount, useSharedHlAccount } from "@/hooks/useLivePortfolio";
import {
  fetchClearinghouseState,
  fetchOpenOrders,
  hyperliquidEnv,
  type HlOpenOrder,
} from "@/lib/integrations/hyperliquid-live";

function fmtPx(n: number): string {
  if (n === 0) return "-";
  return n >= 100 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n < 1 ? n.toFixed(4) : n.toFixed(2);
}

/**
 * Hyperliquid account panel — reads the connected wallet's Hyperliquid account
 * (account value, positions, unrealised PnL) and lets the user CLOSE a position
 * (a signed reduce-only market order). TESTNET by default; nothing auto-runs.
 */
export function HyperliquidPanel() {
  const { address, isConnected } = useAccount();
  const [env, setEnv] = useState<"testnet" | "mainnet">("testnet");
  const account = useSharedHlAccount();
  const [orders, setOrders] = useState<HlOpenOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { status, result, error: hlErr, execute, reset } = useHyperliquid();
  const [closing, setClosing] = useState<{ coin: string; size: number } | null>(null);

  const refresh = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);
    try {
      const e = hyperliquidEnv(env === "testnet");
      const [acc, ord] = await Promise.all([
        fetchClearinghouseState(address, e),
        fetchOpenOrders(address, e),
      ]);
      // Push into the shared store so the portfolio and this panel agree.
      setSharedHlAccount(acc);
      setOrders(ord);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [address, env]);

  useEffect(() => {
    if (isConnected && address) {
      const id = setTimeout(() => refresh(), 0);
      return () => clearTimeout(id);
    }
  }, [isConnected, address, refresh]);

  if (!isConnected || !address) {
    return (
      <p style={{ fontSize: 11 }} className="text-muted">
        Connect a wallet to view your Hyperliquid positions.
      </p>
    );
  }

  const closeOne = (p: { coin: string; size: number }) => {
    // closing: if long (size>0) reduce by selling; if short (size<0) reduce by buying
    const isBuy = p.size < 0;
    execute({ symbol: p.coin, isBuy, sizeUsd: 0, coinQty: Math.abs(p.size), reduceOnly: true, leverage: 1, testnet: env === "testnet" });
  };

  return (
    <>
      <div className="hr" style={{ margin: "var(--space-3) 0" }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h6 style={{ color: "var(--color-accent)", margin: 0 }}>Hyperliquid</h6>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <span className="text-muted" style={{ fontSize: 10 }}>
            {env === "testnet" ? "testnet" : "mainnet"}
          </span>
          <button
            className="btn btn-secondary"
            style={{ fontSize: 10, padding: "2px 8px" }}
            onClick={() => setEnv((e) => (e === "testnet" ? "mainnet" : "testnet"))}
          >
            {env === "testnet" ? "switch" : "switch"}
          </button>
          <button className="btn btn-secondary" style={{ fontSize: 10, padding: "2px 8px" }} onClick={refresh}>
            refresh
          </button>
        </div>
      </div>

      {loading && (
        <p style={{ fontSize: 11, margin: "6px 0 0" }} className="text-muted">
          Reading Hyperliquid state…
        </p>
      )}
      {error && (
        <p style={{ fontSize: 11, margin: "6px 0 0", color: "var(--risk-warning)" }}>{error}</p>
      )}

      {account && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: "var(--space-2)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
            <span className="text-muted">Account value</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmtUsd(account.accountValue)}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
            <span className="text-muted">Margin used</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmtUsd(account.totalMarginUsed)}</span>
          </div>

          {account.positions.length === 0 && (
            <p style={{ fontSize: 11, margin: "4px 0 0" }} className="text-muted">
              No open positions on {env === "testnet" ? "Hyperliquid testnet" : "Hyperliquid"}.
            </p>
          )}

          {account.positions.map((p) => {
            const ok = p.unrealizedPnl >= 0;
            return (
              <div
                key={p.coin}
                style={{
                  border: "1px solid var(--color-divider)",
                  borderRadius: "var(--radius-sm)",
                  padding: "6px 8px",
                  fontSize: 11,
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontWeight: 600, fontFamily: "var(--font-heading)" }}>
                    {p.coin} {p.size > 0 ? "LONG" : "SHORT"}
                  </span>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>{Math.abs(p.size).toFixed(4)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }} className="text-muted">
                  <span>Entry {fmtPx(p.entryPx)} · {p.leverage}x</span>
                  <span style={{ color: ok ? "var(--risk-good)" : "var(--risk-serious)", fontVariantNumeric: "tabular-nums" }}>
                    {ok ? "+" : ""}
                    {fmtUsd(p.unrealizedPnl)}
                  </span>
                </div>
                <button
                  className="btn btn-secondary"
                  style={{ fontSize: 10, padding: "2px 8px", alignSelf: "flex-end" }}
                  onClick={() => setClosing({ coin: p.coin, size: p.size })}
                >
                  Close
                </button>
              </div>
            );
          })}

          {orders.length > 0 && (
            <p style={{ fontSize: 10, margin: "4px 0 0" }} className="text-muted">
              {orders.length} open order{orders.length > 1 ? "s" : ""}
            </p>
          )}
        </div>
      )}

      {status !== "idle" && (
        <p style={{ fontSize: 11, marginTop: 6 }}>
          {status === "preparing" || status === "signing" || status === "submitting"
            ? `${status === "signing" ? "Awaiting wallet signature…" : "Working…"}`
            : status === "confirmed" && result
              ? `Close order submitted: ${JSON.stringify(result.response)}`
              : `Error: ${hlErr ?? "failed"}`}
          <button onClick={reset} style={{ marginLeft: 6, background: "none", border: "none", cursor: "pointer", color: "var(--color-neutral-500)", fontSize: 10 }}>
            clear
          </button>
        </p>
      )}

      <ConfirmDialog
        open={!!closing}
        title={closing ? `Close ${closing.coin}` : "Close position"}
        body={
          closing ? (
            <div>
              Reduce-only market order to close {Math.abs(closing.size).toFixed(4)} {closing.coin}{" "}
              ({closing.size > 0 ? "long" : "short"}) on Hyperliquid {env}.
            </div>
          ) : null
        }
        confirmLabel="Sign & close"
        warning={env === "testnet" ? "TESTNET — no real funds." : "Mainnet — real funds. Confirm carefully."}
        onConfirm={() => {
          if (closing) closeOne(closing);
          setClosing(null);
        }}
        onCancel={() => setClosing(null)}
      />
    </>
  );
}
