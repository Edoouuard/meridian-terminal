"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TradeLeg } from "@/lib/tradePlan";
import type { Order } from "@/lib/execution";
import { useExtendedAccount } from "@/hooks/useExtendedAccount";
import {
  EXTENDED_DEPOSIT_CHAIN_ID,
  EXTENDED_DEPOSIT_TOKEN,
  EXTENDED_MIN_DEPOSIT_USD,
  RHINO_ARBITRUM_BRIDGE,
  commitQuote,
  commitmentIdFromQuote,
  depositForTx,
  fetchArbitrumBridge,
  fetchRecentDeposits,
  quoteArbitrumDeposit,
  usdcUnits,
  type BridgeQuote,
} from "@/lib/integrations/extendedBridge";
import { ValidatedExecuteButton } from "@/components/ValidatedExecuteButton";
import { NotWired, OrderRow } from "@/components/thread/shared";

const muted = { margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)" } as const;
const fmt = (x: number) => `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Deposit USDC from Arbitrum into the connected Extended account
 * (integrations/extendedBridge.ts): quote, commit, then one approval (if
 * needed) and the bridge deposit, both through the validated execution path.
 * After it confirms, the step follows the deposit until Extended credits it.
 */
export function ExtendedDepositButton({ leg }: { leg: TradeLeg }) {
  const signer = useExtendedAccount();
  const [quote, setQuote] = useState<BridgeQuote | null>(null);
  const [committed, setCommitted] = useState(false);
  const [busy, setBusy] = useState<"quote" | "commit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);

  const deposit = useQuery({
    queryKey: ["extended-deposit", signer?.network, txHash],
    queryFn: async () => (signer && txHash ? (depositForTx(await fetchRecentDeposits(signer), txHash) ?? null) : null),
    enabled: !!signer && !!txHash,
    refetchInterval: (q) => (q.state.data?.status === "COMPLETED" || q.state.data?.status === "REJECTED" ? false : 10_000),
  });

  if (!signer) {
    return <NotWired venue="Extended" reason="Connect Extended in Tools → Extended (three wallet signatures, no gas) before depositing to it." />;
  }
  if (signer.network !== "mainnet") {
    return <p style={muted}>Extended testnet funds come from its Claim button (Account section on testnet.extended.exchange), not from a deposit.</p>;
  }
  const amount = Math.floor((leg.sizeUsd ?? 0) * 100) / 100;
  if (!(amount >= EXTENDED_MIN_DEPOSIT_USD)) {
    return <p style={muted}>Deposits to Extended start at {fmt(EXTENDED_MIN_DEPOSIT_USD)}; below that the bridge fee takes most of it.</p>;
  }

  if (txHash) {
    const d = deposit.data;
    const text =
      d?.status === "COMPLETED"
        ? `Credited on Extended: ${fmt(d.amountUsd)} USDC. The Extended steps below can run now.`
        : d?.status === "REJECTED"
          ? "Extended reports this deposit as rejected. Contact Extended support with the transaction hash."
          : d
            ? "Extended has seen the deposit; the bridge is crediting it (usually a few minutes)."
            : "Deposit sent. Waiting for Extended to see it on the bridge (usually a few minutes); this checks every 10 seconds.";
    return <p style={{ ...muted, color: d?.status === "REJECTED" ? "var(--risk-bad, #c0392b)" : d?.status === "COMPLETED" ? "var(--color-accent-700)" : muted.color }}>{text}</p>;
  }

  async function getQuote() {
    if (!signer) return;
    setBusy("quote");
    setError(null);
    try {
      await fetchArbitrumBridge(signer);
      setQuote(await quoteArbitrumDeposit(signer, amount));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    if (!signer || !quote) return;
    setBusy("commit");
    setError(null);
    try {
      await commitQuote(signer, quote.id);
      setCommitted(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const rows = (
    <>
      <OrderRow label="From" value={`${fmt(amount)} native USDC on Arbitrum`} />
      {quote && <OrderRow label="Bridge fee (Rhino.fi)" value={`${fmt(quote.feeUsd)} · about ${fmt(Math.max(0, quote.amountUsd - quote.feeUsd))} credited on Extended`} />}
    </>
  );
  const errorLine = error && <p style={{ ...muted, color: "var(--risk-bad, #c0392b)" }}>{error}</p>;

  if (!quote) {
    return (
      <>
        {rows}
        <button type="button" className="btn btn-primary" style={{ marginTop: 6 }} disabled={busy !== null} onClick={() => void getQuote()}>
          {busy === "quote" ? "Getting a bridge quote…" : "Get the bridge quote"}
        </button>
        {errorLine}
      </>
    );
  }
  if (!committed) {
    return (
      <>
        {rows}
        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
          <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void commit()}>
            {busy === "commit" ? "Locking the quote…" : `Accept the ${fmt(quote.feeUsd)} fee`}
          </button>
          <button type="button" className="btn" disabled={busy !== null} onClick={() => setQuote(null)}>
            New quote
          </button>
        </div>
        {errorLine}
      </>
    );
  }

  const order: Order = {
    type: "supply",
    protocol: "extended",
    symbol: "USDC",
    token: EXTENDED_DEPOSIT_TOKEN,
    amount: usdcUnits(quote.amountUsd),
    decimals: 6,
    chainId: EXTENDED_DEPOSIT_CHAIN_ID,
    // Checked again by buildExecution against the verified bridge.
    to: RHINO_ARBITRUM_BRIDGE,
    commitmentId: commitmentIdFromQuote(quote.id),
  };
  return (
    <>
      {rows}
      <ValidatedExecuteButton order={order} label={`Deposit ${fmt(quote.amountUsd)} to Extended`} onConfirmed={setTxHash} />
    </>
  );
}
