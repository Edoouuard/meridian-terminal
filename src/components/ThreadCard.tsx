"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useBalance, useSimulateContract } from "wagmi";
import type { StakeYieldEntry } from "@/app/api/stake-yield/route";
import { ThreadItem, fmtUsd } from "@/lib/data";
import { resolveOrderForLeg, protocolLabel, approveOrderFor, findToken, DEFAULT_CHAIN_ID } from "@/lib/assetMap";
import { CHAIN_LABEL, STETH_ADDRESS } from "@/lib/onchain";
import type { Order } from "@/lib/execution";
import type { TradeLeg, TradePlan } from "@/lib/tradePlan";
import { useExecute, explorerUrlFor, type UseExecuteResult } from "@/hooks/useExecute";
import { useStrategyExecutor, type LegStatus } from "@/hooks/useStrategyExecutor";
import { useHyperliquid } from "@/hooks/useHyperliquid";
import { useSharedHlEnv } from "@/hooks/useHyperliquidEnv";
import { useExtendedAccount } from "@/hooks/useExtendedAccount";
import { useExtendedPerp } from "@/hooks/useExtendedPerp";
import { useLifiPerpsSetup } from "@/hooks/useLifiPerpsSetup";
import { useLifiPerpOrder } from "@/hooks/useLifiPerpOrder";
import { LIFI_PROVIDER_LABEL, type LifiPerpsProviderId } from "@/lib/integrations/lifiPerps";
import { useSharedOndoEnv } from "@/hooks/useOndoEnv";
import { useIndexedPositions } from "@/hooks/useIndexedPositions";
import { useLivePrices } from "@/hooks/useLivePrices";
import { useVaultRisk } from "@/hooks/useVaultRisk";
import { useBestYield } from "@/hooks/useBestYield";
import { useHlpApr, useLlpApr } from "@/hooks/useVaultYields";
import type { BestYieldEntry } from "@/app/api/best-yield/route";
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

/** Human-readable confirm dialog title for an order. */
function confirmTitle(order: Order): string {
  const p = order.protocol;
  const t = order.type;
  const label = p === "aave" ? "Aave" : p === "spark" ? "Spark" : p === "compound" ? "Compound"
    : p === "morpho" ? "Morpho" : p === "lido" ? "Lido" : p === "uniswap" ? "Uniswap"
    : p === "maker" ? "Maker DSR" : p === "rocketpool" ? "Rocket Pool" : p === "frax" ? "Frax"
    : p === "weth" ? "WETH" : p === "erc20" ? "Token" : p === "eth" ? "Native" : String(p);
  if (t === "supply" && (p === "aave" || p === "spark" || p === "compound" || p === "morpho" || p === "maker")) return `Approve & Supply on ${label}`;
  if (t === "stake" && p === "lido") return "Stake on Lido";
  if (t === "stake" && p === "rocketpool") return "Stake on Rocket Pool";
  if (t === "stake" && p === "frax") return "Stake on Frax";
  if (t === "unstake") return `Approve & Unstake on ${label}`;
  if (t === "claim") return `Claim ${label} Withdrawal`;
  if (t === "swap" && p === "uniswap") return "Approve & Swap on Uniswap";
  if (t === "supply" && p === "weth") return "Wrap ETH → WETH";
  if (t === "withdraw" && p === "weth") return "Unwrap WETH → ETH";
  if (t === "withdraw") return `Withdraw from ${label}`;
  if (t === "borrow") return `Borrow from ${label}`;
  if (t === "transfer") return `Send ${order.symbol ?? "tokens"}`;
  return "Confirm on-chain action";
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
  const { status, data, error, execute, executeWithApproval, reset } = useExecute();
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
        title={confirmTitle(order)}
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
          order.type === "supply" ? "Approve & Supply"
            : order.type === "swap" ? "Approve & Swap"
            : order.type === "stake" ? "Stake"
            : order.type === "unstake" ? "Approve & Unstake"
            : order.type === "claim" ? "Claim"
            : order.type === "transfer" ? "Send"
            : "Sign"
        }
        warning="This moves real funds from your wallet."
        guardrail={guardrail}
        onConfirm={async () => {
          setConfirming(false);
          const approving = approveOrderFor(order);
          await executeWithApproval(approving, order);
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
      const res = await fetch("/api/stake-yield", { cache: "no-store" });
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

/** One honest row for a single yield option inside YieldFinderCard — a real Execute button when the venue is wired (Aave/Morpho/Compound), an honest "not wired" note with the real APY otherwise (vault deposits, LP pools, every other DefiLlama-tracked protocol). */
function YieldOptionRow({ option, asset, sizeUsd }: { option: MergedYieldOption; asset: string; sizeUsd: number }) {
  const { data: prices } = useLivePrices();
  const { chain } = useAccount();
  const leg: TradeLeg = { side: "Supply", asset, protocol: option.protocol, sizeUsd };
  const resolved = resolveOrderForLeg(leg, undefined, prices, chain?.id);
  const isMorpho = option.protocol === "Morpho";
  const wired = option.wired && (isMorpho || !isUnsupported(resolved));

  return (
    <div style={{ padding: "4px 0" }}>
      <OrderRow
        label={`${option.protocol} · ${option.chain}`}
        value={`${option.apy.toFixed(2)}% ${option.kind === "lp" ? "APY (LP)" : option.kind === "vault" ? "APR (vault)" : "APY"}`}
        valueColor="var(--color-accent-700)"
      />
      {option.vaultNote && (
        <p className="text-muted" style={{ fontSize: 10, margin: "2px 0 0" }}>
          {option.vaultNote}
        </p>
      )}
      {wired ? (
        isMorpho ? (
          <MorphoExecuteButton leg={leg} prices={prices} />
        ) : (
          <ExecuteButton order={resolved as Order} label={`Execute on ${option.protocol} →`} />
        )
      ) : (
        <NotWired
          venue={option.protocol}
          reason={
            option.kind === "vault"
              ? `${option.protocol} deposit isn't wired for one-click execution yet — this is a real live rate, not something you can act on from here today.`
              : option.kind === "lp"
                ? `${option.protocol} liquidity provision carries impermanent-loss risk and isn't wired for one-click execution yet.`
                : `${option.protocol} isn't wired for one-click execution yet — this is a real live rate from DefiLlama, shown for comparison.`
          }
        />
      )}
    </div>
  );
}

interface MergedYieldOption {
  protocol: string;
  chain: string;
  apy: number;
  tvlUsd: number;
  kind: "lending" | "lp" | "vault";
  wired: boolean;
  vaultNote?: string;
}

const WIRED_YIELD_PROTOCOLS = new Set(["Aave", "Morpho", "Compound"]);

/**
 * Live cross-protocol yield search (tradePlan's "yieldSearch" intent — "find
 * the best yield on X"). Pulls real ranked data from /api/best-yield
 * (DefiLlama lending/LP pools) plus, for USDC specifically, Hyperliquid's
 * HLP and Lighter's LLP vault APRs (the two biggest venue-owned vaults this
 * app already has some integration with) — never a single resolved deposit,
 * since the whole point is comparing across venues Meridian doesn't have
 * execution wired for yet alongside the ones it does. Composes up to 3
 * honest strategies from the live list: the single best rate, the best rate
 * among venues already wired for a real one-click deposit, and an
 * equal-weighted split across the top few (deduped against each other so
 * the same venue never appears as two "different" strategies).
 */
function YieldFinderCard({ asset, sizeUsd }: { asset: string; sizeUsd: number }) {
  const upperAsset = asset.toUpperCase();
  const { data: pools, isLoading: poolsLoading } = useBestYield(upperAsset);
  const { data: hlpApr, isLoading: hlpLoading } = useHlpApr();
  const { data: llpApr, isLoading: llpLoading } = useLlpApr();
  const isUsdc = upperAsset === "USDC";

  const options: MergedYieldOption[] = useMemo(() => {
    const base: MergedYieldOption[] = (pools ?? []).map((p) => ({
      protocol: p.protocol,
      chain: p.chain,
      apy: p.apy,
      tvlUsd: p.tvlUsd,
      kind: p.kind,
      wired: WIRED_YIELD_PROTOCOLS.has(p.protocol),
    }));
    // HLP (USDC only on Hyperliquid) and LLP (USDC only on Lighter) aren't
    // DefiLlama pools — see useVaultYields.ts — so they're merged in here,
    // only when the search is actually for USDC.
    if (isUsdc && typeof hlpApr === "number") {
      base.push({ protocol: "Hyperliquid HLP", chain: "Hyperliquid", apy: hlpApr, tvlUsd: 0, kind: "vault", wired: false });
    }
    if (isUsdc && typeof llpApr === "number") {
      base.push({
        protocol: "Lighter LLP",
        chain: "Lighter",
        apy: llpApr,
        tvlUsd: 0,
        kind: "vault",
        wired: false,
        vaultNote: "Depositing into LLP requires locking LIT tokens (1:10 ratio) — not just USDC.",
      });
    }
    return base.sort((a, b) => b.apy - a.apy);
  }, [pools, hlpApr, llpApr, isUsdc]);

  const loading = poolsLoading || (isUsdc && (hlpLoading || llpLoading));

  if (loading && options.length === 0) {
    return (
      <p className="text-muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
        Scanning live yields for {upperAsset} across DeFi…
      </p>
    );
  }
  if (options.length === 0) {
    return (
      <p className="text-muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
        No live yield data found for {upperAsset} right now across the protocols this search covers.
      </p>
    );
  }

  const best = options[0];
  const establishedPool = options.find((o) => o.wired);
  const splitPool = options.slice(0, 3);
  const blendedApy = splitPool.reduce((s, o) => s + o.apy, 0) / splitPool.length;

  const sections: { label: string; apy: number; pools: MergedYieldOption[] }[] = [{ label: "Best live rate", apy: best.apy, pools: [best] }];
  if (establishedPool && establishedPool.protocol !== best.protocol) {
    sections.push({ label: "Established — already wired for one click", apy: establishedPool.apy, pools: [establishedPool] });
  }
  if (splitPool.length > 1) {
    sections.push({ label: `Diversified — split evenly across ${splitPool.length}`, apy: blendedApy, pools: splitPool });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      {sections.map((s, i) => (
        <div key={i} className="card" style={{ gap: 4, padding: "var(--space-2)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <strong style={{ fontSize: 13 }}>{s.label}</strong>
            <span style={{ fontSize: 13, fontVariantNumeric: "tabular-nums", color: "var(--color-accent-700)" }}>
              ~{s.apy.toFixed(2)}% blended
            </span>
          </div>
          {s.pools.map((p, j) => (
            <YieldOptionRow key={j} option={p} asset={upperAsset} sizeUsd={s.pools.length > 1 ? sizeUsd / s.pools.length : sizeUsd} />
          ))}
        </div>
      ))}
      <p className="text-muted" style={{ fontSize: 10, margin: 0 }}>
        Lending/LP rates from DefiLlama&apos;s free yields API · vault APRs read live from Hyperliquid/Lighter&apos;s own APIs — not editorial picks.
      </p>
    </div>
  );
}

const RISK_COLORS: Record<string, string> = {
  conservative: "var(--risk-good)",
  moderate: "var(--risk-warning)",
  aggressive: "var(--risk-serious)",
};

const RISK_BG: Record<string, string> = {
  conservative: "color-mix(in srgb, var(--risk-good) 8%, transparent)",
  moderate: "color-mix(in srgb, var(--risk-warning) 8%, transparent)",
  aggressive: "color-mix(in srgb, var(--risk-serious) 8%, transparent)",
};

const RISK_BORDER: Record<string, string> = {
  conservative: "color-mix(in srgb, var(--risk-good) 20%, transparent)",
  moderate: "color-mix(in srgb, var(--risk-warning) 20%, transparent)",
  aggressive: "color-mix(in srgb, var(--risk-serious) 20%, transparent)",
};

function riskLabel(plan: TradePlan): string | null {
  if (plan.riskTier) return plan.riskTier;
  const note = (plan.variantNote ?? "").toLowerCase();
  if (note.includes("conservative")) return "conservative";
  if (note.includes("moderate")) return "moderate";
  if (note.includes("aggressive")) return "aggressive";
  const label = (plan.variantLabel ?? "").toLowerCase();
  if (label.includes("conservative")) return "conservative";
  if (label.includes("moderate")) return "moderate";
  if (label.includes("aggressive")) return "aggressive";
  return null;
}

/** Renders execution legs for a single strategy. */
function StrategyLegs({ plan }: { plan: TradePlan }) {
  const { data: prices } = useLivePrices();
  const { chain } = useAccount();

  const orderAmountDisplay = (order: Order): string =>
    typeof order.amount === "bigint"
      ? `${formatBaseUnits(order.amount, order.decimals ?? 18)} ${order.symbol ?? ""}`
      : `${String(order.amount)} ${order.symbol ?? ""}`;

  if (plan.legs.length === 0) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {plan.legs.map((leg, i) => {
        const resolved = resolveOrderForLeg(leg, undefined, prices, chain?.id);
        const legSide = (leg.side || "").toLowerCase();
        const isMorpho = /morpho/i.test(leg.protocol || "");
        const isLido = /lido/i.test(leg.protocol || "");
        const isLidoWithdraw = isLido && (legSide === "withdraw" || legSide === "unstake");
        const isLidoStake = isLido && legSide === "stake";
        const liveVenue =
          /hyperliquid|extended|ondo|lighter|uniswap/i.test(leg.protocol || "") || isMorpho || isLidoWithdraw || isLidoStake;
        const building = isUnsupported(resolved) && !liveVenue;
        return (
          <div key={i} className="leg-card" style={{ opacity: building ? 0.55 : 1 }}>
            <div className="leg-card__header">
              <span className="leg-card__side">{leg.side}</span>
              <span className="leg-card__detail">{legRowValue(leg)}</span>
            </div>
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
            {leg.note && (
              <span className="text-muted" style={{ fontSize: 10 }}>{leg.note}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

const LEG_STATUS_LABEL: Record<LegStatus, string> = {
  pending: "Pending",
  "switching-chain": "Switching chain…",
  approving: "Approving…",
  executing: "Signing…",
  confirmed: "Confirmed",
  error: "Failed",
  skipped: "Skipped",
};
const LEG_STATUS_COLOR: Record<LegStatus, string> = {
  pending: "var(--color-neutral-500)",
  "switching-chain": "var(--color-accent-700)",
  approving: "var(--color-accent-700)",
  executing: "var(--color-accent-700)",
  confirmed: "var(--risk-good, #27ae60)",
  error: "var(--risk-bad, #c0392b)",
  skipped: "var(--color-neutral-400)",
};

/** Batch "Execute Strategy" button — runs all executable legs sequentially with chain switching. */
function ExecuteStrategyButton({ plan }: { plan: TradePlan }) {
  const { data: prices } = useLivePrices();
  const { chain, isConnected } = useAccount();
  const { progress, executeAll, cancel, reset } = useStrategyExecutor();
  const [confirming, setConfirming] = useState(false);

  // Resolve all legs to orders, filtering out unsupported ones
  const resolvedOrders = useMemo(() => {
    const results: { leg: TradeLeg; order: Order; legIndex: number }[] = [];
    for (let i = 0; i < plan.legs.length; i++) {
      const leg = plan.legs[i];
      const resolved = resolveOrderForLeg(leg, undefined, prices, chain?.id);
      if (!isUnsupported(resolved)) {
        results.push({ leg, order: resolved, legIndex: i });
      }
    }
    return results;
  }, [plan.legs, prices, chain?.id]);

  if (resolvedOrders.length === 0) return null;

  // Running state — show progress
  if (progress.status === "running" || progress.status === "completed" || progress.status === "error" || progress.status === "cancelled") {
    const confirmed = progress.legs.filter((l) => l.status === "confirmed").length;
    const total = progress.legs.length;
    return (
      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>
            {progress.status === "running"
              ? `Executing… ${confirmed}/${total}`
              : progress.status === "completed"
                ? `All ${total} legs executed`
                : progress.status === "cancelled"
                  ? `Cancelled (${confirmed}/${total} done)`
                  : `Stopped at leg ${progress.currentLeg + 1} (${confirmed}/${total} done)`}
          </span>
          {progress.status === "running" ? (
            <button
              className="btn"
              style={{ fontSize: 11, padding: "2px 8px", cursor: "pointer" }}
              onClick={cancel}
            >
              Cancel
            </button>
          ) : (
            <button
              className="btn"
              style={{ fontSize: 11, padding: "2px 8px", cursor: "pointer" }}
              onClick={reset}
            >
              Clear
            </button>
          )}
        </div>
        {/* Progress bar */}
        <div style={{ height: 3, borderRadius: 2, background: "var(--color-divider)", overflow: "hidden" }}>
          <div
            style={{
              height: "100%",
              width: `${total > 0 ? (confirmed / total) * 100 : 0}%`,
              background: progress.status === "error" ? "var(--risk-bad, #c0392b)" : "var(--risk-good, #27ae60)",
              transition: "width 0.3s ease",
            }}
          />
        </div>
        {/* Per-leg status */}
        {progress.legs.map((lp, i) => {
          const entry = resolvedOrders[i];
          return (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "1px 0" }}>
              <span className="text-muted">{entry ? legRowValue(entry.leg) : `Leg ${i + 1}`}</span>
              <span style={{ color: LEG_STATUS_COLOR[lp.status], fontWeight: lp.status === "confirmed" || lp.status === "error" ? 600 : 400 }}>
                {LEG_STATUS_LABEL[lp.status]}
                {lp.hash && (
                  <>
                    {" · "}
                    <a
                      href={explorerUrlFor(entry?.order.chainId ?? 1, lp.hash)}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "inherit", textDecoration: "underline" }}
                    >
                      {lp.hash.slice(0, 8)}…
                    </a>
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <>
      <button
        className="btn btn-primary"
        style={{ fontSize: 13, marginTop: 8, cursor: "pointer", width: "100%" }}
        onClick={() => setConfirming(true)}
        title={isConnected ? `Execute all ${resolvedOrders.length} legs sequentially` : "Connect a wallet first"}
      >
        Execute Strategy ({resolvedOrders.length} leg{resolvedOrders.length > 1 ? "s" : ""})
      </button>
      <ConfirmDialog
        open={confirming}
        title="Execute Full Strategy"
        body={
          <div>
            <p style={{ marginBottom: 8 }}>
              This will execute <strong>{resolvedOrders.length} transaction{resolvedOrders.length > 1 ? "s" : ""}</strong> sequentially,
              including approvals and chain switching as needed.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
              {resolvedOrders.map(({ leg }, i) => (
                <div key={i} style={{ display: "flex", gap: 4 }}>
                  <span style={{ color: "var(--color-neutral-400)" }}>{i + 1}.</span>
                  <span>{leg.side} {leg.asset} on {leg.protocol}</span>
                </div>
              ))}
            </div>
          </div>
        }
        confirmLabel={`Execute ${resolvedOrders.length} Leg${resolvedOrders.length > 1 ? "s" : ""}`}
        warning="This moves real funds from your wallet. Each leg will require wallet confirmation."
        onConfirm={async () => {
          setConfirming(false);
          await executeAll(resolvedOrders.map((r) => r.order));
        }}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

/** Individual strategy card — collapsed (preview) or expanded (full details). */
function StrategyCard({ plan, item, isActive, onClick }: {
  plan: TradePlan;
  item: ThreadItem;
  isActive: boolean;
  onClick: () => void;
}) {
  const risk = riskLabel(plan);
  const riskColor = risk ? RISK_COLORS[risk] : undefined;
  const protocols = [...new Set(plan.legs.map((l) => l.protocol).filter(Boolean))];

  return (
    <div
      className={`strategy-card${isActive ? " strategy-card--active" : ""}`}
      onClick={isActive ? undefined : onClick}
      role={isActive ? undefined : "button"}
      tabIndex={isActive ? undefined : 0}
      onKeyDown={isActive ? undefined : (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
    >
      {/* Risk-colored top bar */}
      <div
        className="strategy-card__risk-bar"
        style={{ background: riskColor || "var(--color-divider)" }}
      />

      {/* Header */}
      <div className="strategy-card__header">
        <span className="strategy-card__name">
          {plan.variantLabel || "Strategy"}
        </span>
        {risk && (
          <span
            className="strategy-card__risk-label"
            style={{
              color: riskColor,
              background: risk ? RISK_BG[risk] : undefined,
            }}
          >
            {risk}
          </span>
        )}
      </div>

      {/* Body */}
      <div className="strategy-card__body">
        <p className="strategy-card__summary">{plan.summary}</p>

        {/* Protocol pills */}
        {protocols.length > 0 && (
          <div className="strategy-card__protocols">
            {protocols.map((p) => (
              <span key={p} className="protocol-pill">{p}</span>
            ))}
          </div>
        )}

        {/* Meta */}
        <div className="strategy-card__meta">
          {plan.legs.length > 0 && <span>{plan.legs.length} leg{plan.legs.length > 1 ? "s" : ""}</span>}
          {plan.sizeUsd && plan.sizeUsd > 0 && <span>{fmtUsd(plan.sizeUsd)}</span>}
          {plan.leverage && <span>{plan.leverage}x</span>}
        </div>
      </div>

      {/* Expanded details when active */}
      {isActive && (
        <div className="strategy-card__exec">
          {/* Risk note */}
          {plan.variantNote && (
            <div
              className="risk-note"
              style={{
                background: risk ? RISK_BG[risk] : "color-mix(in srgb, var(--color-text) 4%, transparent)",
                border: `1px solid ${risk ? RISK_BORDER[risk] : "var(--color-divider)"}`,
              }}
            >
              <div className="risk-note__label" style={{ color: riskColor || "var(--color-neutral-500)" }}>
                {riskColor && <span style={{ width: 5, height: 5, borderRadius: "50%", background: riskColor }} />}
                {risk || "Note"}
              </div>
              <span style={{ color: "var(--color-text)" }}>{plan.variantNote}</span>
            </div>
          )}

          {/* Yield search */}
          {plan.intent === "yieldSearch" && (
            <YieldFinderCard asset={plan.asset ?? "USDC"} sizeUsd={plan.sizeUsd ?? 10000} />
          )}

          {/* Execution legs */}
          <StrategyLegs plan={plan} />

          {/* Batch execute button — only when there are multiple executable legs */}
          {plan.legs.length > 1 && <ExecuteStrategyButton plan={plan} />}
        </div>
      )}
    </div>
  );
}

/** Intent label for the AI understanding line. */
function intentLabel(intent: string): string {
  const map: Record<string, string> = {
    lockYield: "Lock in a fixed yield",
    betaNeutral: "Delta-neutral points farming",
    directional: "Directional position",
    swap: "Token swap",
    hedge: "Portfolio hedge",
    supply: "Earn yield via lending",
    borrow: "Borrow against collateral",
    repay: "Repay debt",
    stake: "Liquid staking",
    restake: "Restaking for extra yield",
    options: "Options position",
    bridge: "Cross-chain bridge",
    transfer: "Direct transfer",
    withdraw: "Withdraw position",
    yieldSearch: "Find the best yield",
  };
  return map[intent] || "Custom strategy";
}

export function ThreadCard({ item, onSelectVariant }: { item: ThreadItem; onSelectVariant?: (plan: TradePlan) => void }) {
  const strategies = item.variants && item.variants.length > 1 ? item.variants : item.plan ? [item.plan] : [];
  const [activeIdx, setActiveIdx] = useState(() => {
    if (!item.plan || strategies.length <= 1) return 0;
    // Default to moderate
    const moderateIdx = strategies.findIndex((s) => {
      const r = riskLabel(s);
      return r === "moderate";
    });
    if (moderateIdx >= 0) return moderateIdx;
    const idx = strategies.indexOf(item.plan);
    return idx >= 0 ? idx : 0;
  });

  if (!item.plan) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <div className="user-bubble"><p>{item.text}</p></div>
        <div className="ai-bubble">
          <p className="ai-bubble-text">
            Describe your goal — yield, exposure, hedge, airdrops — and I&apos;ll design strategies with live rates.
          </p>
        </div>
      </div>
    );
  }

  const hasMultiple = strategies.length > 1;
  const activePlan = strategies[activeIdx] || item.plan;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      {/* User message */}
      <div className="user-bubble"><p>{item.text || "Describe your thesis."}</p></div>

      {/* AI response */}
      <div className="ai-bubble">
        {/* Understanding line */}
        <p className="ai-bubble-text">
          <span style={{
            fontFamily: "var(--font-heading)",
            fontWeight: 600,
            color: "var(--color-accent)",
            fontSize: 14,
          }}>
            {intentLabel(activePlan.intent)}
          </span>
          {hasMultiple && (
            <span style={{ color: "var(--color-neutral-500)", fontSize: 12 }}>
              {" "}— {strategies.length} strategies designed. Click to explore.
            </span>
          )}
        </p>

        {/* Strategy cards grid */}
        {hasMultiple ? (
          <div className="strategy-grid">
            {strategies.map((plan, i) => (
              <StrategyCard
                key={i}
                plan={plan}
                item={item}
                isActive={i === activeIdx}
                onClick={() => {
                  setActiveIdx(i);
                  onSelectVariant?.(plan);
                }}
              />
            ))}
          </div>
        ) : (
          /* Single strategy — always expanded */
          <div
            className="strategy-card strategy-card--active"
            style={{ cursor: "default" }}
          >
            <div
              className="strategy-card__risk-bar"
              style={{ background: riskLabel(activePlan) ? RISK_COLORS[riskLabel(activePlan)!] : "var(--color-accent)" }}
            />
            <div className="strategy-card__header">
              <span className="strategy-card__name">
                {activePlan.variantLabel || intentLabel(activePlan.intent)}
              </span>
              {(() => {
                const risk = riskLabel(activePlan);
                return risk ? (
                  <span className="strategy-card__risk-label" style={{ color: RISK_COLORS[risk], background: RISK_BG[risk] }}>
                    {risk}
                  </span>
                ) : null;
              })()}
            </div>
            <div className="strategy-card__body">
              <p className="strategy-card__summary" style={{ WebkitLineClamp: "unset" as unknown as number, overflow: "visible" }}>
                {activePlan.summary}
              </p>
              {(() => {
                const protocols = [...new Set(activePlan.legs.map((l) => l.protocol).filter(Boolean))];
                return protocols.length > 0 ? (
                  <div className="strategy-card__protocols">
                    {protocols.map((p) => <span key={p} className="protocol-pill">{p}</span>)}
                  </div>
                ) : null;
              })()}
            </div>
            <div className="strategy-card__exec">
              {activePlan.variantNote && (() => {
                const risk = riskLabel(activePlan);
                const riskColor = risk ? RISK_COLORS[risk] : undefined;
                return (
                  <div className="risk-note" style={{
                    background: risk ? RISK_BG[risk] : "color-mix(in srgb, var(--color-text) 4%, transparent)",
                    border: `1px solid ${risk ? RISK_BORDER[risk] : "var(--color-divider)"}`,
                  }}>
                    <div className="risk-note__label" style={{ color: riskColor || "var(--color-neutral-500)" }}>
                      {riskColor && <span style={{ width: 5, height: 5, borderRadius: "50%", background: riskColor }} />}
                      {risk || "Note"}
                    </div>
                    <span style={{ color: "var(--color-text)" }}>{activePlan.variantNote}</span>
                  </div>
                );
              })()}
              {activePlan.intent === "yieldSearch" && (
                <YieldFinderCard asset={activePlan.asset ?? "USDC"} sizeUsd={activePlan.sizeUsd ?? 10000} />
              )}
              <StrategyLegs plan={activePlan} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
