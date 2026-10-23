"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useSignTypedData } from "wagmi";
import type { Address } from "viem";
import type { TradeLeg } from "@/lib/tradePlan";
import { HL_WITHDRAW_FEE_USD } from "@/lib/integrations/hyperliquidExchange";
import { fetchWithdrawable, hyperliquidEnv, withdrawUsdcToArbitrum, withdrawableUsd, type WalletSign } from "@/lib/integrations/hyperliquidTrade";
import { useSharedHlEnv } from "@/hooks/useHyperliquidEnv";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { OrderRow } from "@/components/thread/shared";
import { recordExecution } from "@/lib/history";
import { humanizeMessage } from "@/lib/errorText";

const muted = { margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)" } as const;
const fmt = (x: number) => `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Withdraw USDC from the user's Hyperliquid account to their own address on
 * Arbitrum (lib/integrations/hyperliquidTrade.ts). Signed by the wallet (no
 * gas): one signature, two when USDC first has to move from spot to perps.
 * Hyperliquid takes a $1 fee; the USDC lands on Arbitrum in a few minutes,
 * where the next step (a bridge or a deposit) waits for it.
 */
export function HyperliquidWithdrawButton({ leg, onDone }: { leg: TradeLeg; onDone?: (ref: string) => void }) {
  const { address, isConnected, chainId } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const envName = useSharedHlEnv();
  const env = hyperliquidEnv(envName === "testnet");
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<{ status: "idle" | "moving" | "withdrawing" | "done" | "error"; amount?: number; error?: string }>({ status: "idle" });

  const balances = useQuery({
    queryKey: ["hl-withdrawable", envName, address],
    queryFn: () => fetchWithdrawable(env, address as Address),
    enabled: !!address,
    refetchInterval: 30_000,
  });

  if (!isConnected || !address || !chainId) return <p style={muted}>Connect a wallet to withdraw from Hyperliquid.</p>;
  if (balances.isLoading) return <p style={muted}>Reading your Hyperliquid balance…</p>;
  if (balances.isError || !balances.data) {
    return (
      <p style={{ ...muted, color: "var(--risk-bad, #c0392b)" }}>
        Couldn&apos;t read your Hyperliquid balance.{" "}
        <button onClick={() => void balances.refetch()} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-accent-700)", fontSize: 12, padding: 0 }}>
          Retry
        </button>
      </p>
    );
  }

  const held = withdrawableUsd(balances.data);
  const unified = balances.data.unified;
  const amount = Math.floor(Math.min(leg.sizeUsd ?? held, held) * 100) / 100;
  const arrives = Math.max(0, amount - HL_WITHDRAW_FEE_USD);
  const row = (
    <OrderRow
      label="On Hyperliquid"
      value={unified ? `${fmt(held)} USDC withdrawable (unified account)` : `${fmt(balances.data.perps)} withdrawable${balances.data.spotUsdc > 0.01 ? ` · ${fmt(balances.data.spotUsdc)} in spot` : ""}`}
    />
  );

  if (state.status === "moving" || state.status === "withdrawing") {
    return <>{row}<p style={muted}>{state.status === "moving" ? "Sign in your wallet: move USDC from spot to perps (no gas)…" : "Sign in your wallet: withdraw to Arbitrum (no gas)…"}</p></>;
  }
  if (state.status === "done") {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-accent-700)" }}>
        Withdrawal sent: about {fmt(Math.max(0, (state.amount ?? 0) - HL_WITHDRAW_FEE_USD))} USDC arrives at your address on Arbitrum in 3–5 minutes. The next step unlocks when it lands.
      </p>
    );
  }
  if (!(amount > HL_WITHDRAW_FEE_USD)) {
    return <>{row}<p style={muted}>Nothing to withdraw: a Hyperliquid withdrawal must exceed its {fmt(HL_WITHDRAW_FEE_USD)} fee.</p></>;
  }

  const walletSign: WalletSign = (typedData) => signTypedDataAsync(typedData as Parameters<typeof signTypedDataAsync>[0]);
  async function run() {
    setConfirming(false);
    try {
      const out = await withdrawUsdcToArbitrum({ user: address!, env, walletSign, walletChainId: chainId!, amount, onStep: (s) => setState({ status: s }) });
      if (!out.ok) {
        setState({ status: "error", error: out.error });
        return;
      }
      setState({ status: "done", amount: out.amount });
      onDone?.(`hyperliquid:USDC:${out.amount}@withdraw`);
      recordExecution({ type: "withdraw", label: "Withdraw USDC from Hyperliquid to Arbitrum", amount: String(out.amount), asset: "USDC", protocol: "Hyperliquid", status: "confirmed" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState({ status: "error", error: /user rejected|denied/i.test(msg) ? "Signature declined in the wallet." : msg.split("\n")[0] });
    }
  }

  return (
    <>
      {row}
      <OrderRow label="Withdraw" value={`${fmt(amount)} USDC → Arbitrum (≈ ${fmt(arrives)} after the ${fmt(HL_WITHDRAW_FEE_USD)} fee)`} valueColor="var(--color-accent-700)" />
      {state.status === "error" && <p style={{ margin: "4px 0 0", fontSize: 11, color: "var(--risk-bad, #c0392b)" }}>{humanizeMessage(state.error)}</p>}
      <button className="btn btn-primary" style={{ fontSize: 13, marginTop: 6, cursor: "pointer" }} onClick={() => setConfirming(true)}>
        Withdraw {fmt(amount)} from Hyperliquid →
      </button>
      <ConfirmDialog
        open={confirming}
        title={`Withdraw from Hyperliquid ${envName}`}
        body={
          <div>
            {fmt(amount)} USDC leaves your Hyperliquid account for your own address on Arbitrum ({address.slice(0, 6)}…{address.slice(-4)}). Hyperliquid takes a {fmt(HL_WITHDRAW_FEE_USD)} fee, so about {fmt(arrives)} arrives, usually within 5 minutes. You sign in your wallet (no gas){!unified && balances.data.perps < amount ? "; first a second signature moves USDC from spot to perps" : ""}.
          </div>
        }
        confirmLabel="Withdraw"
        warning={envName === "testnet" ? "TESTNET — no real funds." : "Mainnet — real funds."}
        onConfirm={() => void run()}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
