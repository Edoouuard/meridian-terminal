"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Network as ExtendedNetwork } from "@blackcube/extended-sdk";
import { ExtendedKeyError, connectExtendedAccount, disconnectExtendedAccount, useExtendedAccount } from "@/hooks/useExtendedAccount";
import { useAccount, useWalletClient } from "wagmi";
import { fetchExtendedBalance, fetchExtendedPositions } from "@/lib/integrations/extended-live";
import { onboardExtended } from "@/lib/integrations/extendedOnboarding";
import { useExtendedPerp } from "@/hooks/useExtendedPerp";
import { useLivePrices } from "@/hooks/useLivePrices";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { fmtUsd } from "@/lib/data";
import { ExtendedDepositButton } from "@/components/execute/ExtendedDepositButton";
import { EXTENDED_MIN_DEPOSIT_USD } from "@/lib/integrations/extendedBridge";
import { humanizeMessage } from "@/lib/errorText";

function fmtPx(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "-";
  return n >= 100 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n < 1 ? n.toFixed(4) : n.toFixed(2);
}

/** Positions read + close for the connected Extended account. Direct-to-venue read, same as every other position list in this app. */
function ExtendedPositions() {
  const signer = useExtendedAccount();
  const { data: prices } = useLivePrices();
  const { status, result, error: execError, execute, reset } = useExtendedPerp();
  const [closing, setClosing] = useState<{ symbol: string; qty: number; side: "long" | "short" } | null>(null);
  const queryClient = useQueryClient();

  const { data: positions, isLoading, error } = useQuery({
    queryKey: ["extended-positions", signer?.apiKey, signer?.network],
    queryFn: () => fetchExtendedPositions(signer!),
    enabled: !!signer,
    refetchInterval: 30_000,
  });

  useEffect(() => {
    if (status === "confirmed") queryClient.invalidateQueries({ queryKey: ["extended-positions"] });
  }, [status, queryClient]);

  if (!signer) return null;
  if (isLoading) return <p style={{ fontSize: 11, margin: "6px 0 0" }} className="text-muted">Reading positions…</p>;
  if (error) return <p style={{ fontSize: 11, margin: "6px 0 0", color: "var(--risk-warning)" }}>{error instanceof Error ? error.message : String(error)}</p>;
  const open = (positions ?? []).filter((p) => p.side && Number(p.size) !== 0);
  if (open.length === 0) return <p style={{ fontSize: 11, margin: "6px 0 0" }} className="text-muted">No open Extended positions.</p>;

  const closeOne = (p: { name: string; side: string | null; size: string }) => {
    const symbol = p.name.replace(/-USD$/i, "");
    const qty = Math.abs(Number(p.size));
    setClosing({ symbol, qty, side: p.side === "short" ? "short" : "long" });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: "var(--space-2)" }}>
      {open.map((p, i) => {
        const pnl = Number(p.unrealizedPnl);
        const ok = pnl >= 0;
        return (
          <div key={i} style={{ border: "1px solid var(--color-divider)", borderRadius: "var(--radius-sm)", padding: "6px 8px", fontSize: 11, display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontWeight: 600, fontFamily: "var(--font-heading)" }}>
                {p.name.replace(/-USD$/i, "")} {p.side === "short" ? "SHORT" : "LONG"}
              </span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{Math.abs(Number(p.size)).toFixed(4)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }} className="text-muted">
              <span>Entry {fmtPx(Number(p.entryPrice))} · liq {fmtPx(Number(p.liquidationPrice))} · {p.leverage ?? 1}x</span>
              <span style={{ color: ok ? "var(--risk-good)" : "var(--risk-serious)", fontVariantNumeric: "tabular-nums" }}>
                {ok ? "+" : ""}
                {fmtUsd(pnl)}
              </span>
            </div>
            <button className="btn btn-secondary" style={{ fontSize: 10, padding: "2px 8px", alignSelf: "flex-end" }} onClick={() => closeOne(p)}>
              Close
            </button>
          </div>
        );
      })}

      {status !== "idle" && (
        <p style={{ fontSize: 11 }}>
          {status === "submitting"
            ? "Closing…"
            : status === "confirmed" && result
              ? "Close order submitted."
              : `Error: ${execError ?? "failed"}`}
          <button onClick={reset} style={{ marginLeft: 6, background: "none", border: "none", cursor: "pointer", color: "var(--color-neutral-500)", fontSize: 10 }}>
            clear
          </button>
        </p>
      )}

      <ConfirmDialog
        open={!!closing}
        title={closing ? `Close ${closing.symbol}` : "Close position"}
        body={closing ? <div>Reduce-only IOC order to close {closing.qty.toFixed(4)} {closing.symbol} ({closing.side}) on Extended {signer.network}.</div> : null}
        confirmLabel="Sign & close"
        warning={signer.network === "testnet" ? "TESTNET — no real funds." : "Mainnet — real funds. Confirm carefully."}
        onConfirm={() => {
          if (closing) {
            execute({
              signer,
              symbol: closing.symbol,
              isBuy: closing.side === "short",
              sizeUsd: 0,
              qtyOverride: closing.qty,
              reduceOnly: true,
              prices,
            });
          }
          setClosing(null);
        }}
        onCancel={() => setClosing(null)}
      />
    </div>
  );
}

/** Deposit a chosen amount of Arbitrum USDC into the connected Extended account. */
function ExtendedDepositForm() {
  const [amount, setAmount] = useState(String(EXTENDED_MIN_DEPOSIT_USD * 2));
  const [chosen, setChosen] = useState<number | null>(null);
  if (chosen !== null) {
    return <ExtendedDepositButton leg={{ side: "Deposit", asset: "USDC", protocol: "Extended", chain: "Arbitrum", sizeUsd: chosen }} />;
  }
  const value = Number(amount);
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}>
      <input
        className="input"
        inputMode="decimal"
        aria-label="Amount of USDC to deposit"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        style={{ width: 90, fontSize: 12 }}
      />
      <span className="text-muted" style={{ fontSize: 11 }}>USDC</span>
      <button type="button" className="btn btn-primary" style={{ fontSize: 12 }} disabled={!(value >= EXTENDED_MIN_DEPOSIT_USD)} onClick={() => setChosen(value)}>
        Deposit from Arbitrum
      </button>
    </div>
  );
}

/** Equity and free margin of the connected Extended account (`/user/balance`; 404 until the first deposit). */
function ExtendedBalance() {
  const signer = useExtendedAccount();
  const { data } = useQuery({
    queryKey: ["extended-balance", signer?.apiKey, signer?.network],
    queryFn: () => fetchExtendedBalance(signer!),
    enabled: !!signer,
    refetchInterval: 30_000,
  });
  if (!signer || data === undefined) return null;
  if (data === null) {
    return (
      <>
        <p style={{ fontSize: 11, margin: "6px 0 0" }} className="text-muted">
          No funds yet. Deposit USDC from Arbitrum below (Extended&apos;s Rhino.fi bridge, a few minutes).
        </p>
        <ExtendedDepositForm />
      </>
    );
  }
  return (
    <p style={{ fontSize: 11, margin: "6px 0 0", fontVariantNumeric: "tabular-nums" }}>
      Equity {fmtUsd(data.equity)} · free {fmtUsd(data.availableForTrade)}
      {data.unrealisedPnl !== 0 && (
        <span style={{ color: data.unrealisedPnl >= 0 ? "var(--risk-good)" : "var(--risk-serious)" }}>
          {" "}
          · {data.unrealisedPnl >= 0 ? "+" : ""}
          {fmtUsd(data.unrealisedPnl)} open
        </span>
      )}
    </p>
  );
}

const STEP_LABELS = ["Sign 1/3: create your Extended trading key", "Sign 2/3: open the account", "Sign 3/3: issue an API key"];

/**
 * Extended (ex-X10) account panel. Connecting = three wallet signatures (see
 * lib/integrations/extendedOnboarding.ts): the trading key is derived from the
 * first, so the account is the one extended.exchange opens for the same wallet.
 * Pasting API keys from Extended's dashboard stays available for accounts
 * opened another way.
 */
export function ExtendedConnectPanel() {
  const signer = useExtendedAccount();
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const [network, setNetwork] = useState<ExtendedNetwork>("mainnet");
  const [step, setStep] = useState<number | null>(null);
  const [manual, setManual] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [l2PrivateKey, setL2PrivateKey] = useState("");
  const [vaultId, setVaultId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const connectWithWallet = async () => {
    if (!address || !walletClient) return;
    setError(null);
    let signs = 0;
    const next = () => setStep(Math.min(signs++, 2));
    try {
      next();
      const out = await onboardExtended({
        wallet: address,
        network,
        signTypedData: async (d) => {
          const sig = await walletClient.signTypedData({ account: address, ...d } as Parameters<typeof walletClient.signTypedData>[0]);
          next();
          return sig;
        },
        signMessage: (message) => walletClient.signMessage({ account: address, message }),
      });
      connectExtendedAccount({ apiKey: out.apiKey, l2PrivateKey: out.l2PrivateKey, vaultId: out.vaultId, network });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(/rejected|denied/i.test(msg) ? "Signature declined, nothing was created." : msg);
    } finally {
      setStep(null);
    }
  };

  const connectManual = () => {
    setError(null);
    try {
      connectExtendedAccount({ apiKey, l2PrivateKey, vaultId, network });
      setApiKey("");
      setL2PrivateKey("");
      setVaultId("");
      setManual(false);
    } catch (err) {
      setError(err instanceof ExtendedKeyError ? err.message : err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <div className="hr" style={{ margin: "var(--space-3) 0" }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h6 style={{ color: "var(--color-accent)", margin: 0 }}>Extended</h6>
        {signer && (
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <span className="text-muted" style={{ fontSize: 10 }}>
              {signer.network}
            </span>
            <button className="btn btn-secondary" style={{ fontSize: 10, padding: "2px 8px" }} onClick={() => disconnectExtendedAccount()}>
              disconnect
            </button>
          </div>
        )}
      </div>

      {signer && (
        <>
          <p style={{ fontSize: 11, margin: "6px 0 0" }} className="text-muted">
            Connected · account {signer.vaultId} · {signer.network}. Perp legs routed to Extended sign and submit live.
          </p>
          <ExtendedBalance />
        </>
      )}

      {!signer && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: "var(--space-2)" }}>
          <p style={{ fontSize: 11, margin: 0 }} className="text-muted">
            Perps on Starknet, settled in USDC. Connecting opens your Extended account with three signatures (no transaction,
            no gas) and accepts Extended&apos;s{" "}
            <a href="https://docs.extended.exchange/extended-resources/terms-and-conditions" target="_blank" rel="noreferrer">
              terms
            </a>
            . The trading key stays in this browser.
          </p>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <label style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
              <input type="radio" checked={network === "mainnet"} onChange={() => setNetwork("mainnet")} /> mainnet
            </label>
            <label style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
              <input type="radio" checked={network === "testnet"} onChange={() => setNetwork("testnet")} /> testnet
            </label>
          </div>
          {step !== null ? (
            <p style={{ fontSize: 11, margin: 0 }}>{STEP_LABELS[step]}… check your wallet.</p>
          ) : (
            <button className="btn btn-primary" style={{ fontSize: 12 }} disabled={!address || !walletClient} onClick={connectWithWallet}>
              {address ? "Connect Extended with my wallet" : "Connect a wallet first"}
            </button>
          )}
          {error && <p style={{ fontSize: 11, margin: 0, color: "var(--risk-bad, #c0392b)" }}>{humanizeMessage(error)}</p>}

          <button
            className="btn btn-secondary"
            style={{ fontSize: 10, padding: "2px 8px", alignSelf: "flex-start" }}
            onClick={() => setManual((v) => !v)}
          >
            {manual ? "hide API keys" : "use API keys instead"}
          </button>
          {manual && (
            <>
              <p style={{ fontSize: 11, margin: 0 }} className="text-muted">
                From extended.exchange → API management: API key, Stark private key and vault id. They stay in this browser;
                the Stark key can also withdraw on Extended, so only paste one you&apos;re comfortable automating.
              </p>
              <input className="input" style={{ fontSize: 12 }} placeholder="API key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
              <input
                className="input"
                style={{ fontSize: 12 }}
                placeholder="Stark private key (0x…)"
                type="password"
                value={l2PrivateKey}
                onChange={(e) => setL2PrivateKey(e.target.value)}
              />
              <input className="input" style={{ fontSize: 12 }} placeholder="Vault / position id" value={vaultId} onChange={(e) => setVaultId(e.target.value)} />
              <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={connectManual}>
                Connect with API keys
              </button>
            </>
          )}
        </div>
      )}

      <ExtendedPositions />
    </>
  );
}
