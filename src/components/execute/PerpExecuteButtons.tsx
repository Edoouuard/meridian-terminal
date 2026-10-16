"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useSignTypedData } from "wagmi";
import type { Address } from "viem";
import { fmtUsd } from "@/lib/data";
import type { TradeLeg } from "@/lib/tradePlan";
import { describeFill, useHyperliquid } from "@/hooks/useHyperliquid";
import { useSharedHlEnv } from "@/hooks/useHyperliquidEnv";
import { useExtendedAccount } from "@/hooks/useExtendedAccount";
import { useExtendedPerp } from "@/hooks/useExtendedPerp";
import { useLifiPerpsSetup } from "@/hooks/useLifiPerpsSetup";
import { useLifiPerpOrder } from "@/hooks/useLifiPerpOrder";
import { LIFI_PROVIDER_LABEL, type LifiPerpsProviderId } from "@/lib/integrations/lifiPerps";
import { useSharedOndoEnv } from "@/hooks/useOndoEnv";
import { resolvePriceFromList, type PriceEntry } from "@/lib/quote";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { recordExecution } from "@/lib/history";
import { NotWired, OrderRow } from "@/components/thread/shared";
import {
  HL_MIN_ORDER_USD,
  fetchPerpAccount,
  fetchPerpContext,
  fundingAprForSide,
  hyperliquidEnv,
  marginNeededUsd,
  moveSpotUsdcToPerps,
  protectionPrices,
} from "@/lib/integrations/hyperliquidTrade";

/**
 * Live Hyperliquid perp execution, in the order a trader needs it:
 *   1. the market (mark, max leverage) and its funding for this side;
 *   2. the margin on the Hyperliquid account against what the order needs —
 *      polled while a deposit from an earlier step lands, with a one-signature
 *      move of spot USDC to perps when that is where the money sits;
 *   3. an IOC market order signed by the Meridian trading key (approved once
 *      by the wallet; it can trade, never withdraw), then an optional
 *      reduce-only stop-loss / take-profit priced from the real fill.
 * Shares its testnet/mainnet selection with HyperliquidPanel (useSharedHlEnv).
 * Any failure surfaces as an error, never a fake success.
 */
const HL_SIGNING_NOTE =
  "IOC market order (fills now within 5% of the mid, or not at all). The first trade asks your wallet to approve a Meridian trading key once; it can trade, never withdraw.";
const muted = { margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)" } as const;

/** Stop-loss at half the distance to liquidation, at most 10% of price. */
export function defaultStopLossPct(leverage: number): number {
  return Math.max(1, Math.min(10, Math.round(50 / Math.max(1, leverage))));
}

export function PerpExecuteButton({ leg, hedged = false }: { leg: TradeLeg; hedged?: boolean }) {
  const { address, isConnected, chainId } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const envName = useSharedHlEnv();
  const env = hyperliquidEnv(envName === "testnet");
  const { status, result, error, execute, placeLimit, reset } = useHyperliquid();
  const [confirming, setConfirming] = useState<"open" | "close" | null>(null);
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [limitPx, setLimitPx] = useState("");
  const [postOnly, setPostOnly] = useState(false);
  // The stop-loss / take-profit the user asked for in the order win over the defaults.
  const [slOn, setSlOn] = useState(leg.stopLossPct ? true : !hedged);
  const [tpOn, setTpOn] = useState(!!leg.takeProfitPct);
  const [moving, setMoving] = useState<string | null>(null);

  const symbol = (leg.asset || "").replace(/[-\s]?PERP$/i, "").trim().toUpperCase();
  const sizeUsd = leg.sizeUsd && leg.sizeUsd > 0 ? leg.sizeUsd : 0;
  const side = (leg.side || "").toLowerCase();
  const isBuy = side.startsWith("long") || side === "buy";

  const ctx = useQuery({
    queryKey: ["hl-perp-ctx", envName, symbol],
    queryFn: () => fetchPerpContext(env, symbol),
    enabled: !!symbol,
    staleTime: 30_000,
  });
  const leverage = Math.min(Math.max(1, Math.round(leg.leverage ?? 1)), ctx.data?.maxLeverage ?? 50);
  const needed = marginNeededUsd(sizeUsd, leverage);
  const acct = useQuery({
    queryKey: ["hl-perp-acct", envName, address, symbol],
    queryFn: () => fetchPerpAccount(env, address as Address, symbol),
    enabled: !!address && !!symbol,
    // Poll while the margin isn't there yet (a deposit is landing) or a position just changed.
    refetchInterval: (q) => ((q.state.data?.freeMargin ?? 0) < needed || status === "confirmed" ? 5000 : false),
  });
  const [slPct, setSlPct] = useState(() => leg.stopLossPct ?? defaultStopLossPct(leg.leverage ?? 1));
  const [tpPct, setTpPct] = useState(() => leg.takeProfitPct ?? 2 * defaultStopLossPct(leg.leverage ?? 1));

  const recordedRef = useRef<string | null>(null);
  useEffect(() => {
    if (status === "confirmed" && result && recordedRef.current !== "ok") {
      recordedRef.current = "ok";
      recordExecution({
        type: isBuy ? "buy" : "sell",
        label: result.resting ? `Limit ${isBuy ? "buy" : "sell"} ${symbol} placed` : `${isBuy ? "Long" : "Short"} ${symbol}`,
        amount: result.filled ? String(result.filled.totalSz) : result.size !== undefined ? String(result.size) : undefined,
        asset: symbol,
        protocol: "Hyperliquid",
        status: "confirmed",
      });
    } else if (status === "error" && recordedRef.current !== "error") {
      recordedRef.current = "error";
      recordExecution({ type: isBuy ? "buy" : "sell", label: `${isBuy ? "Long" : "Short"} ${symbol} (failed)`, asset: symbol, protocol: "Hyperliquid", status: "error" });
    }
  }, [status, result, isBuy, symbol]);

  const clearBtn = (
    <button onClick={() => { recordedRef.current = null; reset(); }} style={{ marginLeft: 8, background: "none", border: "none", cursor: "pointer", color: "var(--color-neutral-500)", fontSize: 11 }}>
      clear
    </button>
  );

  if (!sizeUsd) return <NotWired venue="Hyperliquid" reason="This position came back without a size. Ask again with the amount you want." />;
  if (!isConnected || !address || !chainId) return <p style={muted}>Connect a wallet to trade {symbol} on Hyperliquid.</p>;
  if (ctx.isLoading) return <p style={muted}>Reading the {symbol} market on Hyperliquid…</p>;
  const m = ctx.data;
  if (!m || !(m.mark > 0)) return <NotWired venue="Hyperliquid" reason={`${symbol} has no live perp market on Hyperliquid ${envName}.`} />;

  const funding = fundingAprForSide(m.fundingHourly, isBuy);
  const free = acct.data?.freeMargin ?? 0;
  const position = acct.data?.position ?? 0;
  const coinQty = sizeUsd / m.mark;
  const lowNotional = sizeUsd < HL_MIN_ORDER_USD;
  const shortBy = Math.max(0, needed - free);
  const movable = !acct.data?.unified && (acct.data?.spotUsdc ?? 0) >= shortBy && shortBy > 0;
  const { sl, tp } = protectionPrices(m.mark, isBuy, { stopLossPct: slOn ? slPct : undefined, takeProfitPct: tpOn ? tpPct : undefined });

  const info = (
    <>
      <OrderRow label="Market" value={`${m.coin} $${m.mark.toLocaleString("en-US", { maximumFractionDigits: 4 })} · max ${m.maxLeverage}x`} />
      <OrderRow
        label="Funding"
        value={`${funding >= 0 ? "+" : ""}${funding.toFixed(1)}%/yr ${funding >= 0 ? "earned" : "paid"} by a ${isBuy ? "long" : "short"}`}
        valueColor={funding >= 0 ? "var(--color-accent-700)" : "var(--risk-bad, #c0392b)"}
      />
      <OrderRow
        label="Margin"
        value={acct.isLoading ? "…" : `$${free.toFixed(2)} free · needs ~$${needed.toFixed(2)} (${leverage}x)`}
        valueColor={!acct.isLoading && shortBy > 0 ? "var(--risk-bad, #c0392b)" : undefined}
      />
      {position !== 0 && <OrderRow label="Open now" value={`${position > 0 ? "Long" : "Short"} ${Math.abs(position)} ${m.coin}`} />}
    </>
  );

  if (status === "preparing" || status === "approving" || status === "submitting") {
    return (
      <>
        {info}
        <p style={muted}>
          {status === "approving" ? "Approve the Meridian trading key in your wallet (one time)…" : status === "preparing" ? "Fetching the Hyperliquid price…" : "Submitting to Hyperliquid…"}
        </p>
      </>
    );
  }

  if (status === "confirmed" && result?.resting) {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-accent-700)" }}>
        Limit order resting on Hyperliquid {envName}: {isBuy ? "buy" : "sell"} {result.size} {m.coin} at ${result.marketPrice}. It fills when the price gets there;
        cancel or move it in the Hyperliquid panel.
        {clearBtn}
      </p>
    );
  }

  if (status === "confirmed" && result) {
    const prot = result.protection;
    return (
      <>
        <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-accent-700)" }}>
          Filled on Hyperliquid {envName}: {describeFill(result)} {m.coin}
          {prot?.ok && (prot.sl || prot.tp)
            ? ` · ${[prot.sl ? `stop-loss $${prot.sl.toPrecision(5)}` : "", prot.tp ? `take-profit $${prot.tp.toPrecision(5)}` : ""].filter(Boolean).join(" · ")}`
            : ""}
          {clearBtn}
        </p>
        {prot && !prot.ok && (
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--risk-bad, #c0392b)" }}>
            The position is open but the stop-loss / take-profit was refused: {prot.error}. Set it in the Hyperliquid app or close the position below.
          </p>
        )}
        {position !== 0 && (
          <button className="btn" style={{ fontSize: 12, marginTop: 6, cursor: "pointer" }} onClick={() => setConfirming("close")}>
            Close {position > 0 ? "long" : "short"} {Math.abs(position)} {m.coin} →
          </button>
        )}
        <ConfirmDialog
          open={confirming === "close"}
          title={`Close ${m.coin} on Hyperliquid ${envName}`}
          body={<div>Reduce-only market order closing {Math.abs(position)} {m.coin} (fills now within 5% of the mid, or not at all).</div>}
          confirmLabel="Close position"
          warning={envName === "testnet" ? "TESTNET — no real funds." : "Mainnet — real funds."}
          onConfirm={() => {
            setConfirming(null);
            recordedRef.current = null;
            execute({ symbol: m.coin, isBuy: position < 0, sizeUsd: 0, coinQty: Math.abs(position), reduceOnly: true, testnet: envName === "testnet" });
          }}
          onCancel={() => setConfirming(null)}
        />
      </>
    );
  }

  if (status === "error") {
    return (
      <>
        {info}
        <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--risk-bad, #c0392b)" }}>
          {`Hyperliquid: ${error ?? "the order failed"}`}
          {clearBtn}
        </p>
      </>
    );
  }

  if (lowNotional) {
    return <>{info}<p style={muted}>Hyperliquid&apos;s minimum order is ${HL_MIN_ORDER_USD} of notional; this position is ${sizeUsd.toFixed(2)}.</p></>;
  }

  if (!acct.isLoading && shortBy > 0) {
    return (
      <>
        {info}
        {movable ? (
          <>
            <button
              className="btn btn-primary"
              style={{ fontSize: 13, marginTop: 6, cursor: "pointer" }}
              disabled={moving === "pending"}
              onClick={async () => {
                setMoving("pending");
                try {
                  const amount = Math.ceil(shortBy * 100) / 100;
                  const out = await moveSpotUsdcToPerps({
                    env,
                    walletSign: (td) => signTypedDataAsync(td as Parameters<typeof signTypedDataAsync>[0]),
                    walletChainId: chainId,
                    amount,
                  });
                  setMoving(out.ok ? null : out.error ?? "refused");
                  void acct.refetch();
                } catch (e) {
                  const msg = e instanceof Error ? e.message : String(e);
                  setMoving(/user rejected|denied/i.test(msg) ? "Signature declined in the wallet." : msg);
                }
              }}
            >
              {moving === "pending" ? "Moving USDC to perps…" : `Move $${(Math.ceil(shortBy * 100) / 100).toFixed(2)} USDC from spot to perps →`}
            </button>
            {moving && moving !== "pending" && <p style={{ ...muted, color: "var(--risk-bad, #c0392b)" }}>{moving}</p>}
          </>
        ) : (
          <p style={muted}>
            Waiting for ${shortBy.toFixed(2)} more margin on your Hyperliquid account. A deposit from the step above is credited about a minute after its
            transaction; this checks every 5 seconds.
          </p>
        )}
      </>
    );
  }

  const pctInput = (value: number, set: (n: number) => void, label: string) => (
    <input
      type="number"
      min={0.5}
      max={90}
      step={0.5}
      value={value}
      aria-label={label}
      onChange={(e) => set(Math.max(0, Number(e.target.value) || 0))}
      style={{ width: 56, marginLeft: 6, fontSize: 12 }}
    />
  );

  const px = Number(limitPx);
  const isLimit = orderType === "limit";
  const limitInvalid = isLimit && !(px > 0);
  // A limit through the market fills at once: say so rather than let it surprise.
  const limitCrosses = isLimit && px > 0 && (isBuy ? px >= m.mark : px <= m.mark);
  const tab = (t: "market" | "limit", label: string) => (
    <button
      onClick={() => {
        setOrderType(t);
        if (t === "limit" && !limitPx) setLimitPx(String(Number((m.mark * (isBuy ? 0.99 : 1.01)).toPrecision(5))));
      }}
      style={{
        fontSize: 11,
        padding: "2px 8px",
        cursor: "pointer",
        border: "1px solid var(--color-divider)",
        background: orderType === t ? "var(--color-accent-700)" : "none",
        color: orderType === t ? "#fff" : "var(--color-text)",
        borderRadius: 4,
      }}
    >
      {label}
    </button>
  );

  return (
    <>
      {info}
      <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6, fontSize: 12 }}>
        {tab("market", "Market")}
        {tab("limit", "Limit")}
        {isLimit && (
          <>
            <input
              type="number"
              value={limitPx}
              min={0}
              step="any"
              aria-label="Limit price"
              onChange={(e) => setLimitPx(e.target.value)}
              style={{ width: 90, fontSize: 12 }}
            />
            <label style={{ fontSize: 11 }}>
              <input type="checkbox" checked={postOnly} onChange={(e) => setPostOnly(e.target.checked)} /> post-only
            </label>
          </>
        )}
      </div>
      {limitCrosses && (
        <p style={{ ...muted, color: "var(--risk-bad, #c0392b)" }}>
          {postOnly ? "Post-only will be refused: this price would fill immediately." : "This price is through the market: it fills now, like a market order."}
        </p>
      )}
      <button
        className="btn btn-primary"
        style={{ fontSize: 13, marginTop: 6, cursor: limitInvalid ? "not-allowed" : "pointer" }}
        disabled={limitInvalid}
        onClick={() => setConfirming("open")}
      >
        {isLimit ? `Place limit ${isBuy ? "buy" : "sell"} ${m.coin} at $${limitPx}` : `Open ${isBuy ? "long" : "short"} ${m.coin}`} {fmtUsd(sizeUsd)} at {leverage}x on Hyperliquid →
      </button>
      <ConfirmDialog
        open={confirming === "open"}
        title={`Confirm ${isBuy ? "long" : "short"} ${m.coin} on Hyperliquid ${envName}`}
        body={
          isLimit ? (
            <div>
              <p style={{ margin: 0 }}>
                Limit {isBuy ? "buy" : "sell"} of {fmtUsd(sizeUsd)} ≈ <strong>{(sizeUsd / px).toFixed(4)}</strong> {m.coin} at ${limitPx}, {leverage}x cross margin
                {postOnly ? ", post-only (refused if it would fill at once)" : ""}. It rests on the book until filled or cancelled. A stop-loss / take-profit
                isn&apos;t added to a resting order: add it once it fills. The first trade asks your wallet to approve a Meridian trading key once; it can trade,
                never withdraw.
              </p>
            </div>
          ) : (
          <div>
            <p style={{ margin: 0 }}>
              Market {isBuy ? "long" : "short"} of {fmtUsd(sizeUsd)} ≈ <strong>{coinQty.toFixed(4)}</strong> {m.coin} at ~${m.mark.toLocaleString("en-US", { maximumFractionDigits: 4 })}, {leverage}x cross
              margin (~${needed.toFixed(2)}). Funding now: {funding >= 0 ? "+" : ""}
              {funding.toFixed(1)}%/yr for this side. {HL_SIGNING_NOTE}
            </p>
            <label style={{ display: "block", marginTop: 8, fontSize: 12 }}>
              <input type="checkbox" checked={slOn} onChange={(e) => setSlOn(e.target.checked)} /> Stop-loss
              {pctInput(slPct, setSlPct, "Stop-loss distance in %")}% {slOn && sl ? `(≈ $${sl.toPrecision(5)})` : ""}
            </label>
            <label style={{ display: "block", marginTop: 4, fontSize: 12 }}>
              <input type="checkbox" checked={tpOn} onChange={(e) => setTpOn(e.target.checked)} /> Take-profit
              {pctInput(tpPct, setTpPct, "Take-profit distance in %")}% {tpOn && tp ? `(≈ $${tp.toPrecision(5)})` : ""}
            </label>
            {hedged && slOn && (
              <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--risk-bad, #c0392b)" }}>
                This short hedges a spot position: a stop-loss would remove the hedge when the price rises.
              </p>
            )}
          </div>
          )
        }
        confirmLabel={isLimit ? "Place order" : "Submit order"}
        warning={envName === "testnet" ? "TESTNET — no real funds." : "Mainnet — real funds. Confirm carefully."}
        onConfirm={() => {
          setConfirming(null);
          recordedRef.current = null;
          if (isLimit) {
            void placeLimit({ symbol: m.coin, isBuy, px, sizeUsd, leverage, postOnly, testnet: envName === "testnet" });
            return;
          }
          execute({
            symbol: m.coin,
            isBuy,
            sizeUsd,
            leverage,
            testnet: envName === "testnet",
            coinQty,
            stopLossPct: slOn ? slPct : undefined,
            takeProfitPct: tpOn ? tpPct : undefined,
          });
        }}
        onCancel={() => setConfirming(null)}
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
        Order submitted on Extended {result.network}: {result.market}{result.qty ? ` · ${result.qty}` : ""}. Check the fill in the Extended panel.
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
        Order submitted on {label}. Check the fill in the {label} panel.
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
