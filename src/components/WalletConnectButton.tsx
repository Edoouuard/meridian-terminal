"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";
import { injected } from "wagmi/connectors";

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletConnectButton() {
  const { address, isConnected } = useAccount();
  const { connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();

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

  return (
    <button
      className="btn btn-primary"
      style={{ fontSize: 13, padding: "5px 14px" }}
      disabled={isPending}
      onClick={() => connect({ connector: injected() })}
      title={error ? error.message : "Connect an injected wallet (MetaMask, Rabby, Coinbase Wallet, ...)"}
    >
      {isPending ? "Connecting…" : "Connect wallet"}
    </button>
  );
}
