"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useBalance, useSimulateContract } from "wagmi";
import type { StakeYieldEntry } from "@/app/api/stake-yield/route";
import { ThreadItem, fmtUsd } from "@/lib/data";
import { resolveOrderForLeg, protocolLabel, approveOrderFor, findToken, DEFAULT_CHAIN_ID } from "@/lib/assetMap";
import { CHAIN_LABEL, STETH_ADDRESS } from "@/lib/onchain";
import type { Order } from "@/lib/execution";
import type { TradeLeg } from "@/lib/tradePlan";
import { useExecute, explorerUrlFor } from "@/hooks/useExecute";
import { useHyperliquid } from "@/hooks/useHyperliquid";
import { useSharedHlEnv } from "@/hooks/useHyperliquidEnv";
import { useExtendedAccount } from "@/hooks/useExtendedAccount";
import { useExtendedPerp } from "@/hooks/useExtendedPerp";
import { useLifiPerpsSetup } from "@/hooks/useLifiPerpsSetup";
import { useLifiPerpOrder } from "@/hooks/useLifiPerpOrder";
import { LIFI_PROVIDER_LABEL, type LifiPerpsProviderId } from "@/lib/integrations/lifiPerps";
import { useIndexedPositions } from "@/hooks/useIndexedPositions";
import { useLivePrices } from "@/hooks/useLivePrices";
import { useVaultRisk } from "@/hooks/useVaultRisk";
import { PHILIDOR_PROTOCOL_ID, type RiskTier } from "@/lib/integrations/philidor";
import { MIN_MORPHO_RISK_SCORE } from "@/lib/integrations/morpho";
import {
  QUOTER_V2_QUOTE_EXACT_INPUT_SINGLE_ABI,
  UNISWAP_QUOTER_V2_BY_CHAIN,
  applySlippage,
  defaultFeeTier,
  parseSwapAsset,
} from "@/lib/integrations/uniswap";
import { formatBaseUnits, resolvePriceFromList, usdToTokenAmount, type PriceEntry } from "@/lib/quote";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { assessHealthFactorGuardrail } from "@/lib/safety";
import { recordExecution, type OrderRecordType } from "@/lib/history";

/** Map an execution Order type to a coarse history record type. */
function recordTypeFor(orderType: string): OrderRecordType {
  switch (orderType) {
    case "supply":
    case "stake":
      return "deposit";
    case "repay":
    case "borrow":
    case "withdraw":
    case "transfer":
      return "withdraw";
    case "swap":
      return "swap";
    default:
      return "custom";
  }
}

function UserBubble({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        alignSelf: "flex-end",
        maxWidth: "80%",
        background: "var(--color-surface)",
        border: "1px solid var(--color-divider)",
        borderRadius: "var(--radius-md)",
        padding: "var(--space-2) var(--space-3)",
      }}
    >
      <p style={{ margin: 0, fontSize: 14 }}>{children}</p>
    </div>
  );
}

function OrderRow({ label, value, valueColor }: { label: string; value: React.ReactNode; valueColor?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span className="text-muted">{label}</span>
      <span style={{ color: valueColor }}>{value}</span>
    </div>
  );
}

/**
 * Honest "not wired yet" — never fakes a success for a venue the harness
 * can't sign. Styled to visually read as unavailable (dashed border, muted
 * background) with a "Building" tag, so it's obvious at a glance before
 * reading the text.
 */
function NotWired({ venue, reason }: { venue: string; reason: string }) {
  return (
    <div
      style={{
        margin: "6px 0 0",
        padding: "6px 8px",
        borderRadius: 6,
        border: "1px dashed var(--color-divider)",
        background: "var(--color-neutral-100)",
        display: "flex",
        flexDirection: "column",
        gap: 3,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span className="tag tag-neutral" style={{ fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase" }}>
          Building
        </span>
        <span style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>{venue} isn&apos;t live yet</span>
      </div>
      <span className="text-muted" style={{ fontSize: 11 }}>
        {reason}
      </span>
    </div>
  );
}

/**
 * Real Execute button. Uses the wagmi harness (`useExecute`): on click it builds
 * the order and asks the wallet to sign (Aave v3 supply/repay, native transfer).
 * Renders the true wallet state — idle / awaiting signature / confirmed (linked
 * to the block explorer by chainId) / error. Execution only ever happens on this
 * explicit click; the harness never auto-submits.
 */
function ExecuteButton({ order, label }: { order: Order; label: string }) {
  const { isConnected } = useAccount();
  const { status, data, error, execute, reset } = useExecute();
  const [confirming, setConfirming] = useState(false);
  const recordedRef = useRef<string | null>(null);

  // Health-factor guardrail for REAL-money Aave borrow/withdraw. No live health
  // factor is available at signing time in this harness, so the helper honestly
  // reports computable=false and requires an explicit extra confirmation for
  // any HF-lowering action. The ConfirmDialog surfaces that warning.
  const guardrail = useMemo(() => assessHealthFactorGuardrail({ orderType: order.type }), [order.type]);

  // Log real outcomes to the local order-history store (guarded so a render
  // doesn't double-record the same hash).
  useEffect(() => {
    if (status === "confirmed" && data && recordedRef.current !== data) {
      recordedRef.current = data;
      recordExecution({
        type: recordTypeFor(order.type),
        label: `Signed ${order.type}${order.symbol ? " " + order.symbol : ""}`,
        amount: typeof order.amount === "bigint" ? formatBaseUnits(order.amount, order.decimals ?? 18) : String(order.amount),
        asset: order.symbol,
        protocol: String(order.protocol),
        chainId: order.chainId,
        status: "confirmed",
        hash: data,
      });
    } else if (status === "error" && recordedRef.current !== "error") {
      recordedRef.current = "error";
      recordExecution({
        type: recordTypeFor(order.type),
        label: `${order.type}${order.symbol ? " " + order.symbol : ""} (failed)`,
        amount: typeof order.amount === "bigint" ? formatBaseUnits(order.amount, order.decimals ?? 18) : String(order.amount),
        asset: order.symbol,
        protocol: String(order.protocol),
        chainId: order.chainId,
        status: "error",
      });
    }
  }, [status, data, error, order]);

  if (status === "confirming") {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)" }}>
        Awaiting wallet signature…
      </p>
    );
  }

  if (status === "confirmed" && data) {
    const url = explorerUrlFor(order.chainId, data);
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-accent-700)" }}>
        Signed onchain ·{" "}
        <a href={url} target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "underline" }}>
          view {data.slice(0, 10)}…
        </a>
        <button onClick={reset} style={{ marginLeft: 8, background: "none", border: "none", cursor: "pointer", color: "var(--color-neutral-500)", fontSize: 11 }}>
          clear
        </button>
      </p>
    );
  }

  if (status === "error") {
    const raw = error instanceof Error ? error.message : String(error);
    const msg =
      raw === "wallet not connected"
        ? "Connect a wallet to execute"
        : /reject|declined|user denied|4001/i.test(raw)
          ? "Signature rejected in your wallet."
          : `Transaction failed: ${raw}`;
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--risk-bad, #c0392b)" }}>
        {msg}
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
        {label}
      </button>
      <ConfirmDialog
        open={confirming}
        title={
          order.protocol === "aave" && order.type === "supply"
            ? "Approve & Supply on Aave"
            : order.protocol === "aave" && order.type === "withdraw"
              ? "Withdraw from Aave"
              : order.protocol === "lido" && order.type === "stake"
                ? "Stake on Lido"
                : order.protocol === "lido" && order.type === "unstake"
                  ? "Approve & Request Withdrawal on Lido"
                  : order.protocol === "lido" && order.type === "claim"
                    ? "Claim Lido Withdrawal"
                    : order.protocol === "uniswap" && order.type === "swap"
                      ? "Approve & Swap on Uniswap"
                      : order.protocol === "morpho" && order.type === "supply"
                        ? "Approve & Deposit on Morpho"
                        : order.protocol === "morpho" && order.type === "withdraw"
                          ? "Withdraw from Morpho"
                          : "Confirm on-chain action"
        }
        body={
          <div>
            Sign and broadcast <strong>{order.type}</strong> of{" "}
            {typeof order.amount === "bigint"
              ? formatBaseUnits(order.amount, order.decimals ?? 18)
              : String(order.amount)}{" "}
            {order.symbol ?? ""} on {String(order.protocol)} ·{" "}
            {CHAIN_LABEL[order.chainId] ?? `chain ${order.chainId}`}.
            {order.protocol === "aave" && order.type === "supply" && (
              <> This will first <strong>approve</strong> Aave to spend the token, then <strong>supply</strong> it.</>
            )}
            {order.protocol === "lido" && order.type === "stake" && (
              <> This sends ETH directly to Lido and mints <strong>stETH</strong> 1:1 — no separate approval step.</>
            )}
            {order.protocol === "uniswap" && order.type === "swap" && (
              <>
                {" "}
                This will first <strong>approve</strong> the Uniswap router, then <strong>swap</strong>, enforcing the
                minimum-received amount previewed above (0.5% slippage from a live quote).
              </>
            )}
            {order.protocol === "morpho" && order.type === "supply" && (
              <>
                {" "}
                This will first <strong>approve</strong> the vault previewed above, then <strong>deposit</strong> into it.
              </>
            )}
            {order.protocol === "morpho" && order.type === "withdraw" && (
              <> This withdraws directly from the vault back to your wallet — no approval step needed.</>
            )}
            {order.protocol === "lido" && order.type === "unstake" && (
              <>
                {" "}
                This will first <strong>approve</strong> Lido&apos;s withdrawal queue, then lock your stETH into a{" "}
                <strong>withdrawal request</strong>. It is not instant — Lido&apos;s oracle finalizes requests
                (typically a few days), after which you can claim the ETH from the Lido panel.
              </>
            )}
            {order.protocol === "lido" && order.type === "claim" && (
              <> Sends the finalized ETH from this request straight to your wallet.</>
            )}
          </div>
        }
        confirmLabel={
          order.protocol === "aave" && order.type === "supply"
            ? "Approve & Supply"
            : order.protocol === "uniswap" && order.type === "swap"
              ? "Approve & Swap"
              : order.protocol === "morpho" && order.type === "supply"
                ? "Approve & Deposit"
                : order.protocol === "lido" && order.type === "unstake"
                  ? "Approve & Request Withdrawal"
                  : order.protocol === "lido" && order.type === "claim"
                    ? "Claim ETH"
                    : "Sign"
        }
        warning="This moves real funds from your wallet."
        guardrail={guardrail}
        onConfirm={async () => {
          setConfirming(false);
          const approving = approveOrderFor(order);
          if (approving) await execute(approving);
          await execute(order);
        }}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

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
function PerpExecuteButton({ leg, prices }: { leg: TradeLeg; prices?: PriceEntry[] }) {
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
function ExtendedPerpExecuteButton({ leg, prices }: { leg: TradeLeg; prices?: PriceEntry[] }) {
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
function LifiPerpExecuteButton({ leg, prices, provider }: { leg: TradeLeg; prices?: PriceEntry[]; provider: LifiPerpsProviderId }) {
  const label = LIFI_PROVIDER_LABEL[provider];
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
        warning="Real funds. Confirm carefully."
        onConfirm={() => {
          setConfirming(false);
          execute({ symbol, isBuy, sizeUsd, prices });
        }}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

/**
 * Live Uniswap v3 swap execution. Unlike Aave/Lido (whose amount is sized
 * purely from a REST price feed), a swap's `amountOutMinimum` can only come
 * from a real on-chain quote (QuoterV2.quoteExactInputSingle) taken right
 * before signing — so this bypasses `resolveOrderForLeg`'s pure/offline
 * result for "swap" legs (mirrors how PerpExecuteButton bypasses it for
 * Hyperliquid's live mid-price). Once the quote lands, execution itself
 * (approve + exactInputSingle) reuses the existing ExecuteButton — same
 * confirm dialog, same idempotency guard, same honest error handling.
 */
function SwapExecuteButton({ leg, prices }: { leg: TradeLeg; prices?: PriceEntry[] }) {
  const { chain } = useAccount();
  const chainId = chain?.id ?? DEFAULT_CHAIN_ID;

  const parsed = parseSwapAsset(leg.asset);
  const tokenIn = parsed ? findToken(parsed.from, chainId) : undefined;
  const tokenOut = parsed ? findToken(parsed.to, chainId) : undefined;
  const fee = tokenIn && tokenOut ? defaultFeeTier(tokenIn.symbol, tokenOut.symbol) : undefined;

  const price = tokenIn ? resolvePriceFromList(prices, tokenIn.symbol) : null;
  const inQuote = tokenIn ? usdToTokenAmount(tokenIn.symbol, leg.sizeUsd, price, tokenIn.decimals) : null;

  const quoterAddress = UNISWAP_QUOTER_V2_BY_CHAIN[chainId];
  const quoteEnabled = !!(tokenIn && tokenOut && fee && inQuote && quoterAddress);
  const {
    data: sim,
    isLoading: quoting,
    error: quoteError,
  } = useSimulateContract({
    address: quoterAddress,
    abi: QUOTER_V2_QUOTE_EXACT_INPUT_SINGLE_ABI,
    functionName: "quoteExactInputSingle",
    args:
      tokenIn && tokenOut && fee !== undefined && inQuote
        ? [{ tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn: inQuote.amountBase, fee, sqrtPriceLimitX96: BigInt(0) }]
        : undefined,
    chainId,
    query: { enabled: quoteEnabled },
  });

  if (!parsed) {
    return <NotWired venue="Uniswap" reason={`Could not parse a swap pair from "${leg.asset}".`} />;
  }
  if (!tokenIn || !tokenOut) {
    const missing = !tokenIn ? parsed.from : parsed.to;
    return (
      <NotWired
        venue="Uniswap"
        reason={`"${missing}" has no tracked address on ${CHAIN_LABEL[chainId] ?? `chain ${chainId}`}.`}
      />
    );
  }
  if (!quoterAddress) {
    return <NotWired venue="Uniswap" reason={`Uniswap v3 is not supported on ${CHAIN_LABEL[chainId] ?? `chain ${chainId}`}.`} />;
  }
  if (!inQuote) {
    return <NotWired venue="Uniswap" reason={`No live price for ${tokenIn.symbol} — cannot size this order safely.`} />;
  }
  if (quoteError) {
    return <NotWired venue="Uniswap" reason="Could not fetch a live quote from Uniswap right now." />;
  }
  if (quoting || !sim) {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)" }}>Fetching live Uniswap quote…</p>
    );
  }

  const amountOut = sim.result[0];
  const amountOutMinimum = applySlippage(amountOut);

  const order: Order = {
    type: "swap",
    protocol: "uniswap",
    token: tokenIn.address,
    tokenOut: tokenOut.address,
    fee,
    amount: inQuote.amountBase,
    amountOutMinimum,
    chainId,
    decimals: tokenIn.decimals,
    symbol: tokenIn.symbol,
  };

  return (
    <>
      <OrderRow
        label="Min received"
        value={`${formatBaseUnits(amountOutMinimum, tokenOut.decimals)} ${tokenOut.symbol}`}
        valueColor="var(--color-accent-700)"
      />
      <ExecuteButton order={order} label="Swap on Uniswap →" />
    </>
  );
}

/**
 * Live Morpho vault deposit. Morpho Blue has no single canonical pool like
 * Aave — deposits go into one of hundreds of MetaMorpho vaults, each its own
 * ERC-4626 contract. Rather than hardcode a curated vault list, this resolves
 * the vault to deposit into at execute-time from Philidor's live risk data
 * (same source as the Vault Risk panel / LegRiskBadge), scoped to the
 * connected wallet's chain so no network-switch flow is needed, and gated to
 * MIN_MORPHO_RISK_SCORE so a low-scoring (Edge-tier) vault is never silently
 * picked for a one-click deposit. Once resolved, execution (approve +
 * deposit) reuses the existing ExecuteButton, same as SwapExecuteButton does.
 */
function MorphoExecuteButton({ leg, prices }: { leg: TradeLeg; prices?: PriceEntry[] }) {
  const { chain } = useAccount();
  const chainId = chain?.id ?? DEFAULT_CHAIN_ID;
  const chainName = CHAIN_LABEL[chainId];
  const symbol = (leg.asset || "").trim();

  const { data: vaults, isLoading } = useVaultRisk({
    protocol: "Morpho",
    asset: symbol || undefined,
    chain: chainName,
    limit: 1,
    enabled: !!symbol && !!chainName,
  });
  const vault = vaults?.[0];

  const token = findToken(symbol, chainId);
  const price = token ? resolvePriceFromList(prices, token.symbol) : null;
  const quote = token ? usdToTokenAmount(token.symbol, leg.sizeUsd, price, token.decimals) : null;

  if (!chainName) {
    return <NotWired venue="Morpho" reason={`Chain ${chainId} is not supported for Morpho vault deposits.`} />;
  }
  if (isLoading) {
    return <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)" }}>Finding the best-rated Morpho {symbol} vault…</p>;
  }
  if (!vault) {
    return (
      <NotWired
        venue="Morpho"
        reason={`No live Morpho ${symbol} vault found on ${chainName} — try another asset or switch networks.`}
      />
    );
  }
  if (vault.riskScore < MIN_MORPHO_RISK_SCORE) {
    return (
      <NotWired
        venue="Morpho"
        reason={`The best available Morpho ${symbol} vault on ${chainName} scores ${vault.riskScore.toFixed(1)}/10 (${vault.riskTier}) — below Meridian's ${MIN_MORPHO_RISK_SCORE}/10 floor for one-click deposits.`}
      />
    );
  }
  if (!vault.address || !vault.assetAddress) {
    return <NotWired venue="Morpho" reason="Live vault data is missing an on-chain address — cannot build a safe order." />;
  }
  if (!token) {
    return <NotWired venue="Morpho" reason={`"${symbol}" has no tracked address on ${chainName}.`} />;
  }
  if (!quote) {
    return <NotWired venue="Morpho" reason={`No live price for ${symbol} — cannot size this order safely.`} />;
  }

  const order: Order = {
    type: "supply",
    protocol: "morpho",
    token: token.address,
    vaultAddress: vault.address as `0x${string}`,
    amount: quote.amountBase,
    chainId,
    decimals: token.decimals,
    symbol: token.symbol,
  };

  return (
    <>
      <OrderRow label="Vault" value={vault.name} />
      <OrderRow label="Risk" value={`${vault.riskTier} · ${vault.riskScore.toFixed(1)}/10 (Philidor)`} valueColor={RISK_TIER_COLOR[vault.riskTier]} />
      <ExecuteButton order={order} label="Deposit on Morpho →" />
    </>
  );
}

/**
 * Live Morpho vault withdrawal. Unlike supply (which picks a NEW vault via
 * live Philidor risk data), withdraw needs to find the vault the user is
 * ALREADY in — read from the official Morpho indexer (same one
 * useLivePortfolio uses for read-only display, see useIndexedPositions). An
 * unspecified amount withdraws the full position; a requested amount is
 * capped to it — never over-withdraws, since capping down is always safe
 * but guessing up could try to pull more than the vault holds. No approval
 * step: ERC-4626 withdraw needs no allowance when receiver/owner are both
 * the caller, which is the only shape Meridian ever builds.
 */
function MorphoWithdrawButton({ leg, prices }: { leg: TradeLeg; prices?: PriceEntry[] }) {
  const { chain, address } = useAccount();
  const chainId = chain?.id ?? DEFAULT_CHAIN_ID;
  const symbol = (leg.asset || "").trim();

  const { vaults, loading } = useIndexedPositions(address, !!address);

  if (!address) {
    return <NotWired venue="Morpho" reason="Connect a wallet to withdraw." />;
  }
  if (loading) {
    return <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)" }}>Finding your Morpho position…</p>;
  }

  const candidates = vaults.filter((v) => v.assetSymbol.toUpperCase() === symbol.toUpperCase() && v.chainId === chainId);
  const position = candidates.sort((a, b) => b.assetsUsd - a.assetsUsd)[0];
  if (!position) {
    return (
      <NotWired
        venue="Morpho"
        reason={`No Morpho ${symbol} position found on ${CHAIN_LABEL[chainId] ?? `chain ${chainId}`} to withdraw from.`}
      />
    );
  }

  const positionAssets = BigInt(position.assets);
  const price = resolvePriceFromList(prices, symbol);
  const requestedQuote = leg.sizeUsd && price ? usdToTokenAmount(symbol, leg.sizeUsd, price, position.assetDecimals) : null;
  // Cap to the real position — never withdraw more than it holds. No
  // explicit amount (or no live price to size one) means "withdraw everything".
  const amountBase = requestedQuote && requestedQuote.amountBase < positionAssets ? requestedQuote.amountBase : positionAssets;

  if (amountBase <= BigInt(0)) {
    return <NotWired venue="Morpho" reason="Nothing to withdraw from this position." />;
  }

  const order: Order = {
    type: "withdraw",
    protocol: "morpho",
    token: position.assetAddress as `0x${string}`,
    vaultAddress: position.vaultAddress as `0x${string}`,
    amount: amountBase,
    chainId,
    decimals: position.assetDecimals,
    symbol,
  };

  return (
    <>
      <OrderRow label="Vault" value={position.vaultName} />
      <OrderRow
        label="Withdrawing"
        value={`${formatBaseUnits(amountBase, position.assetDecimals)} of ${formatBaseUnits(positionAssets, position.assetDecimals)} ${symbol}`}
      />
      <ExecuteButton order={order} label="Withdraw from Morpho →" />
    </>
  );
}

/**
 * Live Lido unstake — the REQUEST half only. Locks stETH into Lido's
 * withdrawal queue (see lib/integrations/lido.ts); the queue is not instant
 * (Lido's oracle finalizes requests over time), so this alone doesn't
 * return ETH — see LidoWithdrawalsPanel for viewing status and claiming
 * once finalized. Sized off the connected wallet's real stETH balance
 * (read live), capped the same way Morpho withdraw is: an unspecified
 * amount requests the full balance; a requested amount is capped to it.
 */
function LidoUnstakeButton({ leg, prices }: { leg: TradeLeg; prices?: PriceEntry[] }) {
  const { chain, address } = useAccount();
  const chainId = chain?.id ?? DEFAULT_CHAIN_ID;
  const { data: balance, isLoading } = useBalance({
    address,
    token: STETH_ADDRESS,
    chainId: 1,
    query: { enabled: !!address },
  });

  if (!address) {
    return <NotWired venue="Lido" reason="Connect a wallet to unstake." />;
  }
  if (chainId !== 1) {
    return <NotWired venue="Lido" reason="Lido unstaking is only wired on Ethereum mainnet — switch networks." />;
  }
  if (isLoading) {
    return <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)" }}>Reading your stETH balance…</p>;
  }

  const positionWei = balance?.value ?? BigInt(0);
  if (positionWei <= BigInt(0)) {
    return <NotWired venue="Lido" reason="No stETH balance found to unstake." />;
  }

  // stETH tracks ETH ~1:1 — reuse the live ETH price to size a requested USD amount.
  const price = resolvePriceFromList(prices, "ETH");
  const requestedQuote = leg.sizeUsd && price ? usdToTokenAmount("ETH", leg.sizeUsd, price, 18) : null;
  const amountBase = requestedQuote && requestedQuote.amountBase < positionWei ? requestedQuote.amountBase : positionWei;

  const order: Order = {
    type: "unstake",
    protocol: "lido",
    token: STETH_ADDRESS,
    amount: amountBase,
    chainId: 1,
    decimals: 18,
    symbol: "stETH",
  };

  return (
    <>
      <OrderRow
        label="Requesting"
        value={`${formatBaseUnits(amountBase, 18)} of ${formatBaseUnits(positionWei, 18)} stETH`}
      />
      <ExecuteButton order={order} label="Request withdrawal on Lido →" />
    </>
  );
}

function legRowValue(leg: { asset: string; protocol: string; sizeUsd?: number; leverage?: number }): string {
  return `${leg.asset} · ${leg.protocol}${leg.sizeUsd ? ` · ${fmtUsd(leg.sizeUsd)}` : ""}${leg.leverage ? ` · ${leg.leverage}x` : ""}`;
}

const RISK_TIER_COLOR: Record<RiskTier, string> = {
  Prime: "var(--risk-good)",
  Core: "var(--risk-warning)",
  Edge: "var(--risk-serious)",
};

/**
 * Live vault risk score (Philidor, free API — see lib/integrations/philidor.ts)
 * for a leg's protocol + asset, e.g. supplying USDC on Aave. Only queries for
 * protocols Philidor scores and plain single-token asset symbols (skips
 * PT/perp/swap legs whose `asset` isn't a bare symbol); renders nothing when
 * there is no match or the upstream is unavailable.
 */
function LegRiskBadge({ leg }: { leg: TradeLeg }) {
  const protocolId = PHILIDOR_PROTOCOL_ID[leg.protocol];
  const plainAsset = /^[A-Za-z]{2,10}$/.test(leg.asset) ? leg.asset : undefined;
  const enabled = !!protocolId && !!plainAsset;
  const { data } = useVaultRisk({ protocol: leg.protocol, asset: plainAsset, limit: 1, enabled });
  const top = data?.[0];
  if (!enabled || !top) return null;
  return (
    <OrderRow
      label="Vault risk"
      value={`${top.riskTier} · ${top.riskScore.toFixed(1)}/10 (Philidor)`}
      valueColor={RISK_TIER_COLOR[top.riskTier]}
    />
  );
}

/**
 * Live best-yield comparison for an ETH staking leg (DefiLlama, free API —
 * `/api/stake-yield`): ranks Lido against the other liquid-staking protocols
 * DefiLlama tracks. Meridian only has live EXECUTION wired for Lido, so this
 * is honest rather than a routing decision — when a competitor's live rate is
 * actually higher, it says so instead of silently staking into Lido anyway.
 * Renders nothing for a non-ETH / non-stake leg, or when the feed is empty.
 */
function StakeYieldBadge({ leg }: { leg: TradeLeg }) {
  const isEthStake = leg.side.toLowerCase() === "stake" && /^(ETH|stETH)$/i.test(leg.asset.trim());
  const { data } = useQuery<StakeYieldEntry[]>({
    queryKey: ["stake-yield"],
    queryFn: async () => {
      const res = await fetch("/api/stake-yield");
      if (!res.ok) throw new Error("stake-yield fetch failed");
      return res.json();
    },
    enabled: isEthStake,
    staleTime: 5 * 60_000,
  });
  if (!isEthStake || !data || data.length === 0) return null;

  const best = data[0];
  const lido = data.find((d) => d.protocol === "Lido");
  const lidoIsBest = best.protocol === "Lido";

  return (
    <OrderRow
      label="Live staking yield"
      value={
        lidoIsBest || !lido
          ? `Lido ${(lido ?? best).apy.toFixed(2)}% APY (best live rate)`
          : `Lido ${lido.apy.toFixed(2)}% — ${best.protocol} offers ${best.apy.toFixed(2)}% but isn't wired for live execution`
      }
      valueColor={lidoIsBest || !lido ? "var(--risk-good)" : "var(--risk-warning)"}
    />
  );
}

/**
 * Type predicate to disambiguate an unsupported result from an `Order`. `Order`
 * carries a `[k: string]: unknown` index signature, so a bare `"unsupported" in r`
 * check cannot narrow it — this predicate gives TS an explicit narrowing on both
 * branches (true → `{ unsupported: string }`, false → `Order`).
 */
function isUnsupported(r: Order | { unsupported: string }): r is { unsupported: string } {
  return "unsupported" in r && typeof r.unsupported === "string";
}

/** Order card rendered from a parsed TradePlan when item.plan is present. */
function PlanCard({ item }: { item: ThreadItem }) {
  const plan = item.plan!;
  // Live price list used to quote each leg's USD notional into an exact token amount.
  const { data: prices } = useLivePrices();
  // Connected chain routes Aave legs to the wallet's network (multi-EVM execution).
  const { chain } = useAccount();
  const orderStyle: React.CSSProperties = {
    borderLeft: "2px solid var(--color-accent)",
    paddingLeft: "var(--space-2)",
    fontSize: 13,
  };

  // Exact human token amount for an already-quoted Order (single source of truth).
  const orderAmountDisplay = (order: Order): string =>
    typeof order.amount === "bigint"
      ? `${formatBaseUnits(order.amount, order.decimals ?? 18)} ${order.symbol ?? ""}`
      : `${String(order.amount)} ${order.symbol ?? ""}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <UserBubble>{item.text || "Describe your thesis."}</UserBubble>
      <div style={{ maxWidth: "90%" }}>
        <p style={{ margin: "0 0 6px", fontSize: 14 }}>{plan.summary}</p>
        {plan.legs.length > 0 && (
          <div style={orderStyle}>
            {plan.legs.map((leg, i) => {
              const resolved = resolveOrderForLeg(leg, undefined, prices, chain?.id);
              const legSide = (leg.side || "").toLowerCase();
              const isMorpho = /morpho/i.test(leg.protocol || "");
              const isLidoWithdraw = /lido/i.test(leg.protocol || "") && legSide === "withdraw";
              // These venues resolve their own live execution path (a fresh
              // on-chain quote, a live vault/position lookup, ...) even when
              // resolveOrderForLeg's pure/offline pass can't build the order
              // itself — see PerpExecuteButton/ExtendedPerpExecuteButton/
              // LifiPerpExecuteButton/SwapExecuteButton/MorphoExecuteButton/
              // MorphoWithdrawButton/LidoUnstakeButton.
              const liveVenue =
                /hyperliquid|extended|ondo|lighter|uniswap/i.test(leg.protocol || "") || isMorpho || isLidoWithdraw;
              const building = isUnsupported(resolved) && !liveVenue;
              return (
                <div key={i} style={{ marginTop: i === 0 ? 0 : "var(--space-2)", opacity: building ? 0.55 : 1 }}>
                  <OrderRow label={leg.side} value={legRowValue(leg)} />
                  <LegRiskBadge leg={leg} />
                  <StakeYieldBadge leg={leg} />
                  {isUnsupported(resolved) ? (
                    /hyperliquid/i.test(leg.protocol || "") ? (
                      <PerpExecuteButton leg={leg} prices={prices} />
                    ) : /extended/i.test(leg.protocol || "") ? (
                      <ExtendedPerpExecuteButton leg={leg} prices={prices} />
                    ) : /ondo/i.test(leg.protocol || "") ? (
                      <LifiPerpExecuteButton leg={leg} prices={prices} provider="ondo" />
                    ) : /lighter/i.test(leg.protocol || "") ? (
                      <LifiPerpExecuteButton leg={leg} prices={prices} provider="lighter" />
                    ) : /uniswap/i.test(leg.protocol || "") ? (
                      <SwapExecuteButton leg={leg} prices={prices} />
                    ) : isMorpho ? (
                      legSide === "withdraw" ? <MorphoWithdrawButton leg={leg} prices={prices} /> : <MorphoExecuteButton leg={leg} prices={prices} />
                    ) : isLidoWithdraw ? (
                      <LidoUnstakeButton leg={leg} prices={prices} />
                    ) : (
                      <NotWired venue={protocolLabel(leg.protocol)} reason={resolved.unsupported} />
                    )
                  ) : (
                    <>
                      <OrderRow label="Amount" value={orderAmountDisplay(resolved)} valueColor="var(--color-accent-700)" />
                      <ExecuteButton order={resolved} label={`Execute on ${leg.protocol} →`} />
                    </>
                  )}
                </div>
              );
            })}
            {plan.legs.some((l) => l.note) && (
              <OrderRow label="Note" value={plan.legs.map((l) => l.note).filter(Boolean).join(" · ")} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function ThreadCard({ item }: { item: ThreadItem }) {
  // Every ThreadItem reaching this component is built by routeThesis() (typed
  // prompts, quick-prompt buttons, and news/alpha "discuss" links all go
  // through it now), which always attaches a `.plan` — so this always
  // resolves to the dynamic, live-execution-status-accurate PlanCard. The
  // fallback below is a defensive guard for the (currently theoretical)
  // case of a plan-less ThreadItem — `plan` is optional in the type, so
  // something could construct one without it.
  if (item.plan) {
    return <PlanCard item={item} />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <UserBubble>{item.text}</UserBubble>
      <div style={{ maxWidth: "90%" }}>
        <p style={{ margin: 0, fontSize: 14 }}>
          I can be most precise on fixed yield locks, beta neutral pairs, directional perps, swaps, and portfolio
          hedges. Try one of the quick prompts below, or rephrase your thesis with one of those in mind.
        </p>
      </div>
    </div>
  );
}
