"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useSignTypedData } from "wagmi";
import type { Address } from "viem";
import type { TradeLeg } from "@/lib/tradePlan";
import {
  HL_MIN_ORDER_USD,
  MARKET_SLIPPAGE,
  fetchMid,
  fetchSpotMarket,
  fetchWithdrawable,
  hyperliquidEnv,
  moveSpotUsdcToPerps,
  planSpotBuy,
} from "@/lib/integrations/hyperliquidTrade";
import { describeFill, useHyperliquid } from "@/hooks/useHyperliquid";
import { useSharedHlEnv } from "@/hooks/useHyperliquidEnv";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { NotWired, OrderRow } from "@/components/thread/shared";
import { recordExecution } from "@/lib/history";

const muted = { margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)" } as const;

/** The Hyperliquid spot token for an asset name: ETH → UETH, BTC → UBTC, SOL → USOL; UETH stays. */
export function hlSpotToken(asset: string): string {
  const base = asset.split("→").pop()!.trim().split(/\s/)[0].toUpperCase();
  if (base === "ETH" || base === "WETH") return "UETH";
  if (base === "BTC" || base === "WBTC") return "UBTC";
  if (base === "SOL") return "USOL";
  return base;
}

/**
 * Buy the spot side of a Hyperliquid neutral position (UETH, UBTC…) with the
 * USDC already in the Hyperliquid account: an IOC market buy signed by the
 * Meridian trading key. On a non-unified account whose USDC sits in perps,
 * one wallet signature first moves the needed USDC to spot.
 */
export function HyperliquidSpotBuyButton({ leg, onFilled }: { leg: TradeLeg; onFilled?: (ref: string) => void }) {
  const { address, isConnected, chainId } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const envName = useSharedHlEnv();
  const env = hyperliquidEnv(envName === "testnet");
  const token = hlSpotToken(leg.asset);
  const usd = leg.sizeUsd ?? 0;
  const [confirming, setConfirming] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const { status, result, error, buySpot, reset } = useHyperliquid();

  const market = useQuery({
    queryKey: ["hl-spot-market", envName, token],
    queryFn: async () => {
      const m = await fetchSpotMarket(env, token);
      return m ? { ...m, mid: await fetchMid(env, m.coin) } : null;
    },
    staleTime: 30_000,
  });
  const funds = useQuery({
    queryKey: ["hl-withdrawable", envName, address],
    queryFn: () => fetchWithdrawable(env, address as Address),
    enabled: !!address,
    refetchInterval: 5_000,
  });

  const recorded = useRef(false);
  useEffect(() => {
    if (status !== "confirmed" || recorded.current) return;
    recorded.current = true;
    recordExecution({ type: "buy", label: `Buy ${token} on Hyperliquid`, amount: String(result?.filled?.totalSz ?? ""), asset: token, protocol: "Hyperliquid", status: "confirmed" });
    if (result?.filled) onFilled?.(`hyperliquid:${token}:${result.filled.totalSz}@${result.filled.avgPx}`);
  }, [status, result, token, onFilled]);

  if (!isConnected || !address || !chainId) return <p style={muted}>Connect a wallet to buy {token} on Hyperliquid.</p>;
  if (market.isLoading || funds.isLoading) return <p style={muted}>Reading Hyperliquid&apos;s {token} market and your USDC there…</p>;
  const m = market.data;
  if (!m || !m.mid) return <NotWired venue="Hyperliquid" reason={`No live ${token}/USDC spot market on Hyperliquid ${envName}.`} />;
  if (usd < HL_MIN_ORDER_USD) return <p style={muted}>Hyperliquid&apos;s minimum order is ${HL_MIN_ORDER_USD}; this step is ${usd.toFixed(2)}.</p>;

  if (status === "preparing" || status === "approving" || status === "submitting") {
    return <p style={muted}>{status === "approving" ? "Approve the Meridian trading key in your wallet (one time)…" : `Buying ${token} on Hyperliquid…`}</p>;
  }
  if (status === "confirmed") {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-accent-700)" }}>
        Bought {describeFill(result)} {token} on Hyperliquid {envName}; it sits in your Hyperliquid spot balance.
        <button onClick={reset} style={{ marginLeft: 8, background: "none", border: "none", cursor: "pointer", color: "var(--color-neutral-500)", fontSize: 11 }}>
          clear
        </button>
      </p>
    );
  }
  if (status === "error") {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--risk-bad, #c0392b)" }}>
        {`Hyperliquid: ${error ?? "the buy failed"}`}
        <button onClick={reset} style={{ marginLeft: 8, background: "none", border: "none", cursor: "pointer", color: "var(--color-neutral-500)", fontSize: 11 }}>
          clear
        </button>
      </p>
    );
  }

  const f = funds.data ?? { perps: 0, spotUsdc: 0, unified: false };
  const needed = usd * (1 + MARKET_SLIPPAGE);
  const plan = planSpotBuy({ usd, mid: m.mid, spotUsdc: f.spotUsdc, szDecimals: m.szDecimals });
  const fundsRow = (
    <OrderRow label="USDC on Hyperliquid" value={f.unified ? `$${f.spotUsdc.toFixed(2)} (unified account)` : `$${f.spotUsdc.toFixed(2)} spot · $${f.perps.toFixed(2)} perps`} />
  );

  // A standard account keeps perps and spot USDC apart: move what the buy needs to spot first.
  const shortBy = needed - f.spotUsdc;
  if (!f.unified && shortBy > 0.01) {
    const amount = Math.ceil(shortBy * 100) / 100;
    if (f.perps < amount) {
      return (
        <>
          {fundsRow}
          <p style={muted}>
            Waiting for ${amount.toFixed(2)} more USDC on Hyperliquid (a deposit from an earlier step is credited about a minute after its transaction).
          </p>
        </>
      );
    }
    return (
      <>
        {fundsRow}
        <OrderRow label="Step 1 of 2" value={`Move $${amount.toFixed(2)} USDC from perps to spot`} />
        <button
          className="btn btn-secondary"
          style={{ fontSize: 12, marginTop: 6 }}
          disabled={moving === "pending"}
          onClick={async () => {
            setMoving("pending");
            try {
              const out = await moveSpotUsdcToPerps({
                env,
                walletSign: (td) => signTypedDataAsync(td as Parameters<typeof signTypedDataAsync>[0]),
                walletChainId: chainId,
                amount,
                toSpot: true,
              });
              setMoving(out.ok ? null : out.error ?? "refused");
              void funds.refetch();
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              setMoving(/user rejected|denied/i.test(msg) ? "Signature declined in the wallet." : msg);
            }
          }}
        >
          {moving === "pending" ? "Moving USDC to spot…" : `Move $${amount.toFixed(2)} USDC to spot →`}
        </button>
        {moving && moving !== "pending" && <p style={{ ...muted, color: "var(--risk-bad, #c0392b)" }}>{moving}</p>}
      </>
    );
  }

  if (plan.usd < HL_MIN_ORDER_USD) {
    return (
      <>
        {fundsRow}
        <p style={muted}>Not enough free USDC on Hyperliquid for this buy yet (needs ~${needed.toFixed(2)}).</p>
      </>
    );
  }

  return (
    <>
      {fundsRow}
      <OrderRow
        label="Buy"
        value={`${plan.size} ${token} ≈ $${plan.usd.toFixed(2)} at ~$${m.mid.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
        valueColor="var(--color-accent-700)"
      />
      <button className="btn btn-primary" style={{ fontSize: 13, marginTop: 6, cursor: "pointer" }} onClick={() => setConfirming(true)}>
        Buy {plan.size} {token} on Hyperliquid →
      </button>
      <ConfirmDialog
        open={confirming}
        title={`Buy ${token} on Hyperliquid ${envName}`}
        body={
          <div>
            IOC market buy of {plan.size} {token} (~${plan.usd.toFixed(2)}) on Hyperliquid&apos;s {token}/USDC order book, paid with the USDC in your
            Hyperliquid account: it fills now within 5% of the mid, or not at all. The first trade asks your wallet to approve a Meridian trading key once;
            it can trade, never withdraw.
          </div>
        }
        confirmLabel="Buy"
        warning={envName === "testnet" ? "TESTNET — no real funds." : "Mainnet — real funds. Confirm carefully."}
        onConfirm={() => {
          setConfirming(false);
          void buySpot({ token, usd, testnet: envName === "testnet" });
        }}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
