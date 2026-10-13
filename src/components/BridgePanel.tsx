"use client";

import { useState } from "react";
import { parseUnits } from "viem";
import { useAccount, useSwitchChain } from "wagmi";
import { ValidatedExecuteButton } from "@/components/ValidatedExecuteButton";
import { explorerUrlFor } from "@/lib/explorer";
import { useBridge, USDC_BY_CHAIN } from "@/hooks/useBridge";
import { CHAIN_LABEL } from "@/lib/onchain";
import { formatBaseUnits } from "@/lib/quote";
import { isRoutingSupportedChain } from "@/lib/mcp/routerAllowlist";

/** Chains with a verified router entrypoint (routerAllowlist) and native USDC. */
const BRIDGE_CHAINS = Object.keys(USDC_BY_CHAIN)
  .map(Number)
  .filter((id) => isRoutingSupportedChain(id));

const USDC_DECIMALS = 6;

const DELIVERY_LABEL: Record<string, string> = {
  None: "waiting to be indexed",
  Created: "order created — waiting for a solver",
  PENDING: "in flight",
  NOT_FOUND: "waiting to be indexed",
};

/**
 * BridgePanel — move USDC between chains through Meridian's routing layer
 * (deBridge + LI.FI quoted and compared server-side). Quoting and delivery
 * tracking come from `useBridge`; the signature goes through
 * `ValidatedExecuteButton`, the same validated flow as every other order
 * (allowlisted entrypoint, exact-amount approval, simulation first).
 */
export function BridgePanel() {
  const { isConnected, chainId: walletChainId } = useAccount();
  const { switchChain, isPending: switching } = useSwitchChain();
  const bridge = useBridge();
  const [fromChainId, setFromChainId] = useState(BRIDGE_CHAINS.includes(42161) ? 42161 : BRIDGE_CHAINS[0]);
  const [toChainId, setToChainId] = useState(BRIDGE_CHAINS.includes(8453) ? 8453 : BRIDGE_CHAINS[1]);
  const [amount, setAmount] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);

  if (!isConnected) return null;

  const onQuote = () => {
    setInputError(null);
    if (fromChainId === toChainId) {
      setInputError("Pick two different chains.");
      return;
    }
    let base: bigint;
    try {
      base = parseUnits(amount.trim() || "0", USDC_DECIMALS);
    } catch {
      setInputError("Enter a valid amount.");
      return;
    }
    if (base <= BigInt(0)) {
      setInputError("Enter an amount above 0.");
      return;
    }
    void bridge.fetchQuote({
      fromChainId,
      toChainId,
      fromToken: USDC_BY_CHAIN[fromChainId],
      toToken: USDC_BY_CHAIN[toChainId],
      fromAmount: base.toString(),
      symbol: "USDC",
      decimals: USDC_DECIMALS,
    });
  };

  const chainSelect = (value: number, onChange: (id: number) => void, label: string) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, fontSize: 10 }}>
      <span className="text-muted">{label}</span>
      <select
        value={value}
        onChange={(e) => {
          onChange(Number(e.target.value));
          bridge.reset();
        }}
        style={{ fontSize: 12, padding: "3px 4px" }}
      >
        {BRIDGE_CHAINS.map((id) => (
          <option key={id} value={id}>
            {CHAIN_LABEL[id] ?? id}
          </option>
        ))}
      </select>
    </label>
  );

  const { status, quote, order } = bridge;
  const wrongChain = order && walletChainId !== order.chainId;

  return (
    <>
      <div className="hr" style={{ margin: "var(--space-3) 0" }} />
      <h6 style={{ color: "var(--color-accent)", margin: 0 }}>Bridge USDC</h6>
      <p className="text-muted" style={{ fontSize: 10, margin: "2px 0 6px" }}>
        Best route across deBridge and LI.FI.
      </p>

      <div style={{ display: "flex", gap: 6 }}>
        {chainSelect(fromChainId, setFromChainId, "From")}
        {chainSelect(toChainId, setToChainId, "To")}
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "flex-end" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, fontSize: 10 }}>
          <span className="text-muted">Amount (USDC)</span>
          <input
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              if (status !== "idle") bridge.reset();
            }}
            style={{ fontSize: 12, padding: "3px 6px" }}
          />
        </label>
        <button
          className="btn btn-secondary"
          style={{ fontSize: 11, padding: "4px 10px" }}
          onClick={onQuote}
          disabled={status === "quoting" || status === "bridging"}
        >
          {status === "quoting" ? "Quoting…" : "Get route"}
        </button>
      </div>

      {inputError && <p style={{ fontSize: 11, margin: "6px 0 0", color: "var(--risk-warning)" }}>{inputError}</p>}
      {status === "error" && bridge.error && (
        <p style={{ fontSize: 11, margin: "6px 0 0", color: "var(--risk-warning)" }}>{bridge.error}</p>
      )}

      {quote && order && (
        <div
          style={{
            border: "1px solid var(--color-divider)",
            borderRadius: "var(--radius-sm)",
            padding: "6px 8px",
            marginTop: 8,
            fontSize: 11,
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontWeight: 600 }}>{quote.provider === "lifi" ? "LI.FI" : "deBridge"}</span>
            <span>
              receive ≈ {formatBaseUnits(BigInt(quote.toAmount || "0"), USDC_DECIMALS)} USDC on{" "}
              {CHAIN_LABEL[quote.toChainId] ?? quote.toChainId}
            </span>
          </div>
          <span className="text-muted">
            ~{Math.max(1, Math.round(quote.estimatedTimeSeconds / 60))} min{quote.reason ? ` · ${quote.reason}` : ""}
          </span>

          {status === "quoted" &&
            (wrongChain ? (
              <button
                className="btn btn-primary"
                style={{ fontSize: 12, marginTop: 4 }}
                disabled={switching}
                onClick={() => switchChain({ chainId: order.chainId as Parameters<typeof switchChain>[0]["chainId"] })}
              >
                {switching ? "Switching…" : `Switch wallet to ${CHAIN_LABEL[order.chainId] ?? order.chainId}`}
              </button>
            ) : (
              <ValidatedExecuteButton order={order} label="Bridge →" onConfirmed={bridge.onSourceConfirmed} />
            ))}

          {bridge.srcTxHash && (
            <a
              href={explorerUrlFor(order.chainId, bridge.srcTxHash)}
              target="_blank"
              rel="noreferrer"
              style={{ color: "inherit", textDecoration: "underline" }}
            >
              source tx {bridge.srcTxHash.slice(0, 10)}…
            </a>
          )}
          {status === "bridging" && (
            <span style={{ color: "var(--color-neutral-500)" }}>
              Delivery: {bridge.deliveryStatus ? DELIVERY_LABEL[bridge.deliveryStatus] ?? bridge.deliveryStatus : "checking…"}
            </span>
          )}
          {status === "delivered" && (
            <span style={{ color: "var(--risk-good)" }}>
              Delivered on {CHAIN_LABEL[quote.toChainId] ?? quote.toChainId}.
            </span>
          )}
          {status === "failed" && (
            <span style={{ color: "var(--risk-bad, #c0392b)" }}>
              The bridge reported a failure ({bridge.deliveryStatus}). Check the source transaction.
            </span>
          )}
          {(status === "delivered" || status === "failed") && (
            <button
              className="btn btn-secondary"
              style={{ fontSize: 10, padding: "2px 8px", alignSelf: "flex-end" }}
              onClick={bridge.reset}
            >
              New bridge
            </button>
          )}
        </div>
      )}
    </>
  );
}
