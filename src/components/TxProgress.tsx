"use client";

import { useEffect, useState } from "react";
import { CHAIN_LABEL } from "@/lib/onchain";
import { explorerUrlFor } from "@/lib/explorer";
import type { OrderFlowState } from "@/lib/executionPlan";

/** Typical time for a transaction to be included, per chain (seconds): what "normal" looks like. */
const TYPICAL_SECONDS: Record<number, [number, number]> = {
  1: [15, 60],
  8453: [2, 10],
  42161: [1, 8],
  10: [2, 10],
  137: [3, 20],
  43114: [2, 10],
  56: [3, 15],
  999: [2, 10],
};

/** Past this many seconds, the wait is longer than usual and the user gets a hint. */
export function slowAfterSeconds(chainId: number): number {
  return (TYPICAL_SECONDS[chainId]?.[1] ?? 30) * 2;
}

export function typicalWait(chainId: number): string {
  const t = TYPICAL_SECONDS[chainId];
  if (!t) return "usually under a minute";
  return t[1] >= 60 ? `usually ${t[0]} s to ${t[1] / 60} min` : `usually ${t[0]}–${t[1]} s`;
}

export function fmtElapsed(s: number): string {
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

type Phase = "wallet" | "chain";

function phaseOf(state: OrderFlowState): Phase | null {
  if (state === "APPROVAL_PENDING" || state === "SUPPLY_PENDING") return "wallet";
  if (state === "APPROVAL_CONFIRMED" || state === "CONFIRMING") return "chain";
  return null;
}

/**
 * What the user sees while a transaction is in flight: where it is (sign in
 * the wallet / waiting for a block), how long it has been, how long it
 * usually takes on this chain, and the explorer link as soon as there is a
 * hash. A wait that runs past twice the usual time says what to do instead
 * of leaving the user to wonder whether something broke.
 */
export function TxProgress({
  state,
  chainId,
  needsApproval,
  approvalHash,
  mainHash,
}: {
  state: OrderFlowState;
  chainId: number;
  needsApproval: boolean | null;
  approvalHash?: `0x${string}`;
  mainHash?: `0x${string}`;
}) {
  const phase = phaseOf(state);
  // The parent keys this component by state, so the clock restarts at each step.
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!phase) return null;
  const elapsed = Math.max(0, Math.round((now - startedAt) / 1000));
  const chain = CHAIN_LABEL[chainId] ?? `chain ${chainId}`;
  const hash = state === "CONFIRMING" ? mainHash : state === "APPROVAL_CONFIRMED" ? approvalHash : undefined;
  const slow = phase === "chain" && elapsed > slowAfterSeconds(chainId);

  const steps: { label: string; done: boolean; active: boolean }[] = [];
  if (needsApproval) {
    const approvalDone = state !== "APPROVAL_PENDING";
    steps.push({ label: "Approve", done: approvalDone, active: state === "APPROVAL_PENDING" });
  }
  steps.push({ label: "Sign", done: state === "CONFIRMING", active: state === "SUPPLY_PENDING" || state === "APPROVAL_CONFIRMED" });
  steps.push({ label: "Confirmed on-chain", done: false, active: state === "CONFIRMING" });

  return (
    <div className={`txp${slow ? " txp--slow" : ""}`} role="status" aria-live="polite">
      <ol className="txp__steps">
        {steps.map((s, i) => (
          <li key={i} className={s.done ? "is-done" : s.active ? "is-active" : undefined}>
            <span className="txp__dot" aria-hidden="true">{s.done ? "✓" : i + 1}</span>
            {s.label}
          </li>
        ))}
      </ol>
      <div className="txp__main">
        <span className="txp__spinner" aria-hidden="true" />
        <div>
          {phase === "wallet" ? (
            <>
              <strong>Confirm in your wallet</strong>
              <span>A signature request is waiting in your wallet. Nothing moves until you approve it.</span>
            </>
          ) : state === "APPROVAL_CONFIRMED" ? (
            <>
              <strong>Approval confirmed — preparing the transaction</strong>
              <span>The next signature request opens in a moment.</span>
            </>
          ) : (
            <>
              <strong>
                Waiting for {chain} · {fmtElapsed(elapsed)}
              </strong>
              <span>
                Sent and being processed — {typicalWait(chainId)} on {chain}. Your funds are safe meanwhile; you can keep using Meridian.
              </span>
            </>
          )}
        </div>
      </div>
      {slow && (
        <p className="txp__hint">
          Taking longer than usual, usually because the network is busy. It will go through on its own; to speed it up, use “Speed up” in your wallet.
        </p>
      )}
      {(hash || (state === "CONFIRMING" && approvalHash)) && (
        <div className="txp__links">
          {approvalHash && (
            <a href={explorerUrlFor(chainId, approvalHash)} target="_blank" rel="noreferrer">
              approval ↗
            </a>
          )}
          {hash && hash !== approvalHash && (
            <a href={explorerUrlFor(chainId, hash)} target="_blank" rel="noreferrer">
              follow it on the explorer ↗
            </a>
          )}
        </div>
      )}
    </div>
  );
}
