"use client";

import { useState, useSyncExternalStore } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const noSubscribe = () => () => {};
const hasBrowserWallet = () => typeof window !== "undefined" && !!(window as { ethereum?: unknown }).ethereum;

/**
 * Connect with the browser wallet (extension, or a wallet app's in-app
 * browser), or with WalletConnect when it is configured (lib/wagmi.ts).
 * Problems show inline, never only in a tooltip.
 */
export function WalletConnectButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const [hint, setHint] = useState<string | null>(null);
  // Read after hydration only: the server can't see window.ethereum.
  const browserWallet = useSyncExternalStore(noSubscribe, hasBrowserWallet, () => false);

  if (isConnected && address) {
    return (
      <button
        className="tag tag-outline"
        style={{ fontVariantNumeric: "tabular-nums", cursor: "pointer", background: "none" }}
        onClick={() => disconnect()}
        title="Disconnect wallet"
      >
        {shortenAddress(address)}
      </button>
    );
  }

  const injectedConnector = connectors.find((c) => c.type === "injected");
  const wc = connectors.find((c) => c.type === "walletConnect");

  const onConnect = () => {
    setHint(null);
    if (hasBrowserWallet() && injectedConnector) return connect({ connector: injectedConnector });
    if (wc) return connect({ connector: wc });
    setHint("No wallet found in this browser. Install MetaMask or Rabby, or on a phone open this page from your wallet app's browser.");
  };

  const message = hint ?? (error ? (/rejected|denied/i.test(error.message) ? "Connection declined in the wallet." : error.message.split("\n")[0]) : null);

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
      <span style={{ display: "inline-flex", gap: 6 }}>
        <button className="btn btn-primary" style={{ fontSize: 13, padding: "5px 14px" }} disabled={isPending} onClick={onConnect}>
          {isPending ? "Connecting…" : "Connect wallet"}
        </button>
        {wc && browserWallet && (
          <button className="btn btn-secondary" style={{ fontSize: 12, padding: "5px 10px" }} disabled={isPending} onClick={() => connect({ connector: wc })} title="Connect a phone wallet with a QR code">
            Mobile wallet
          </button>
        )}
      </span>
      {message && (
        <span role="alert" style={{ fontSize: 11, color: "var(--risk-bad, #c0392b)", maxWidth: 280, textAlign: "right" }}>
          {message}
        </span>
      )}
    </span>
  );
}
