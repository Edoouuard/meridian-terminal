"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { fmtUsd } from "@/lib/data";
import type { TradeLeg } from "@/lib/tradePlan";
import { useHyperliquid } from "@/hooks/useHyperliquid";
import { useSharedHlEnv } from "@/hooks/useHyperliquidEnv";
import { useExtendedAccount } from "@/hooks/useExtendedAccount";
import { useExtendedPerp } from "@/hooks/useExtendedPerp";
import { useLifiPerpsSetup } from "@/hooks/useLifiPerpsSetup";
import { useLifiPerpOrder } from "@/hooks/useLifiPerpOrder";
import { LIFI_PROVIDER_LABEL, type LifiPerpsProviderId } from "@/lib/integrations/lifiPerps";
import { useSharedOndoEnv } from "@/hooks/useOndoEnv";
import { resolvePriceFromList, usdToTokenAmount, type PriceEntry } from "@/lib/quote";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { recordExecution } from "@/lib/history";
import { NotWired } from "@/components/thread/shared";

/**
 * Live Hyperliquid perp execution. Fetches the live mid price + asset index,
 * signs the EIP-712 order with the wallet, submits to the exchange API, and
 * reports the real status. Honest: any failure surfaces as error, never a
 * fake success.
 *
 * Shares its testnet/mainnet selection with HyperliquidPanel's toggle
 * (useSharedHlEnv) rather than hardcoding testnet — opening a position from
 * a thesis and closing one from the panel now always agree on which network
 * they're touching.
 *
 * The USD notional is quoted to an exact coin quantity via the live price list
 * (passed in), and that coinQty is handed to the Hyperliquid layer so the fill
 * uses the caller's computed number rather than silently re-deriving it. The
 * notional and the approximate coin amount are shown before signing.
 */
export function PerpExecuteButton({ leg, prices }: { leg: TradeLeg; prices?: PriceEntry[] }) {
  const { isConnected } = useAccount();
  const env = useSharedHlEnv();
  const { status, result, error, execute, reset } = useHyperliquid();
  const [confirming, setConfirming] = useState(false);

  const symbol = (leg.asset || "HYPE").replace(/PERP$/i, "").trim() || "HYPE";
  const sizeUsd = leg.sizeUsd && leg.sizeUsd > 0 ? leg.sizeUsd : 1000;
  const side = (leg.side || "").toLowerCase();
  const isBuy = side.startsWith("long") || side === "buy";
  const leverage = leg.leverage;

  // Exact coin quantity from the USD notional at the live price (8-decimal HL precision).
  const hlPrice = resolvePriceFromList(prices, symbol);
  const coinQty = hlPrice !== null ? sizeUsd / hlPrice : undefined;

  // Exact quote (8-decimal HL precision) used to show the implied coin amount.
  const hlQuote = hlPrice !== null ? usdToTokenAmount(symbol, sizeUsd, hlPrice, 8) : null;

  const recordedRef = useRef<string | null>(null);
  useEffect(() => {
    if (status === "confirmed" && result && recordedRef.current !== "ok") {
      recordedRef.current = "ok";
      recordExecution({
        type: isBuy ? "buy" : "sell",
        label: `${isBuy ? "Long" : "Short"} ${symbol}`,
        amount: coinQty !== undefined ? String(coinQty) : undefined,
        asset: symbol,
        protocol: "Hyperliquid",
        status: "confirmed",
      });
    } else if (status === "error" && recordedRef.current !== "error") {
      recordedRef.current = "error";
      recordExecution({
        type: isBuy ? "buy" : "sell",
        label: `${isBuy ? "Long" : "Short"} ${symbol} (failed)`,
        amount: coinQty !== undefined ? String(coinQty) : undefined,
        asset: symbol,
        protocol: "Hyperliquid",
        status: "error",
      });
    }
  }, [status, result, isBuy, symbol, coinQty]);

  if (status === "preparing" || status === "signing" || status === "submitting") {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)" }}>
        {status === "preparing"
          ? "Fetching Hyperliquid price…"
          : status === "signing"
            ? "Awaiting wallet signature…"
            : "Submitting order to Hyperliquid…"}
      </p>
    );
  }

  if (status === "confirmed" && result) {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-accent-700)" }}>
        Order on Hyperliquid {env}: {result.marketPrice ? "$" + result.marketPrice.toFixed(4) : "n/a"} →{" "}
        {JSON.stringify(result.response)}
        <button onClick={reset} style={{ marginLeft: 8, background: "none", border: "none", cursor: "pointer", color: "var(--color-neutral-500)", fontSize: 11 }}>
          clear
        </button>
      </p>
    );
  }

  if (status === "error") {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--risk-bad, #c0392b)" }}>
        {`HL: ${error ?? "execution failed"}`}
        <button onClick={reset} style={{ marginLeft: 8, background: "none", border: "none", cursor: "pointer", color: "var(--color-neutral-500)", fontSize: 11 }}>
          clear
        </button>
      </p>
    );
  }

  return (
    <>
      <button
        className="btn btn-primary"
        style={{ fontSize: 13, marginTop: 6, cursor: "pointer" }}
        onClick={() => setConfirming(true)}
        title={isConnected ? undefined : "Connect a wallet first"}
      >
        Open {side === "short" ? "short" : "long"} {symbol} on Hyperliquid {env} →
      </button>
      <ConfirmDialog
        open={confirming}
        title={`Confirm ${isBuy ? "long" : "short"} ${symbol} on Hyperliquid ${env}`}
        body={
          <div>
            Market order: {isBuy ? "long" : "short"} {symbol.toUpperCase()} ({fmtUsd(sizeUsd)}
            {leverage ? ` at ${leverage}x` : ""}) on Hyperliquid {env}.
            {hlQuote && coinQty !== undefined ? (
              <>
                {" "}
                ≈ <strong>{coinQty.toFixed(4)}</strong> {symbol.toUpperCase()} at ~$
                {hlPrice!.toFixed(2)} each. The order is signed with your wallet, then submitted
                to Hyperliquid.
              </>
            ) : (
              <> A live mid price will be fetched, the order signed with your wallet, then submitted to Hyperliquid.</>
            )}
          </div>
        }
        confirmLabel="Sign & submit"
        warning={env === "testnet" ? "TESTNET — no real funds." : "Mainnet — real funds. Confirm carefully."}
        onConfirm={() => {
          setConfirming(false);
          execute({ symbol, isBuy, sizeUsd, leverage, testnet: env === "testnet", coinQty });
        }}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

/**
 * Live Extended perp execution. Extended (ex-X10) is a StarkEx venue: orders
 * are signed with a Stark L2 key, not the connected wallet, so this needs a
 * connected Extended account (see ExtendedConnectPanel / useExtendedAccount)
 * rather than just a wallet connection. Not connected -> an honest NotWired
 * that says exactly what to do, same as every other unwired path here.
 */
export function ExtendedPerpExecuteButton({ leg, prices }: { leg: TradeLeg; prices?: PriceEntry[] }) {
  const signer = useExtendedAccount();
  const { status, result, error, execute, reset } = useExtendedPerp();
  const [confirming, setConfirming] = useState(false);

  const symbol = (leg.asset || "").replace(/PERP$/i, "").trim() || "ETH";
  const sizeUsd = leg.sizeUsd && leg.sizeUsd > 0 ? leg.sizeUsd : 1000;
  const side = (leg.side || "").toLowerCase();
  const isBuy = side.startsWith("long") || side === "buy";

  const price = resolvePriceFromList(prices, symbol);
  const coinQty = price !== null ? sizeUsd / price : undefined;

  const recordedRef = useRef<string | null>(null);
  useEffect(() => {
    if (status === "confirmed" && result && recordedRef.current !== "ok") {
      recordedRef.current = "ok";
      recordExecution({
        type: isBuy ? "buy" : "sell",
        label: `${isBuy ? "Long" : "Short"} ${symbol} (Extended)`,
        amount: result.qty,
        asset: symbol,
        protocol: "Extended",
        status: "confirmed",
      });
    } else if (status === "error" && recordedRef.current !== "error") {
      recordedRef.current = "error";
      recordExecution({
        type: isBuy ? "buy" : "sell",
        label: `${isBuy ? "Long" : "Short"} ${symbol} on Extended (failed)`,
        asset: symbol,
        protocol: "Extended",
        status: "error",
      });
    }
  }, [status, result, isBuy, symbol]);

  if (!signer) {
    return (
      <NotWired
        venue="Extended"
        reason="Connect your Extended account (API key + Stark key from extended.exchange → API management) in the Extended panel to trade this leg live."
      />
    );
  }

  if (status === "submitting") {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)" }}>
        Signing and submitting to Extended…
      </p>
    );
  }

  if (status === "confirmed" && result) {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-accent-700)" }}>
        Order on Extended {result.network}: {result.market} {JSON.stringify(result.order)}
        <button onClick={reset} style={{ marginLeft: 8, background: "none", border: "none", cursor: "pointer", color: "var(--color-neutral-500)", fontSize: 11 }}>
          clear
        </button>
      </p>
    );
  }

  if (status === "error") {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--risk-bad, #c0392b)" }}>
        {`Extended: ${error ?? "execution failed"}`}
        <button onClick={reset} style={{ marginLeft: 8, background: "none", border: "none", cursor: "pointer", color: "var(--color-neutral-500)", fontSize: 11 }}>
          clear
        </button>
      </p>
    );
  }

  return (
    <>
      <button
        className="btn btn-primary"
        style={{ fontSize: 13, marginTop: 6, cursor: "pointer" }}
        onClick={() => setConfirming(true)}
      >
        Open {side === "short" ? "short" : "long"} {symbol} on Extended {signer.network} →
      </button>
      <ConfirmDialog
        open={confirming}
        title={`Confirm ${isBuy ? "long" : "short"} ${symbol} on Extended ${signer.network}`}
        body={
          <div>
            IOC market order: {isBuy ? "long" : "short"} {symbol.toUpperCase()} ({fmtUsd(sizeUsd)}) on Extended{" "}
            {signer.network}, vault {signer.vaultId}.
            {coinQty !== undefined ? (
              <>
                {" "}
                ≈ <strong>{coinQty.toFixed(4)}</strong> {symbol.toUpperCase()} at ~${price!.toFixed(2)} each, signed
                with your Stark key and submitted directly to Extended.
              </>
            ) : (
              <> No live price for {symbol} yet — signing will be refused if one isn&apos;t available.</>
            )}
          </div>
        }
        confirmLabel="Sign & submit"
        warning={signer.network === "testnet" ? "TESTNET — no real funds." : "Mainnet — real funds. Confirm carefully."}
        onConfirm={() => {
          setConfirming(false);
          execute({ signer, symbol, isBuy, sizeUsd, prices });
        }}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

/**
 * Live Ondo / Lighter perp execution, via LI.FI's Perps SDK (see
 * lib/integrations/lifiPerps.ts for the architecture note on why order
 * placement here relays through LI.FI's backend rather than going purely
 * direct-to-venue like every other execute path in this file). Not connected
 * -> an honest NotWired pointing at the matching connect panel; mid-setup ->
 * a status line rather than a dead end.
 */
export function LifiPerpExecuteButton({ leg, prices, provider }: { leg: TradeLeg; prices?: PriceEntry[]; provider: LifiPerpsProviderId }) {
  const label = LIFI_PROVIDER_LABEL[provider];
  const ondoEnv = useSharedOndoEnv();
  const setup = useLifiPerpsSetup(provider);
  const { status, result, error, execute, reset } = useLifiPerpOrder(provider);
  const [confirming, setConfirming] = useState(false);

  const symbol = (leg.asset || "").replace(/PERP$/i, "").trim() || "ETH";
  const sizeUsd = leg.sizeUsd && leg.sizeUsd > 0 ? leg.sizeUsd : 1000;
  const side = (leg.side || "").toLowerCase();
  const isBuy = side.startsWith("long") || side === "buy";

  const price = resolvePriceFromList(prices, symbol);
  const coinQty = price !== null ? sizeUsd / price : undefined;

  const recordedRef = useRef<string | null>(null);
  useEffect(() => {
    if (status === "confirmed" && result && recordedRef.current !== "ok") {
      recordedRef.current = "ok";
      recordExecution({
        type: isBuy ? "buy" : "sell",
        label: `${isBuy ? "Long" : "Short"} ${symbol} (${label})`,
        asset: symbol,
        protocol: label,
        status: "confirmed",
      });
    } else if (status === "error" && recordedRef.current !== "error") {
      recordedRef.current = "error";
      recordExecution({
        type: isBuy ? "buy" : "sell",
        label: `${isBuy ? "Long" : "Short"} ${symbol} on ${label} (failed)`,
        asset: symbol,
        protocol: label,
        status: "error",
      });
    }
  }, [status, result, isBuy, symbol, label]);

  if (!setup.loading && !setup.isReady) {
    return (
      <NotWired
        venue={label}
        reason={`Connect and fund ${label} in the ${label} panel to trade this leg live.`}
      />
    );
  }
  if (setup.loading) {
    return <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)" }}>Checking your {label} account…</p>;
  }

  if (status === "submitting") {
    return <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)" }}>Signing and submitting to {label}…</p>;
  }

  if (status === "confirmed" && result) {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-accent-700)" }}>
        Order on {label}: {JSON.stringify(result.results)}
        <button onClick={reset} style={{ marginLeft: 8, background: "none", border: "none", cursor: "pointer", color: "var(--color-neutral-500)", fontSize: 11 }}>
          clear
        </button>
      </p>
    );
  }

  if (status === "error") {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--risk-bad, #c0392b)" }}>
        {`${label}: ${error ?? "execution failed"}`}
        <button onClick={reset} style={{ marginLeft: 8, background: "none", border: "none", cursor: "pointer", color: "var(--color-neutral-500)", fontSize: 11 }}>
          clear
        </button>
      </p>
    );
  }

  return (
    <>
      <button
        className="btn btn-primary"
        style={{ fontSize: 13, marginTop: 6, cursor: "pointer" }}
        onClick={() => setConfirming(true)}
      >
        Open {side === "short" ? "short" : "long"} {symbol} on {label} →
      </button>
      <ConfirmDialog
        open={confirming}
        title={`Confirm ${isBuy ? "long" : "short"} ${symbol} on ${label}`}
        body={
          <div>
            Market order: {isBuy ? "long" : "short"} {symbol.toUpperCase()} ({fmtUsd(sizeUsd)}) on {label}.
            {coinQty !== undefined ? (
              <>
                {" "}
                ≈ <strong>{coinQty.toFixed(4)}</strong> {symbol.toUpperCase()} at ~${price!.toFixed(2)} each. Signed
                locally, then relayed to {label} via LI.FI.
              </>
            ) : (
              <> No live price for {symbol} yet — signing will be refused if one isn&apos;t available.</>
            )}
          </div>
        }
        confirmLabel="Sign & submit"
        warning={provider === "ondo" && ondoEnv === "sandbox" ? "SANDBOX — no real funds." : "Real funds. Confirm carefully."}
        onConfirm={() => {
          setConfirming(false);
          execute({ symbol, isBuy, sizeUsd, prices });
        }}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
