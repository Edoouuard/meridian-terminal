"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useReadContract } from "wagmi";
import { formatUnits, type Address } from "viem";
import type { TradeLeg } from "@/lib/tradePlan";
import { findToken } from "@/lib/assetMap";
import { ERC20_ABI } from "@/lib/onchain";
import type { Order } from "@/lib/execution";
import { systemAddressForToken } from "@/lib/integrations/hyperliquidExchange";
import { HL_MIN_ORDER_USD, fetchMid, fetchSpotBalance, fetchSpotMarket, hyperliquidEnv, planSpotSell } from "@/lib/integrations/hyperliquidTrade";
import { describeFill, useHyperliquid } from "@/hooks/useHyperliquid";
import { useSharedHlEnv } from "@/hooks/useHyperliquidEnv";
import { ValidatedExecuteButton } from "@/components/ValidatedExecuteButton";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { NotWired, OrderRow } from "@/components/thread/shared";
import { recordExecution } from "@/lib/history";

const HYPEREVM_ID = 999;
const muted = { margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)" } as const;

/**
 * Sell a HyperEVM token (UETH, UBTC) for USDC on Hyperliquid's own spot order
 * book, in up to two steps:
 *   1. when the Hyperliquid spot balance is short, move the tokens there from
 *      HyperEVM (an ERC20 transfer to the token's HyperCore system address,
 *      credited to the sender's spot balance at the next block);
 *   2. an IOC market sell on the token/USDC pair, signed by the Meridian
 *      trading key (see useHyperliquid). The USDC stays in the Hyperliquid
 *      account.
 */
export function HyperliquidSpotSellButton({ leg }: { leg: TradeLeg }) {
  const { address, isConnected } = useAccount();
  const envName = useSharedHlEnv();
  const env = hyperliquidEnv(envName === "testnet");
  const token = leg.asset.split(/[\s→]/)[0].trim().toUpperCase();
  const evmToken = findToken(token, HYPEREVM_ID);
  const [moved, setMoved] = useState(false);
  // HyperCore credits the next block; past two minutes, say so instead of waiting silently.
  const [slow, setSlow] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { status, result, error, sellSpot, reset } = useHyperliquid();

  const market = useQuery({
    queryKey: ["hl-spot-market", envName, token],
    queryFn: async () => {
      const m = await fetchSpotMarket(env, token);
      return m ? { ...m, mid: await fetchMid(env, m.coin) } : null;
    },
    staleTime: 30_000,
  });
  // Poll the spot balance while a move from HyperEVM is landing.
  const core = useQuery({
    queryKey: ["hl-spot-balance", envName, address, token],
    queryFn: () => fetchSpotBalance(env, address as Address, token),
    enabled: !!address,
    refetchInterval: moved ? 3000 : false,
  });
  const evm = useReadContract({
    address: evmToken?.address as Address | undefined,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: HYPEREVM_ID,
    query: { enabled: !!address && !!evmToken, refetchInterval: moved ? 3000 : false },
  });

  const recorded = useRef(false);
  useEffect(() => {
    if (status !== "confirmed" || recorded.current) return;
    recorded.current = true;
    recordExecution({ type: "sell", label: `Sell ${token} on Hyperliquid`, amount: String(result?.filled?.totalSz ?? ""), asset: token, protocol: "Hyperliquid", status: "confirmed" });
    void core.refetch();
  }, [status, result, token, core]);

  if (!isConnected || !address) return <p style={muted}>Connect a wallet to sell {token} on Hyperliquid.</p>;
  if (market.isLoading || core.isLoading || (evmToken && evm.isLoading)) return <p style={muted}>Reading your {token} on HyperEVM and Hyperliquid…</p>;
  const m = market.data;
  if (!m || !m.mid) return <NotWired venue="Hyperliquid" reason={`No live ${token}/USDC spot market on Hyperliquid ${envName}.`} />;

  const coreBal = core.data ?? 0;
  const evmBal = evmToken && typeof evm.data === "bigint" ? Number(formatUnits(evm.data, evmToken.decimals)) : 0;
  const target = leg.sizeToken ? Number(leg.sizeToken) : leg.sizeUsd ? leg.sizeUsd / m.mid : undefined;
  const plan = planSpotSell({ target, core: coreBal, evm: evmBal, szDecimals: m.szDecimals });

  const balances = (
    <OrderRow label="You hold" value={`${coreBal.toFixed(m.szDecimals)} ${token} on Hyperliquid · ${evmBal.toFixed(m.szDecimals)} on HyperEVM`} />
  );

  if (status === "preparing" || status === "approving" || status === "submitting") {
    return (
      <>
        {balances}
        <p style={muted}>{status === "approving" ? "Approve the Meridian trading key in your wallet (one time)…" : `Selling ${token} on Hyperliquid…`}</p>
      </>
    );
  }
  if (status === "confirmed") {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-accent-700)" }}>
        Sold {describeFill(result)} on Hyperliquid {envName}: the USDC is in your Hyperliquid account.
        <button onClick={reset} style={{ marginLeft: 8, background: "none", border: "none", cursor: "pointer", color: "var(--color-neutral-500)", fontSize: 11 }}>
          clear
        </button>
      </p>
    );
  }
  if (status === "error") {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--risk-bad, #c0392b)" }}>
        {`Hyperliquid: ${error ?? "the sell failed"}`}
        <button onClick={reset} style={{ marginLeft: 8, background: "none", border: "none", cursor: "pointer", color: "var(--color-neutral-500)", fontSize: 11 }}>
          clear
        </button>
      </p>
    );
  }

  if (plan.sell <= 0) return <>{balances}<p style={muted}>No {token} to sell on HyperEVM or in your Hyperliquid spot balance.</p></>;
  if (plan.sell * m.mid < HL_MIN_ORDER_USD) {
    return <>{balances}<p style={muted}>Hyperliquid&apos;s minimum order is ${HL_MIN_ORDER_USD}: {plan.sell} {token} is ~${(plan.sell * m.mid).toFixed(2)}.</p></>;
  }

  // Step 1: the tokens still sit on HyperEVM.
  if (plan.move > 0 && evmToken) {
    if (moved) {
      return (
        <>
          {balances}
          <p style={muted}>
            {slow
              ? `The ${token} hasn't shown up in your Hyperliquid spot balance yet. Check the transfer on the HyperEVM explorer, or `
              : `Waiting for the ${token} to reach your Hyperliquid spot balance (a few seconds)…`}
            {slow && (
              <button onClick={() => { setMoved(false); setSlow(false); void core.refetch(); }} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-accent-700)", fontSize: 12, padding: 0 }}>
                check again
              </button>
            )}
          </p>
        </>
      );
    }
    const order: Order = {
      type: "transfer",
      protocol: "erc20",
      symbol: token,
      token: evmToken.address,
      amount: plan.move.toFixed(m.szDecimals),
      chainId: HYPEREVM_ID,
      decimals: evmToken.decimals,
      to: systemAddressForToken(m.tokenIndex),
    };
    return (
      <>
        {balances}
        <OrderRow label="Step 1 of 2" value={`Move ${plan.move} ${token} to Hyperliquid`} />
        <ValidatedExecuteButton order={order} label={`Move ${plan.move} ${token} to Hyperliquid →`} onConfirmed={() => {
            setMoved(true);
            setTimeout(() => setSlow(true), 120_000);
          }} />
      </>
    );
  }

  const usd = plan.sell * m.mid;
  return (
    <>
      {balances}
      <OrderRow label="Sell" value={`${plan.sell} ${token} ≈ $${usd.toLocaleString("en-US", { maximumFractionDigits: 0 })} at ~$${m.mid.toLocaleString("en-US", { maximumFractionDigits: 2 })}`} valueColor="var(--color-accent-700)" />
      <button className="btn btn-primary" style={{ fontSize: 13, marginTop: 6, cursor: "pointer" }} onClick={() => setConfirming(true)}>
        Sell {plan.sell} {token} on Hyperliquid →
      </button>
      <ConfirmDialog
        open={confirming}
        title={`Sell ${token} on Hyperliquid ${envName}`}
        body={
          <div>
            IOC market sell of {plan.sell} {token} on Hyperliquid&apos;s {token}/USDC order book (~${usd.toFixed(2)}): it fills now within 5% of the mid, or not at all. The USDC stays in your Hyperliquid account. The first trade asks your wallet to approve a Meridian trading key once; it can trade, never withdraw.
          </div>
        }
        confirmLabel="Sell"
        warning={envName === "testnet" ? "TESTNET — no real funds." : "Mainnet — real funds. Confirm carefully."}
        onConfirm={() => {
          setConfirming(false);
          setMoved(false);
          void sellSpot({ token, amount: plan.sell, testnet: envName === "testnet" });
        }}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
