"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useSignTypedData } from "wagmi";
import type { Address } from "viem";
import type { TradeLeg } from "@/lib/tradePlan";
import type { Order } from "@/lib/execution";
import { fmtUsd } from "@/lib/data";
import { fundingAprForSide, marginNeededUsd } from "@/lib/integrations/hyperliquidTrade";
import { ARBITRUM_USDC, HYPERLIQUID_DEPOSIT_CHAIN_ID } from "@/lib/integrations/hyperliquidDeposit";
import { TXFLOW_MIN_WITHDRAW_USD, TXFLOW_WITHDRAW_FEE_USD } from "@/lib/integrations/txflowExchange";
import { TXFLOW_MIN_DEPOSIT_USD, TXFLOW_NETWORK, fetchTxflowAccount, fetchTxflowBridge, fetchTxflowCtx, fetchTxflowMarkets, findTxflowMarket } from "@/lib/integrations/txflow-live";
import { loadTxflowAgent, txflowMarketOrder, withTxflowAgent, withdrawFromTxflow, type TxflowFillResult, type TxflowWalletSign } from "@/lib/integrations/txflowTrade";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ValidatedExecuteButton } from "@/components/ValidatedExecuteButton";
import { NotWired, OrderRow } from "@/components/thread/shared";
import { recordExecution } from "@/lib/history";

const muted = { margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)" } as const;
const errStyle = { margin: "4px 0 0", fontSize: 12, color: "var(--risk-bad, #c0392b)" } as const;
const doneStyle = { margin: "6px 0 0", fontSize: 12, color: "var(--color-accent-700)" } as const;
const declined = (msg: string) => (/user rejected|denied/i.test(msg) ? "Signature declined in the wallet." : msg.split("\n")[0]);
const isTestnet = TXFLOW_NETWORK === "testnet";

function useTxflowSigner(): { address?: Address; chainId?: number; walletSign: TxflowWalletSign } {
  const { address, chainId } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  return { address, chainId, walletSign: (td) => signTypedDataAsync(td as Parameters<typeof signTypedDataAsync>[0]) };
}

/**
 * A TxFlow perp order (lib/integrations/txflowTrade.ts): the market and its
 * funding for this side, the account's free margin against what the order
 * needs, then an IOC market order signed by Meridian's TxFlow trading key
 * (approved once by the wallet; it can trade, never withdraw). The fill is
 * read back from the account; a position can be closed here at market.
 */
export function TxflowPerpExecuteButton({ leg, onFilled, baseQty }: { leg: TradeLeg; onFilled?: (ref: string) => void; baseQty?: number }) {
  const { address, chainId, walletSign } = useTxflowSigner();
  const [confirming, setConfirming] = useState<"open" | "close" | null>(null);
  const [state, setState] = useState<{ status: "idle" | "approving" | "submitting" | "done" | "error"; result?: TxflowFillResult; error?: string; closed?: boolean }>({ status: "idle" });

  const side = (leg.side || "").trim().toLowerCase();
  const isBuy = side === "long" || side === "buy";
  const sizeUsd = leg.sizeUsd && leg.sizeUsd > 0 ? leg.sizeUsd : 0;
  const leverage = Math.max(1, Math.round(leg.leverage ?? 1));

  const market = useQuery({
    queryKey: ["txflow-market", TXFLOW_NETWORK, leg.asset],
    queryFn: async () => {
      const m = findTxflowMarket(await fetchTxflowMarkets(), leg.asset);
      return m ? { market: m, ctx: await fetchTxflowCtx(m.index) } : null;
    },
    staleTime: 15_000,
  });
  const acct = useQuery({
    queryKey: ["txflow-account", TXFLOW_NETWORK, address],
    queryFn: () => fetchTxflowAccount(address as Address),
    enabled: !!address,
    refetchInterval: 10_000,
  });

  const recorded = useRef(false);
  useEffect(() => {
    const f = state.result?.filled;
    if (state.status !== "done" || !f || recorded.current || state.closed) return;
    recorded.current = true;
    const m = state.result?.market;
    onFilled?.(`txflow:${m?.name ?? leg.asset}:${f.totalSz}@${f.avgPx}`);
    recordExecution({ type: isBuy ? "buy" : "sell", label: `${isBuy ? "Long" : "Short"} ${m?.base ?? leg.asset} (TxFlow)`, amount: String(f.totalSz), asset: m?.base ?? leg.asset, protocol: "TxFlow", status: "confirmed" });
  }, [state, isBuy, leg.asset, onFilled]);

  if (!sizeUsd && !(baseQty && baseQty > 0)) return <NotWired venue="TxFlow" reason="This position came back without a size. Ask again with the amount you want." />;
  if (!address || !chainId) return <p style={muted}>Connect a wallet to trade on TxFlow.</p>;
  if (market.isLoading) return <p style={muted}>Reading the market on TxFlow…</p>;
  if (market.isError) return <p style={errStyle}>Couldn&apos;t reach TxFlow. Try again in a moment.</p>;
  if (!market.data || !market.data.ctx) return <NotWired venue="TxFlow" reason={`${leg.asset} has no live perp market on TxFlow.`} />;
  const { market: m, ctx } = market.data;

  const funding = fundingAprForSide(ctx.fundingHourly, isBuy);
  const free = acct.data?.withdrawable ?? 0;
  const notional = baseQty && baseQty > 0 ? baseQty * ctx.mark : sizeUsd;
  const needed = marginNeededUsd(notional, leverage);
  const position = acct.data?.positions.find((p) => p.index === m.index);
  const run = async (close: boolean) => {
    setConfirming(null);
    setState({ status: "submitting" });
    try {
      const out = await withTxflowAgent({ user: address, walletSign, walletChainId: chainId, onApproving: () => setState({ status: "approving" }) }, (key) => {
        setState({ status: "submitting" });
        return close && position
          ? txflowMarketOrder(TXFLOW_NETWORK, key, { user: address, symbol: m.name, isBuy: position.size < 0, coinQty: Math.abs(position.size), reduceOnly: true })
          : txflowMarketOrder(TXFLOW_NETWORK, key, { user: address, symbol: m.name, isBuy, sizeUsd, coinQty: baseQty, leverage });
      });
      setState(out.ok ? { status: "done", result: out, closed: close } : { status: "error", error: out.error });
      void acct.refetch();
    } catch (err) {
      setState({ status: "error", error: declined(err instanceof Error ? err.message : String(err)) });
    }
  };

  const info = (
    <>
      <OrderRow label="Market" value={`${m.name} $${ctx.mark.toLocaleString("en-US", { maximumFractionDigits: 4 })} · max ${m.maxLeverage}x`} />
      <OrderRow
        label="Funding"
        value={`${funding >= 0 ? "+" : ""}${funding.toFixed(1)}%/yr ${funding >= 0 ? "earned" : "paid"} by a ${isBuy ? "long" : "short"}`}
        valueColor={funding >= 0 ? "var(--color-accent-700)" : "var(--risk-bad, #c0392b)"}
      />
      <OrderRow
        label="Margin"
        value={acct.isLoading ? "…" : `${fmtUsd(free)} free · needs ~${fmtUsd(needed)} (${leverage}x)`}
        valueColor={!acct.isLoading && free < needed ? "var(--risk-bad, #c0392b)" : undefined}
      />
      {position && <OrderRow label="Open now" value={`${position.size > 0 ? "Long" : "Short"} ${Math.abs(position.size)} ${m.base}`} />}
    </>
  );

  if (state.status === "approving" || state.status === "submitting") {
    return <>{info}<p style={muted}>{state.status === "approving" ? "Sign in your wallet: approve Meridian's TxFlow trading key (once, no gas)…" : "Sending the order to TxFlow…"}</p></>;
  }
  if (state.status === "done" && state.result?.filled) {
    const f = state.result.filled;
    return (
      <>
        <p style={doneStyle}>
          {state.closed ? `Closed ${f.totalSz} ${m.base} on TxFlow at ~$${f.avgPx.toLocaleString("en-US", { maximumFractionDigits: 4 })}.` : `Filled on TxFlow: ${isBuy ? "long" : "short"} ${f.totalSz} ${m.base} at ~$${f.avgPx.toLocaleString("en-US", { maximumFractionDigits: 4 })}.`}
        </p>
        {!state.closed && position && (
          <button className="btn" style={{ fontSize: 12, marginTop: 6, cursor: "pointer" }} onClick={() => setConfirming("close")}>
            Close {position.size > 0 ? "long" : "short"} {Math.abs(position.size)} {m.base} →
          </button>
        )}
        <ConfirmDialog
          open={confirming === "close"}
          title={`Close ${m.base} on TxFlow`}
          body={<div>Reduce-only market order closing {position ? Math.abs(position.size) : 0} {m.base} (fills now within 1% of the mark, or not at all).</div>}
          confirmLabel="Close position"
          warning={isTestnet ? "TESTNET — no real funds." : "Mainnet — real funds."}
          onConfirm={() => void run(true)}
          onCancel={() => setConfirming(null)}
        />
      </>
    );
  }

  const short = !acct.isLoading && free < needed;
  return (
    <>
      {info}
      {state.status === "error" && <p style={errStyle}>TxFlow: {state.error}</p>}
      {short ? (
        <p style={muted}>
          Your TxFlow account needs ~{fmtUsd(needed - free)} more margin. Add a &ldquo;Deposit USDC to TxFlow&rdquo; step (USDC on Arbitrum, minimum {TXFLOW_MIN_DEPOSIT_USD} USDC), or deposit on txflow.com.
        </p>
      ) : (
        <button className="btn btn-primary" style={{ fontSize: 13, marginTop: 6, cursor: "pointer" }} onClick={() => setConfirming("open")}>
          {isBuy ? "Long" : "Short"} {baseQty ? `${baseQty} ${m.base}` : fmtUsd(sizeUsd)} on TxFlow →
        </button>
      )}
      <ConfirmDialog
        open={confirming === "open"}
        title={`${isBuy ? "Long" : "Short"} ${m.base} on TxFlow`}
        body={
          <div>
            IOC market order: {isBuy ? "buy" : "sell"} {baseQty ? `${baseQty} ${m.base}` : `${fmtUsd(sizeUsd)} of ${m.base}`} at {leverage}x (cross margin), filled now within 1% of the mark or not at all.
            {!loadTxflowAgent(address) && " First, your wallet approves a Meridian trading key for TxFlow (one signature, no gas): it can trade, never withdraw."}
          </div>
        }
        confirmLabel={isBuy ? "Open long" : "Open short"}
        warning={isTestnet ? "TESTNET — no real funds." : "Mainnet — real funds."}
        onConfirm={() => void run(false)}
        onCancel={() => setConfirming(null)}
      />
    </>
  );
}

/**
 * Fund the TxFlow perp account: native USDC on Arbitrum sent to TxFlow's
 * Bridge2 contract (address read live from TxFlow), credited to the sender in
 * a minute or two. A plain validated ERC-20 transfer; minimum 5 USDC.
 */
export function TxflowDepositButton({ leg }: { leg: TradeLeg }) {
  const bridge = useQuery({ queryKey: ["txflow-bridge", TXFLOW_NETWORK], queryFn: () => fetchTxflowBridge(), staleTime: 3_600_000 });
  const amount = Math.floor((leg.sizeUsd ?? 0) * 100) / 100;
  if (bridge.isLoading) return <p style={muted}>Reading TxFlow&apos;s deposit bridge…</p>;
  if (!bridge.data) return <p style={errStyle}>Couldn&apos;t read TxFlow&apos;s deposit address. Try again in a moment.</p>;
  if (!(amount >= TXFLOW_MIN_DEPOSIT_USD)) return <NotWired venue="TxFlow" reason={`TxFlow's minimum deposit is ${TXFLOW_MIN_DEPOSIT_USD} USDC.`} />;
  if (isTestnet) return <NotWired venue="TxFlow" reason="TxFlow testnet is funded from its faucet, not from Arbitrum." />;
  const order: Order = {
    type: "transfer",
    protocol: "erc20",
    symbol: "USDC",
    token: ARBITRUM_USDC,
    amount: amount.toFixed(2),
    chainId: HYPERLIQUID_DEPOSIT_CHAIN_ID,
    decimals: 6,
    to: bridge.data,
  };
  return (
    <>
      <OrderRow label="Deposit" value={`${amount.toFixed(2)} USDC (Arbitrum) → your TxFlow account`} valueColor="var(--color-accent-700)" />
      <p style={muted}>
        Sent to TxFlow&apos;s Bridge2 ({bridge.data.slice(0, 6)}…{bridge.data.slice(-4)}), credited to this address in a minute or two. Native USDC only.
      </p>
      <ValidatedExecuteButton order={order} label={`Deposit ${amount.toFixed(2)} USDC to TxFlow →`} />
    </>
  );
}

/** USDC from the TxFlow perp account back to the wallet on Arbitrum (wallet-signed, $1 fee). */
export function TxflowWithdrawButton({ leg, onDone }: { leg: TradeLeg; onDone?: (ref: string) => void }) {
  const { address, chainId, walletSign } = useTxflowSigner();
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<{ status: "idle" | "signing" | "done" | "error"; amount?: number; error?: string }>({ status: "idle" });
  const acct = useQuery({ queryKey: ["txflow-account", TXFLOW_NETWORK, address], queryFn: () => fetchTxflowAccount(address as Address), enabled: !!address });

  if (!address || !chainId) return <p style={muted}>Connect a wallet to withdraw from TxFlow.</p>;
  if (acct.isLoading) return <p style={muted}>Reading your TxFlow balance…</p>;
  if (!acct.data) return <p style={errStyle}>Couldn&apos;t read your TxFlow balance.</p>;
  const free = acct.data.withdrawable;
  const amount = Math.floor(Math.min(leg.sizeUsd ?? free, free) * 100) / 100;
  if (state.status === "done") return <p style={doneStyle}>Withdrawal requested: about {fmtUsd(Math.max(0, (state.amount ?? 0) - TXFLOW_WITHDRAW_FEE_USD))} USDC reaches your address on Arbitrum after TxFlow&apos;s safety wait.</p>;
  if (state.status === "signing") return <p style={muted}>Sign in your wallet: withdraw from TxFlow (no gas)…</p>;
  if (!(amount >= TXFLOW_MIN_WITHDRAW_USD)) return <><OrderRow label="Withdrawable" value={`${fmtUsd(free)} USDC`} /><p style={muted}>Nothing to withdraw: TxFlow&apos;s minimum is {TXFLOW_MIN_WITHDRAW_USD} USDC.</p></>;

  const run = async () => {
    setConfirming(false);
    setState({ status: "signing" });
    try {
      const out = await withdrawFromTxflow({ user: address, walletSign, walletChainId: chainId, amount });
      if (!out.ok) return setState({ status: "error", error: out.error });
      setState({ status: "done", amount: out.amount });
      onDone?.(`txflow:USDC:${out.amount}@withdraw`);
      recordExecution({ type: "withdraw", label: "Withdraw USDC from TxFlow to Arbitrum", amount: String(out.amount), asset: "USDC", protocol: "TxFlow", status: "confirmed" });
    } catch (err) {
      setState({ status: "error", error: declined(err instanceof Error ? err.message : String(err)) });
    }
  };

  return (
    <>
      <OrderRow label="Withdraw" value={`${fmtUsd(amount)} USDC → Arbitrum (≈ ${fmtUsd(amount - TXFLOW_WITHDRAW_FEE_USD)} after the $${TXFLOW_WITHDRAW_FEE_USD} fee)`} valueColor="var(--color-accent-700)" />
      {state.status === "error" && <p style={errStyle}>{state.error}</p>}
      <button className="btn btn-primary" style={{ fontSize: 13, marginTop: 6, cursor: "pointer" }} onClick={() => setConfirming(true)}>
        Withdraw {fmtUsd(amount)} from TxFlow →
      </button>
      <ConfirmDialog
        open={confirming}
        title="Withdraw from TxFlow"
        body={<div>{fmtUsd(amount)} USDC leaves your TxFlow perp account for your own address on Arbitrum. TxFlow takes a ${TXFLOW_WITHDRAW_FEE_USD} fee and releases it after its validators approve and a short safety wait. One wallet signature, no gas.</div>}
        confirmLabel="Withdraw"
        warning={isTestnet ? "TESTNET — no real funds." : "Mainnet — real funds."}
        onConfirm={() => void run()}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
