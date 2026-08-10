"use client";

import { useState } from "react";
import { useSolana } from "@/hooks/useSolana";
import { SOL_SPL_MINTS } from "@/lib/solana";

function fmtSol(n: number): string {
  if (n === 0) return "0";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return n.toFixed(6);
}

/**
 * Solana read panel — enter any Solana public key (base58) to read its real
 * on-chain balances (native SOL + curated top SPL tokens) from the public
 * mainnet RPC. READ-ONLY: no wallet adapter, no signing, no funds at risk.
 * Auto-refreshes every 60s while a valid key is present.
 */
export function SolanaPanel() {
  const [input, setInput] = useState("");
  const [pubkey, setPubkey] = useState<string | null>(null);
  const { loading, balances, error, refresh } = useSolana(pubkey);

  const submit = () => {
    const trimmed = input.trim();
    setPubkey(trimmed || null);
  };

  return (
    <>
      <div className="hr" style={{ margin: "var(--space-3) 0" }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h6 style={{ color: "var(--color-accent)", margin: 0 }}>Solana</h6>
        {pubkey && (
          <button
            className="btn btn-secondary"
            style={{ fontSize: 10, padding: "2px 8px" }}
            onClick={refresh}
            disabled={loading}
          >
            {loading ? "reading…" : "refresh"}
          </button>
        )}
      </div>

      <div style={{ display: "flex", gap: 6, marginTop: "var(--space-2)" }}>
        <input
          className="input"
          style={{ fontSize: 12, minHeight: 30 }}
          placeholder="Solana public key (base58)…"
          value={input}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button className="btn btn-secondary" style={{ fontSize: 11, padding: "2px 10px" }} onClick={submit}>
          Read
        </button>
      </div>

      {!pubkey && (
        <p style={{ fontSize: 11, margin: "6px 0 0" }} className="text-muted">
          Enter any public key to read SOL + SPL balances from the public mainnet RPC.
        </p>
      )}

      {loading && pubkey && (
        <p style={{ fontSize: 11, margin: "6px 0 0" }} className="text-muted">
          Reading Solana balances…
        </p>
      )}

      {error && (
        <p style={{ fontSize: 11, margin: "6px 0 0", color: "var(--risk-warning)" }}>{error}</p>
      )}

      {pubkey && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: "var(--space-2)" }}>
          <div
            className="card"
            style={{ gap: 2, padding: "var(--space-2)", fontSize: 12 }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontWeight: 600, fontFamily: "var(--font-heading)" }}>SOL</span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmtSol(balances.sol)}</span>
            </div>
          </div>

          {balances.spl.length === 0 && !loading && (
            <p style={{ fontSize: 11, margin: "2px 0 0" }} className="text-muted">
              No curated SPL token balances.
            </p>
          )}

          {balances.spl.map((b) => (
            <div
              key={b.mint}
              className="card"
              style={{ gap: 2, padding: "var(--space-2)", fontSize: 12 }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontWeight: 600, fontFamily: "var(--font-heading)" }}>{b.symbol}</span>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>{b.amountFormatted}</span>
              </div>
            </div>
          ))}

          {pubkey && !loading && (
            <p style={{ fontSize: 9, margin: "2px 0 0", wordBreak: "break-all" }} className="text-muted">
              {pubkey}
            </p>
          )}
        </div>
      )}

      {!pubkey && Object.keys(SOL_SPL_MINTS).length > 0 && (
        <p style={{ fontSize: 9, margin: "6px 0 0" }} className="text-muted">
          Tracks SOL + {Object.keys(SOL_SPL_MINTS).length} SPL tokens · public RPC
        </p>
      )}
    </>
  );
}