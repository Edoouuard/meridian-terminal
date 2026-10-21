"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useSignTypedData } from "wagmi";
import type { Address } from "viem";
import { fmtUsd } from "@/lib/data";
import { TXFLOW_MIN_DEPOSIT_USD, TXFLOW_NETWORK, fetchTxflowAccount, fetchTxflowMarkets } from "@/lib/integrations/txflow-live";
import { approveTxflowAgent, forgetTxflowAgent, loadTxflowAgent, txflowMarketOrder, withTxflowAgent, type TxflowWalletSign } from "@/lib/integrations/txflowTrade";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { TxflowDepositButton, TxflowWithdrawButton } from "@/components/execute/TxflowButtons";

const declined = (msg: string) => (/user rejected|denied/i.test(msg) ? "Signature declined in the wallet." : msg.split("\n")[0]);

/**
 * TxFlow in Tools, next to Extended: the account behind the connected wallet
 * (TxFlow accounts are the wallet address, nothing to link), the trading key
 * Meridian signs orders with (approved once by the wallet, kept in this
 * browser, it can trade but never withdraw), balances and open positions with
 * a close button, and USDC deposit / withdrawal.
 */
export function TxflowPanel() {
  const { address, chainId } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const walletSign: TxflowWalletSign = (td) => signTypedDataAsync(td as Parameters<typeof signTypedDataAsync>[0]);
  const [keyTick, setKeyTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<{ index: number; base: string; size: number } | null>(null);
  const [depositAmount, setDepositAmount] = useState(String(TXFLOW_MIN_DEPOSIT_USD * 2));
  const [deposit, setDeposit] = useState<number | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);

  const acct = useQuery({ queryKey: ["txflow-account", TXFLOW_NETWORK, address], queryFn: () => fetchTxflowAccount(address as Address), enabled: !!address, refetchInterval: 20_000 });
  const markets = useQuery({ queryKey: ["txflow-markets", TXFLOW_NETWORK], queryFn: () => fetchTxflowMarkets(), staleTime: 300_000 });

  // Re-read on keyTick so the panel follows an approval or a reset.
  const agent = address && keyTick >= 0 ? loadTxflowAgent(address) : null;
  const base = (index: number) => markets.data?.find((m) => m.index === index)?.base ?? `#${index}`;

  const head = (
    <>
      <div className="hr" style={{ margin: "var(--space-3) 0" }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h6 style={{ color: "var(--color-accent)", margin: 0 }}>TxFlow</h6>
        {agent && address && (
          <button
            className="btn btn-secondary"
            style={{ fontSize: 10, padding: "2px 8px" }}
            onClick={() => {
              forgetTxflowAgent(address);
              setKeyTick((t) => t + 1);
            }}
          >
            reset key
          </button>
        )}
      </div>
    </>
  );

  if (!address || !chainId) {
    return (
      <>
        {head}
        <p style={{ fontSize: 11, margin: "6px 0 0" }} className="text-muted">Connect a wallet: your TxFlow account is your wallet address.</p>
      </>
    );
  }

  const connect = async () => {
    setError(null);
    setBusy("Sign in your wallet: approve Meridian's TxFlow trading key (no gas)…");
    try {
      await approveTxflowAgent({ user: address, walletSign, walletChainId: chainId });
      setKeyTick((t) => t + 1);
    } catch (err) {
      setError(declined(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(null);
    }
  };

  const close = async (p: { index: number; base: string; size: number }) => {
    setClosing(null);
    setError(null);
    setBusy(`Closing ${Math.abs(p.size)} ${p.base}…`);
    try {
      const out = await withTxflowAgent({ user: address, walletSign, walletChainId: chainId }, (key) =>
        txflowMarketOrder(TXFLOW_NETWORK, key, { user: address, symbol: p.base, isBuy: p.size < 0, coinQty: Math.abs(p.size), reduceOnly: true }),
      );
      if (!out.ok) setError(out.error ?? "The close didn't fill.");
      setKeyTick((t) => t + 1);
      void acct.refetch();
    } catch (err) {
      setError(declined(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(null);
    }
  };

  const a = acct.data;
  return (
    <>
      {head}
      <p style={{ fontSize: 11, margin: "6px 0 0" }} className="text-muted">
        {agent
          ? `Connected · trading key ${agent.address.slice(0, 6)}…${agent.address.slice(-4)} on ${TXFLOW_NETWORK}. TxFlow legs sign and submit live; the key can trade, never withdraw.`
          : "Your TxFlow account is this wallet. Connect once: your wallet approves a Meridian trading key (one signature, no gas). It can trade, never withdraw."}
      </p>
      {!agent && (
        <button className="btn btn-primary" style={{ fontSize: 12, marginTop: 6 }} disabled={!!busy} onClick={() => void connect()}>
          Connect TxFlow →
        </button>
      )}

      {acct.isLoading ? (
        <p style={{ fontSize: 11, margin: "6px 0 0" }} className="text-muted">Reading your TxFlow account…</p>
      ) : acct.isError || !a ? (
        <p style={{ fontSize: 11, margin: "6px 0 0", color: "var(--risk-warning)" }}>Couldn&apos;t read your TxFlow account right now.</p>
      ) : (
        <>
          <p style={{ fontSize: 11, margin: "6px 0 0", fontVariantNumeric: "tabular-nums" }}>
            Equity {fmtUsd(a.accountValue)} · free {fmtUsd(a.withdrawable)}
            {a.accountValue < 1 && <span className="text-muted"> · deposit USDC from Arbitrum to start (minimum {TXFLOW_MIN_DEPOSIT_USD} USDC)</span>}
          </p>
          {a.positions.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: "var(--space-2)" }}>
              {a.positions.map((p) => {
                const ok = p.unrealisedPnl >= 0;
                return (
                  <div key={p.index} style={{ border: "1px solid var(--color-divider)", borderRadius: "var(--radius-sm)", padding: "6px 8px", fontSize: 11, display: "flex", flexDirection: "column", gap: 2 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontWeight: 600, fontFamily: "var(--font-heading)" }}>
                        {base(p.index)} {p.size < 0 ? "SHORT" : "LONG"}
                      </span>
                      <span style={{ fontVariantNumeric: "tabular-nums" }}>{Math.abs(p.size)}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }} className="text-muted">
                      <span>
                        Entry {p.entry} · liq {p.liq || "-"} · {p.leverage}x
                      </span>
                      <span style={{ color: ok ? "var(--risk-good)" : "var(--risk-serious)", fontVariantNumeric: "tabular-nums" }}>
                        {ok ? "+" : ""}
                        {fmtUsd(p.unrealisedPnl)}
                      </span>
                    </div>
                    <button className="btn btn-secondary" style={{ fontSize: 10, padding: "2px 8px", alignSelf: "flex-end" }} disabled={!!busy} onClick={() => setClosing({ index: p.index, base: base(p.index), size: p.size })}>
                      Close
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {busy && <p style={{ fontSize: 11, margin: "6px 0 0" }} className="text-muted">{busy}</p>}
      {error && <p style={{ fontSize: 11, margin: "6px 0 0", color: "var(--risk-bad, #c0392b)" }}>{error}</p>}

      {deposit !== null ? (
        <TxflowDepositButton leg={{ side: "Deposit", asset: "USDC", protocol: "TxFlow", chain: "Arbitrum", sizeUsd: deposit }} />
      ) : (
        <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}>
          <input className="input" inputMode="decimal" aria-label="Amount of USDC to deposit to TxFlow" value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} style={{ width: 90, fontSize: 12 }} />
          <span className="text-muted" style={{ fontSize: 11 }}>USDC</span>
          <button type="button" className="btn btn-primary" style={{ fontSize: 12 }} disabled={!(Number(depositAmount) >= TXFLOW_MIN_DEPOSIT_USD)} onClick={() => setDeposit(Number(depositAmount))}>
            Deposit from Arbitrum
          </button>
        </div>
      )}
      {a && a.withdrawable >= 2 && (
        withdrawing ? (
          <TxflowWithdrawButton leg={{ side: "Withdraw", asset: "USDC", protocol: "TxFlow", chain: "Arbitrum", sizeUsd: a.withdrawable }} />
        ) : (
          <button className="btn btn-secondary" style={{ fontSize: 11, marginTop: 6 }} onClick={() => setWithdrawing(true)}>
            Withdraw to Arbitrum…
          </button>
        )
      )}

      <ConfirmDialog
        open={!!closing}
        title={closing ? `Close ${closing.base} on TxFlow` : "Close"}
        body={closing ? <div>Reduce-only market order closing {Math.abs(closing.size)} {closing.base} (fills now within 1% of the mark, or not at all).</div> : null}
        confirmLabel="Close position"
        warning={TXFLOW_NETWORK === "testnet" ? "TESTNET — no real funds." : "Mainnet — real funds."}
        onConfirm={() => closing && void close(closing)}
        onCancel={() => setClosing(null)}
      />
    </>
  );
}
