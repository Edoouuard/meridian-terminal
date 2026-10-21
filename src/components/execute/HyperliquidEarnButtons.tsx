"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useSignTypedData } from "wagmi";
import type { Address } from "viem";
import type { TradeLeg } from "@/lib/tradePlan";
import {
  HLP_LOCKUP_DAYS,
  HYPE_UNSTAKE_DAYS,
  depositToHlp,
  fetchSpotBalance,
  fetchValidators,
  fetchWithdrawable,
  hyperliquidEnv,
  pickValidator,
  stakeHype,
  withdrawableUsd,
  type WalletSign,
} from "@/lib/integrations/hyperliquidTrade";
import { useSharedHlEnv } from "@/hooks/useHyperliquidEnv";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { OrderRow } from "@/components/thread/shared";
import { recordExecution } from "@/lib/history";

const muted = { margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)" } as const;
const errStyle = { margin: "4px 0 0", fontSize: 11, color: "var(--risk-bad, #c0392b)" } as const;
const doneStyle = { margin: "6px 0 0", fontSize: 12, color: "var(--color-accent-700)" } as const;
const fmt = (x: number) => `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const declined = (msg: string) => (/user rejected|denied/i.test(msg) ? "Signature declined in the wallet." : msg.split("\n")[0]);

/**
 * Deposit USDC from the user's Hyperliquid account into HLP, Hyperliquid's
 * market-making vault (lib/integrations/hyperliquidTrade.ts depositToHlp):
 * signed by the trading key (approved once by the wallet), plus one wallet
 * signature when USDC has to move from spot to perps first. HLP locks a
 * deposit for 4 days.
 */
export function HlpDepositButton({ leg, onDone }: { leg: TradeLeg; onDone?: (ref: string) => void }) {
  const { address, isConnected, chainId } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const envName = useSharedHlEnv();
  const env = hyperliquidEnv(envName === "testnet");
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<{ status: "idle" | "approving" | "moving" | "depositing" | "done" | "error"; amount?: number; error?: string }>({ status: "idle" });
  const balances = useQuery({ queryKey: ["hl-withdrawable", envName, address], queryFn: () => fetchWithdrawable(env, address as Address), enabled: !!address, refetchInterval: 30_000 });

  if (!isConnected || !address || !chainId) return <p style={muted}>Connect a wallet to deposit into HLP.</p>;
  if (balances.isLoading) return <p style={muted}>Reading your Hyperliquid balance…</p>;
  if (!balances.data) return <p style={errStyle}>Couldn&apos;t read your Hyperliquid balance.</p>;
  const free = withdrawableUsd(balances.data);
  const amount = Math.floor(Math.min(leg.sizeUsd ?? free, free) * 100) / 100;
  const row = <OrderRow label="Free in Hyperliquid" value={`${fmt(free)} USDC`} />;

  if (state.status === "done") return <p style={doneStyle}>{fmt(state.amount ?? amount)} is in HLP. It earns HLP&apos;s market-making returns (and losses) and can be withdrawn after {HLP_LOCKUP_DAYS} days.</p>;
  if (state.status === "approving" || state.status === "moving" || state.status === "depositing") {
    return (
      <>
        {row}
        <p style={muted}>{state.status === "approving" ? "Sign in your wallet: approve Meridian's trading key (once)…" : state.status === "moving" ? "Sign in your wallet: move USDC from spot to perps (no gas)…" : "Depositing into HLP…"}</p>
      </>
    );
  }
  if (!(amount >= 1)) return <>{row}<p style={muted}>No USDC free in your Hyperliquid account. Deposit USDC to Hyperliquid first.</p></>;

  const walletSign: WalletSign = (typedData) => signTypedDataAsync(typedData as Parameters<typeof signTypedDataAsync>[0]);
  async function run() {
    setConfirming(false);
    try {
      const out = await depositToHlp({ user: address!, env, walletSign, walletChainId: chainId!, usd: amount, onStep: (s) => setState({ status: s }) });
      if (!out.ok) return setState({ status: "error", error: out.error });
      setState({ status: "done", amount: out.amount });
      onDone?.(`hyperliquid:HLP:${out.amount}@deposit`);
      recordExecution({ type: "deposit", label: "Deposit USDC into HLP", amount: String(out.amount), asset: "USDC", protocol: "Hyperliquid HLP", status: "confirmed" });
    } catch (err) {
      setState({ status: "error", error: declined(err instanceof Error ? err.message : String(err)) });
    }
  }

  return (
    <>
      {row}
      <OrderRow label="Deposit" value={`${fmt(amount)} USDC → HLP (locked ${HLP_LOCKUP_DAYS} days)`} valueColor="var(--color-accent-700)" />
      {state.status === "error" && <p style={errStyle}>{state.error}</p>}
      <button className="btn btn-primary" style={{ fontSize: 13, marginTop: 6, cursor: "pointer" }} onClick={() => setConfirming(true)}>
        Deposit {fmt(amount)} into HLP →
      </button>
      <ConfirmDialog
        open={confirming}
        title={`Deposit into HLP (Hyperliquid ${envName})`}
        body={
          <div>
            {fmt(amount)} USDC from your Hyperliquid account goes into HLP, the protocol&apos;s market-making vault. Its returns come from trading and can be negative. A deposit is locked for {HLP_LOCKUP_DAYS} days. Signed by Meridian&apos;s trading key on your account (no gas).
          </div>
        }
        confirmLabel="Deposit"
        warning={envName === "testnet" ? "TESTNET — no real funds." : "Mainnet — real funds."}
        onConfirm={() => void run()}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

/**
 * Stake HYPE from the Hyperliquid spot balance (stakeHype: move to staking,
 * then delegate): two wallet signatures, no gas. The validator is the most
 * staked active one with a commission of 5% or less; getting HYPE back takes
 * Hyperliquid's 7-day unstaking queue.
 */
export function HypeStakeButton({ leg, prices, onDone }: { leg: TradeLeg; prices?: { symbol: string; price: number }[]; onDone?: (ref: string) => void }) {
  const { address, isConnected, chainId } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const envName = useSharedHlEnv();
  const env = hyperliquidEnv(envName === "testnet");
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<{ status: "idle" | "depositing" | "delegating" | "done" | "error"; amount?: number; error?: string }>({ status: "idle" });
  const spot = useQuery({ queryKey: ["hl-spot-hype", envName, address], queryFn: () => fetchSpotBalance(env, address as Address, "HYPE"), enabled: !!address, refetchInterval: 30_000 });
  const validators = useQuery({ queryKey: ["hl-validators", envName], queryFn: () => fetchValidators(env), staleTime: 10 * 60_000 });

  if (!isConnected || !address || !chainId) return <p style={muted}>Connect a wallet to stake HYPE.</p>;
  if (spot.isLoading || validators.isLoading) return <p style={muted}>Reading your HYPE balance and the validator set…</p>;
  const validator = pickValidator(validators.data ?? []);
  if (!validator) return <p style={errStyle}>Couldn&apos;t read Hyperliquid&apos;s validators. Try again in a moment.</p>;
  const held = spot.data ?? 0;
  const px = (prices ?? []).find((p) => p.symbol === "HYPE")?.price ?? 0;
  const wanted = leg.sizeToken ? Number(leg.sizeToken) : px > 0 && leg.sizeUsd ? leg.sizeUsd / px : held;
  const amount = Math.floor(Math.min(wanted, held) * 1e4) / 1e4;
  const row = <OrderRow label="HYPE in spot" value={`${held.toFixed(4)} HYPE${px > 0 ? ` (${fmt(held * px)})` : ""}`} />;

  if (state.status === "done") return <p style={doneStyle}>{state.amount} HYPE staked with {validator.name}. Rewards accrue from now; unstaking takes {HYPE_UNSTAKE_DAYS} days.</p>;
  if (state.status === "depositing" || state.status === "delegating") {
    return <>{row}<p style={muted}>{state.status === "depositing" ? "Sign in your wallet (1/2): move HYPE to staking…" : `Sign in your wallet (2/2): delegate to ${validator.name}…`}</p></>;
  }
  if (!(amount > 0)) return <>{row}<p style={muted}>No HYPE in your Hyperliquid spot balance. Buy or move HYPE there first.</p></>;

  const walletSign: WalletSign = (typedData) => signTypedDataAsync(typedData as Parameters<typeof signTypedDataAsync>[0]);
  async function run() {
    setConfirming(false);
    try {
      const out = await stakeHype({ user: address!, env, walletSign, walletChainId: chainId!, amount, validator: validator!.validator, onStep: (s) => setState({ status: s }) });
      if (!out.ok) return setState({ status: "error", error: out.error });
      setState({ status: "done", amount: out.amount });
      onDone?.(`hyperliquid:HYPE:${out.amount}@stake`);
      recordExecution({ type: "deposit", label: `Stake HYPE with ${validator!.name}`, amount: String(out.amount), asset: "HYPE", protocol: "Hyperliquid staking", status: "confirmed" });
    } catch (err) {
      setState({ status: "error", error: declined(err instanceof Error ? err.message : String(err)) });
    }
  }

  return (
    <>
      {row}
      <OrderRow label="Stake" value={`${amount} HYPE → ${validator.name} (${(validator.commission * 100).toFixed(1)}% commission)`} valueColor="var(--color-accent-700)" />
      {state.status === "error" && <p style={errStyle}>{state.error}</p>}
      <button className="btn btn-primary" style={{ fontSize: 13, marginTop: 6, cursor: "pointer" }} onClick={() => setConfirming(true)}>
        Stake {amount} HYPE →
      </button>
      <ConfirmDialog
        open={confirming}
        title={`Stake HYPE (Hyperliquid ${envName})`}
        body={
          <div>
            {amount} HYPE moves from your spot balance to staking and is delegated to {validator.name}, the most staked active validator charging 5% or less. Two wallet signatures, no gas. Unstaking goes through Hyperliquid&apos;s {HYPE_UNSTAKE_DAYS}-day queue.
          </div>
        }
        confirmLabel="Stake"
        warning={envName === "testnet" ? "TESTNET — no real funds." : "Mainnet — real funds."}
        onConfirm={() => void run()}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
