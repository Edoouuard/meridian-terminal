"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useSignTypedData } from "wagmi";
import type { Address } from "viem";
import type { TradeLeg, TradePlan } from "@/lib/tradePlan";
import { fmtUsd } from "@/lib/data";
import { runPerpPair, type PairFill, type PairRun, type PairStep, type PairVenue } from "@/lib/perpPair";
import { fetchPerpAccount, hyperliquidEnv, marginNeededUsd, perpMarketOrder, withAgent, type WalletSign } from "@/lib/integrations/hyperliquidTrade";
import { executeExtendedPerp, fetchExtendedBalance } from "@/lib/integrations/extended-live";
import { repairExtendedVault, useExtendedAccount } from "@/hooks/useExtendedAccount";
import { TXFLOW_NETWORK, fetchTxflowAccount } from "@/lib/integrations/txflow-live";
import { txflowMarketOrder, withTxflowAgent, type TxflowWalletSign } from "@/lib/integrations/txflowTrade";
import { useSharedHlEnv } from "@/hooks/useHyperliquidEnv";
import type { PriceEntry } from "@/lib/quote";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { recordExecution } from "@/lib/history";

const muted = { margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)" } as const;
const bad = "var(--risk-bad, #c0392b)";
const isHl = (l: TradeLeg) => /hyperliquid/i.test(l.protocol || "");
const isTx = (l: TradeLeg) => /txflow/i.test(l.protocol || "");
const isLong = (l: TradeLeg) => /^long$/i.test(l.side.trim());
const hlCoin = (l: TradeLeg) => (l.asset || "").replace(/[-\s]?PERP$/i, "").trim().toUpperCase();
const extSymbol = (l: TradeLeg) => (l.asset || "").replace(/PERP$/i, "").trim() || "ETH";
const venueName = (l: TradeLeg) => (isHl(l) ? "Hyperliquid" : isTx(l) ? "TxFlow" : "Extended");
const lev = (l: TradeLeg) => Math.max(1, Math.round(l.leverage ?? 1));
const declined = (msg: string) => (/user rejected|denied/i.test(msg) ? "Signature declined in the wallet." : msg.split("\n")[0]);

/**
 * Both legs of a neutral perp pair in one click (lib/perpPair.ts): the first
 * leg in the plan's sequence, then the second at the quantity the first
 * filled; a second leg that fails closes the first at once (reduce-only). The
 * per-step buttons below stay for doing it by hand. Shown only while neither
 * leg has filled and both accounts hold the margin.
 */
export function PerpPairButton({
  plan,
  seq,
  prices,
  onFilled,
}: {
  plan: TradePlan;
  seq: [number, number];
  prices?: PriceEntry[];
  onFilled: (legIndex: number, ref: string) => void;
}) {
  const { address, isConnected, chainId } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const signer = useExtendedAccount();
  const envName = useSharedHlEnv();
  const env = hyperliquidEnv(envName === "testnet");
  const [confirming, setConfirming] = useState(false);
  const [step, setStep] = useState<PairStep | "approving" | null>(null);
  const [run, setRun] = useState<PairRun | { status: "error"; error: string } | null>(null);

  const legs = seq.map((i) => plan.legs[i]) as [TradeLeg, TradeLeg];
  const hlLeg = legs.find(isHl);
  const txLeg = legs.find(isTx);
  const extLeg = legs.find((l) => !isHl(l) && !isTx(l));
  const needsExtended = !!extLeg;

  // Free margin on each venue against what its leg needs.
  const margin = useQuery({
    queryKey: ["pair-margin", envName, address, signer?.network, hlLeg && hlCoin(hlLeg), plan.legs.length],
    queryFn: async () => {
      const hl = hlLeg ? (await fetchPerpAccount(env, address as Address, hlCoin(hlLeg))).freeMargin : undefined;
      const ext = extLeg && signer ? ((await fetchExtendedBalance(signer).catch(() => null))?.availableForTrade ?? 0) : undefined;
      const tx = txLeg ? ((await fetchTxflowAccount(address as Address).catch(() => null))?.withdrawable ?? 0) : undefined;
      return { hl, ext, tx };
    },
    enabled: !!address && (!needsExtended || !!signer),
    refetchInterval: 15_000,
  });

  if (!isConnected || !address || !chainId) return null;
  if (needsExtended && !signer) return null;
  if (!margin.data) return null;

  const short = legs
    .map((l) => {
      const free = isHl(l) ? margin.data.hl : isTx(l) ? margin.data.tx : margin.data.ext;
      const need = marginNeededUsd(l.sizeUsd ?? 0, lev(l));
      return free !== undefined && free < need ? `${venueName(l)} has ${fmtUsd(free)} free, needs ~${fmtUsd(need)}` : null;
    })
    .filter(Boolean);

  const walletSign: WalletSign = (td) => signTypedDataAsync(td as Parameters<typeof signTypedDataAsync>[0]);
  const txWalletSign: TxflowWalletSign = (td) => signTypedDataAsync(td as Parameters<typeof signTypedDataAsync>[0]);
  const hlFill = (coin: string, o: { ok: boolean; filled?: { totalSz: number; avgPx: number }; error?: string }): PairFill =>
    o.ok && o.filled ? { ok: true, filledQty: o.filled.totalSz, avgPx: o.filled.avgPx, ref: `hyperliquid:${coin}:${o.filled.totalSz}@${o.filled.avgPx}` } : { ok: false, error: o.error ?? "The order didn't fill (no liquidity within 5% of the mid)." };

  const order = async (i: number, isBuy: boolean, qty: number | undefined, reduceOnly: boolean): Promise<PairFill> => {
    const l = plan.legs[i];
    if (isHl(l)) {
      const coin = hlCoin(l);
      const out = await withAgent({ user: address, env, walletSign, walletChainId: chainId }, (key) =>
        perpMarketOrder(env, key, { coin, isBuy, sizeUsd: reduceOnly ? 0 : (l.sizeUsd ?? 0), coinQty: qty, leverage: lev(l), reduceOnly, user: address }),
      );
      return hlFill(coin, out);
    }
    if (isTx(l)) {
      const out = await withTxflowAgent({ user: address, walletSign: txWalletSign, walletChainId: chainId }, (key) =>
        txflowMarketOrder(TXFLOW_NETWORK, key, { user: address, symbol: hlCoin(l), isBuy, sizeUsd: reduceOnly ? 0 : (l.sizeUsd ?? 0), coinQty: qty, leverage: lev(l), reduceOnly }),
      );
      return out.ok && out.filled
        ? { ok: true, filledQty: out.filled.totalSz, avgPx: out.filled.avgPx, ref: `txflow:${out.market?.name ?? hlCoin(l)}:${out.filled.totalSz}@${out.filled.avgPx}` }
        : { ok: false, error: out.error ?? "TxFlow didn't report a fill." };
    }
    const r = await executeExtendedPerp({ signer: signer!, symbol: extSymbol(l), isBuy, sizeUsd: l.sizeUsd ?? 0, prices, leverage: lev(l), reduceOnly, qtyOverride: qty });
    if (r.repairedVaultId) repairExtendedVault(r.repairedVaultId);
    const filled = Number(r.filledQty);
    return r.ok && filled > 0 ? { ok: true, filledQty: filled, avgPx: Number(r.avgPrice) || undefined, ref: `extended:${r.market}:${r.filledQty}@${r.avgPrice ?? ""}` } : { ok: false, error: r.error ?? "Extended didn't report a fill." };
  };

  const venue: PairVenue = {
    open: (i, qty) => order(i, isLong(plan.legs[i]), qty, false),
    close: (i, qty) => order(i, !isLong(plan.legs[i]), qty, true),
  };

  async function start() {
    setConfirming(false);
    setRun(null);
    try {
      // The trading-key approval (once) happens before anything trades, never between the two legs.
      if (hlLeg) {
        setStep("approving");
        await withAgent({ user: address!, env, walletSign, walletChainId: chainId! }, async () => ({ ok: true }));
      }
      if (txLeg) {
        setStep("approving");
        await withTxflowAgent({ user: address!, walletSign: txWalletSign, walletChainId: chainId! }, async () => ({ ok: true }));
      }
      const out = await runPerpPair(seq, venue, setStep);
      setRun(out);
      if (out.status === "neutral") {
        for (const f of [out.first, out.second]) {
          const l = plan.legs[f.legIndex];
          if (f.ref) onFilled(f.legIndex, f.ref);
          recordExecution({ type: isLong(l) ? "buy" : "sell", label: `${isLong(l) ? "Long" : "Short"} ${hlCoin(l)} (${venueName(l)}, pair)`, amount: String(f.qty), asset: hlCoin(l), protocol: venueName(l), status: "confirmed" });
        }
      }
    } catch (err) {
      setRun({ status: "error", error: declined(err instanceof Error ? err.message : String(err)) });
    } finally {
      setStep(null);
    }
  }

  const coin = hlCoin(legs[0]);
  const label = (l: TradeLeg) => `${isLong(l) ? "long" : "short"} on ${venueName(l)}`;

  if (step) {
    const text =
      step === "approving"
        ? "Approve the Meridian trading key in your wallet if asked (once)…"
        : step.phase === "first"
          ? `Opening the ${label(plan.legs[step.legIndex])}…`
          : step.phase === "second"
            ? `Opening the ${label(plan.legs[step.legIndex])} at the same quantity…`
            : step.phase === "unwinding"
              ? "The second leg failed: closing the first one…"
              : "The second leg filled partly: trimming the first to match…";
    return <p className="pair-run" style={muted}>{text}</p>;
  }

  if (run?.status === "neutral") {
    return (
      <p style={{ ...muted, color: "var(--color-accent-700)" }}>
        Pair open: {run.first.qty} {coin} {label(plan.legs[run.first.legIndex])} and {run.second.qty} {coin} {label(plan.legs[run.second.legIndex])}. Net delta ≈ 0. Track both under Risk → Perp positions.
      </p>
    );
  }

  return (
    <div className="pair-run" style={{ marginBottom: 4 }}>
      {run && (
        <p style={{ ...muted, color: run.status === "exposed" ? bad : "var(--color-neutral-600, #555)" }}>
          {run.status === "first_failed"
            ? `Nothing was traded: ${run.error}`
            : run.status === "unwound"
              ? `The second leg failed (${run.error}), so the first was closed: no position is left open (fees aside).`
              : run.status === "exposed"
                ? `Exposed: ${run.qty} ${coin} stays open on the ${label(plan.legs[run.legIndex])} (${run.error}; closing failed: ${run.unwindError}). Close it now in Risk → Perp positions.`
                : run.error}
        </p>
      )}
      {short.length > 0 ? (
        <p style={muted}>One-click pair needs the margin on both venues first: {short.join(" · ")}. Fund them, or run the steps one by one below.</p>
      ) : (
        <button className="btn btn-primary" style={{ fontSize: 13, marginTop: 6, cursor: "pointer", width: "100%" }} onClick={() => setConfirming(true)}>
          Open the pair in one click ({label(legs[0])} first) →
        </button>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Open the ${coin} pair`}
        body={
          <div>
            <p style={{ marginBottom: 6 }}>
              1. {label(legs[0])}, {fmtUsd(legs[0].sizeUsd ?? 0)} at {lev(legs[0])}x (market order).
              <br />
              2. {label(legs[1])} at the exact quantity step 1 filled.
            </p>
            <p>If step 2 fails, step 1 is closed straight away (reduce-only, at market), so you are never left with one side. Both orders go out back to back; the only wallet popup is the one-time trading-key approval.</p>
          </div>
        }
        confirmLabel="Open both legs"
        warning={envName === "testnet" && !needsExtended && !txLeg ? "TESTNET — no real funds." : "Real funds. Market orders: expect fees and a little slippage on each leg."}
        onConfirm={() => void start()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
