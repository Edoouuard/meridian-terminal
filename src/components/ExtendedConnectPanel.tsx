"use client";

import { useState } from "react";
import type { Network as ExtendedNetwork } from "@blackcube/extended-sdk";
import { ExtendedKeyError, connectExtendedAccount, disconnectExtendedAccount, useExtendedAccount } from "@/hooks/useExtendedAccount";

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
    </>
  );
}
