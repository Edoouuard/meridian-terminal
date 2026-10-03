"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Network as ExtendedNetwork } from "@blackcube/extended-sdk";
import { ExtendedKeyError, connectExtendedAccount, disconnectExtendedAccount, useExtendedAccount } from "@/hooks/useExtendedAccount";
import { fetchExtendedPositions } from "@/lib/integrations/extended-live";
import { useExtendedPerp } from "@/hooks/useExtendedPerp";
import { useLivePrices } from "@/hooks/useLivePrices";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { fmtUsd } from "@/lib/data";

function fmtPx(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "-";
  return n >= 100 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n < 1 ? n.toFixed(4) : n.toFixed(2);
}

/** Positions read + close for the connected Extended account. Direct-to-venue read, same as every other position list in this app. */
function ExtendedPositions() {
  const signer = useExtendedAccount();
  const { data: prices } = useLivePrices();
  const { status, result, error: execError, execute, reset } = useExtendedPerp();
  const [closing, setClosing] = useState<{ symbol: string; qty: number; side: "long" | "short" } | null>(null);
  const queryClient = useQueryClient();

  const { data: positions, isLoading, error } = useQuery({
    queryKey: ["extended-positions", signer?.apiKey, signer?.network],
    queryFn: () => fetchExtendedPositions(signer!),
    enabled: !!signer,
    refetchInterval: 30_000,
  });

  useEffect(() => {
    if (status === "confirmed") queryClient.invalidateQueries({ queryKey: ["extended-positions"] });
  }, [status, queryClient]);

  if (!signer) return null;
  if (isLoading) return <p style={{ fontSize: 11, margin: "6px 0 0" }} className="text-muted">Reading positions…</p>;
  if (error) return <p style={{ fontSize: 11, margin: "6px 0 0", color: "var(--risk-warning)" }}>{error instanceof Error ? error.message : String(error)}</p>;
  const open = (positions ?? []).filter((p) => p.side && Number(p.size) !== 0);
  if (open.length === 0) return <p style={{ fontSize: 11, margin: "6px 0 0" }} className="text-muted">No open Extended positions.</p>;

  const closeOne = (p: { name: string; side: string | null; size: string }) => {
    const symbol = p.name.replace(/-USD$/i, "");
    const qty = Math.abs(Number(p.size));
    setClosing({ symbol, qty, side: p.side === "short" ? "short" : "long" });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: "var(--space-2)" }}>
      {open.map((p, i) => {
        const pnl = Number(p.unrealizedPnl);
        const ok = pnl >= 0;
        return (
          <div key={i} style={{ border: "1px solid var(--color-divider)", borderRadius: "var(--radius-sm)", padding: "6px 8px", fontSize: 11, display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontWeight: 600, fontFamily: "var(--font-heading)" }}>
                {p.name.replace(/-USD$/i, "")} {p.side === "short" ? "SHORT" : "LONG"}
              </span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{Math.abs(Number(p.size)).toFixed(4)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }} className="text-muted">
              <span>Entry {fmtPx(Number(p.entryPrice))} · liq {fmtPx(Number(p.liquidationPrice))} · {p.leverage ?? 1}x</span>
              <span style={{ color: ok ? "var(--risk-good)" : "var(--risk-serious)", fontVariantNumeric: "tabular-nums" }}>
                {ok ? "+" : ""}
                {fmtUsd(pnl)}
              </span>
            </div>
            <button className="btn btn-secondary" style={{ fontSize: 10, padding: "2px 8px", alignSelf: "flex-end" }} onClick={() => closeOne(p)}>
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
              ? `Close submitted: ${JSON.stringify(result.order)}`
              : `Error: ${execError ?? "failed"}`}
          <button onClick={reset} style={{ marginLeft: 6, background: "none", border: "none", cursor: "pointer", color: "var(--color-neutral-500)", fontSize: 10 }}>
            clear
          </button>
        </p>
      )}

      <ConfirmDialog
        open={!!closing}
        title={closing ? `Close ${closing.symbol}` : "Close position"}
        body={closing ? <div>Reduce-only IOC order to close {closing.qty.toFixed(4)} {closing.symbol} ({closing.side}) on Extended {signer.network}.</div> : null}
        confirmLabel="Sign & close"
        warning={signer.network === "testnet" ? "TESTNET — no real funds." : "Mainnet — real funds. Confirm carefully."}
        onConfirm={() => {
          if (closing) {
            execute({
              signer,
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
 * Extended (ex-X10) account panel. Extended is a StarkEx venue: there is no
 * "connect your wallet and go" flow like Hyperliquid, because order signing
 * needs a Stark-curve keypair a browser wallet cannot produce. So this panel
 * asks for the three things Extended's own dashboard already hands the user
 * for API/bot access (API key, Stark private key, vault id) instead of
 * pretending a wallet connection is enough.
 */
export function ExtendedConnectPanel() {
  const signer = useExtendedAccount();
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [l2PrivateKey, setL2PrivateKey] = useState("");
  const [vaultId, setVaultId] = useState("");
  const [network, setNetwork] = useState<ExtendedNetwork>("testnet");
  const [error, setError] = useState<string | null>(null);

  const connect = () => {
    setError(null);
    try {
      connectExtendedAccount({ apiKey, l2PrivateKey, vaultId, network });
      setApiKey("");
      setL2PrivateKey("");
      setVaultId("");
      setOpen(false);
    } catch (err) {
      setError(err instanceof ExtendedKeyError ? err.message : err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <div className="hr" style={{ margin: "var(--space-3) 0" }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h6 style={{ color: "var(--color-accent)", margin: 0 }}>Extended</h6>
        {signer ? (
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <span className="text-muted" style={{ fontSize: 10 }}>
              {signer.network}
            </span>
            <button
              className="btn btn-secondary"
              style={{ fontSize: 10, padding: "2px 8px" }}
              onClick={() => disconnectExtendedAccount()}
            >
              disconnect
            </button>
          </div>
        ) : (
          <button className="btn btn-secondary" style={{ fontSize: 10, padding: "2px 8px" }} onClick={() => setOpen((v) => !v)}>
            {open ? "cancel" : "connect"}
          </button>
        )}
      </div>

      {signer && (
        <p style={{ fontSize: 11, margin: "6px 0 0" }} className="text-muted">
          Connected · vault {signer.vaultId} · {signer.network}. Beta-neutral shorts and directional perps routed to
          Extended will sign and submit live.
        </p>
      )}

      {!signer && !open && (
        <p style={{ fontSize: 11, margin: "6px 0 0" }} className="text-muted">
          Not connected. Extended perp legs stay in preview until you connect an Extended account.
        </p>
      )}

      {!signer && open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: "var(--space-2)" }}>
          <p style={{ fontSize: 11, margin: 0 }} className="text-muted">
            From extended.exchange → API management: paste your API key, Stark private key, and vault (position) id.
            These stay only in this browser — Meridian has no server that sees them. The Stark key can also authorize
            withdrawals on Extended&apos;s side, so only paste one you&apos;re comfortable automating.
          </p>
          <input
            className="input"
            style={{ fontSize: 12 }}
            placeholder="API key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <input
            className="input"
            style={{ fontSize: 12 }}
            placeholder="Stark private key (0x…)"
            type="password"
            value={l2PrivateKey}
            onChange={(e) => setL2PrivateKey(e.target.value)}
          />
          <input
            className="input"
            style={{ fontSize: 12 }}
            placeholder="Vault / position id"
            value={vaultId}
            onChange={(e) => setVaultId(e.target.value)}
          />
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <label style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
              <input type="radio" checked={network === "testnet"} onChange={() => setNetwork("testnet")} /> testnet
            </label>
            <label style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
              <input type="radio" checked={network === "mainnet"} onChange={() => setNetwork("mainnet")} /> mainnet
            </label>
          </div>
          {error && <p style={{ fontSize: 11, margin: 0, color: "var(--risk-bad, #c0392b)" }}>{error}</p>}
          <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={connect}>
            Connect
          </button>
        </div>
      )}

      <ExtendedPositions />
    </>
  );
}
