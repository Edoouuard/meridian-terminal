"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import type { StakeYieldEntry } from "@/app/api/stake-yield/route";
import { needsLiveCompletion, resolveOrderForLeg, protocolLabel } from "@/lib/assetMap";
import type { Order } from "@/lib/execution";
import { chainIdFromName, legChainId } from "@/lib/chains";
import { ACTIVE_CHAIN_IDS, CHAIN_LABEL, isActiveChain } from "@/lib/onchain";
import { FundsArrivalGate } from "@/components/thread/FundsArrivalGate";
import type { TradeLeg, TradePlan } from "@/lib/tradePlan";
import { explorerUrlFor } from "@/lib/explorer";
import { useStrategyExecutor, type LegStatus } from "@/hooks/useStrategyExecutor";
import { useLivePrices } from "@/hooks/useLivePrices";
import { useVaultRisk } from "@/hooks/useVaultRisk";
import { PHILIDOR_PROTOCOL_ID, philidorAssetQuery } from "@/lib/integrations/philidor";
import { formatBaseUnits } from "@/lib/quote";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { FEATURES } from "@/lib/features";
import { ValidatedExecuteButton } from "@/components/ValidatedExecuteButton";
import { StrategyLegContext } from "@/components/thread/strategyLegContext";
import { confirmStrategyLeg, pairPartnerQty, strategyId, useTrackedStrategies } from "@/lib/strategyTracker";
import { typicalWait } from "@/components/TxProgress";
import { BridgeExecuteButton } from "@/components/BridgeExecuteButton";
import { HyperliquidSpotSellButton } from "@/components/execute/HyperliquidSpotSellButton";
import { HyperliquidSpotBuyButton } from "@/components/execute/HyperliquidSpotBuyButton";
import { isHlSpotBuyLeg } from "@/lib/budgetFit";
import { HyperliquidWithdrawButton } from "@/components/execute/HyperliquidWithdrawButton";
import { ExtendedPerpExecuteButton, LifiPerpExecuteButton, PerpExecuteButton } from "@/components/execute/PerpExecuteButtons";
import { LidoUnstakeButton, MorphoExecuteButton, MorphoWithdrawButton, PendleExecuteButton, SwapExecuteButton } from "@/components/execute/VenueExecuteButtons";
import { NotWired, OrderRow, RISK_TIER_COLOR, isUnsupported, legRowValue } from "@/components/thread/shared";

/**
 * Live vault risk score (Philidor, free API — see lib/integrations/philidor.ts)
 * for a leg's protocol + asset, e.g. supplying USDC on Aave. Only queries for
 * protocols Philidor scores and plain single-token asset symbols (skips
 * PT/perp/swap legs whose `asset` isn't a bare symbol); renders nothing when
 * there is no match or the upstream is unavailable.
 */
export function LegRiskBadge({ leg }: { leg: TradeLeg }) {
  const protocolId = PHILIDOR_PROTOCOL_ID[leg.protocol];
  const plainAsset = /^[A-Za-z]{2,10}$/.test(leg.asset) ? leg.asset : undefined;
  const enabled = !!protocolId && !!plainAsset;
  const { data } = useVaultRisk({ protocol: leg.protocol, asset: plainAsset ? philidorAssetQuery(plainAsset) : plainAsset, limit: 1, enabled });
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

const ARBITRUM_ID = 42161;

/** Renders execution legs for a single strategy. */
export function StrategyLegs({ plan }: { plan: TradePlan }) {
  const { data: prices } = useLivePrices();
  const { chain, address } = useAccount();
  // A venue order that fills (no transaction hash) still completes its step in the tracker.
  const recordFill = (i: number) => (ref: string) => confirmStrategyLeg(plan, i, { hash: ref, owner: address });
  // The second leg of a neutral pair trades the quantity the first one filled.
  const tracked = useTrackedStrategies(address).find((s) => s.id === strategyId(plan));
  const partnerQty = (i: number) => pairPartnerQty(tracked, i);

  const orderAmountDisplay = (order: Order): string =>
    typeof order.amount === "bigint"
      ? `${formatBaseUnits(order.amount, order.decimals ?? 18)} ${order.symbol ?? ""}`
      : `${String(order.amount)} ${order.symbol ?? ""}`;

  if (plan.legs.length === 0) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {plan.fundingNotes && plan.fundingNotes.length > 0 && (
        <div className="risk-note" style={{ border: "1px solid var(--color-divider)" }}>
          <div className="risk-note__label" style={{ color: "var(--color-neutral-500)" }}>Fitted to your wallet</div>
          {plan.fundingNotes.map((n, k) => (
            <span key={k} style={{ color: "var(--color-text)", display: "block" }}>{n}</span>
          ))}
        </div>
      )}
      {plan.legs.map((leg, i) => {
        const resolved = resolveOrderForLeg(leg, undefined, prices, legChainId(leg, chain?.id));
        const legSide = (leg.side || "").toLowerCase();
        const isMorpho = /morpho/i.test(leg.protocol || "");
        const isLido = /lido/i.test(leg.protocol || "");
        const isLidoWithdraw = isLido && (legSide === "withdraw" || legSide === "unstake");
        const isBridge = legSide === "bridge" || /debridge/i.test(leg.protocol || "");
        const isLifiSwap = /li\.?fi/i.test(leg.protocol || "") && !isBridge;
        const isLidoStake = isLido && legSide === "stake";
        // A Hyperliquid deposit is a plain validated USDC transfer on Arbitrum, not a perp order.
        const isHlDeposit = /hyperliquid/i.test(leg.protocol || "") && (legSide === "deposit" || legSide === "supply" || legSide === "fund");
        // Selling UETH/UBTC on Hyperliquid spot: a move from HyperEVM, then a spot order — not a perp.
        const isHlSpotSell = /hyperliquid/i.test(leg.protocol || "") && legSide === "sell";
        // Buying UETH/UBTC on Hyperliquid spot with the account's USDC: the long side of a Hyperliquid neutral position, not a perp.
        const isHlSpotBuy = isHlSpotBuyLeg(leg);
        // Withdrawing USDC from the Hyperliquid account to Arbitrum: a wallet-signed Hyperliquid action, not an EVM order.
        const isHlWithdraw = /hyperliquid/i.test(leg.protocol || "") && legSide === "withdraw";
        // Only an actual position is a perp order: "Stake HYPE" or "Withdraw" on Hyperliquid must never become a short.
        const isPerp = /hyperliquid|extended|ondo|lighter/i.test(leg.protocol || "") && /^(long|short|buy|open)$/.test(legSide) && !isHlSpotSell && !isHlSpotBuy;
        const isVenueOther = /hyperliquid|extended|ondo|lighter/i.test(leg.protocol || "") && !isPerp && !isHlDeposit && !isHlSpotSell && !isHlSpotBuy && !isHlWithdraw;
        const isUniswap = /uniswap/i.test(leg.protocol || "");
        // PendleExecuteButton buys PT; selling or redeeming one is done in the Pendle app.
        const isPendle = /pendle/i.test(leg.protocol || "") && !/^(withdraw|sell|redeem)$/.test(legSide);
        const isPendleExit = /pendle/i.test(leg.protocol || "") && !isPendle;
        const noSize = !(leg.sizeUsd && leg.sizeUsd > 0) && !leg.sizeToken && !isHlSpotSell && !isHlWithdraw;
        // These venues need live data (vault, route, on-chain quote, perp
        // signing) that only their dedicated button fetches — never hand their
        // shell order to the generic button.
        const dedicated = isHlWithdraw || isVenueOther || isPendleExit || isHlSpotSell || isHlSpotBuy || isPerp || isUniswap || isMorpho || isLidoWithdraw || isBridge || isLifiSwap || isPendle;
        const liveVenue = dedicated || isLidoStake;
        const building = isUnsupported(resolved) && !liveVenue;
        // A leg funded by an earlier bridge into its chain waits for the funds.
        const legChain = legChainId(leg, chain?.id);
        const fundedByBridge =
          legChain !== undefined &&
          !isBridge &&
          plan.legs.slice(0, i).some((p) => p.side.toLowerCase() === "bridge" && chainIdFromName(p.toChain) === legChain);
        // A Hyperliquid withdrawal earlier in the plan delivers USDC on Arbitrum: what spends it there (a bridge too) waits for it.
        const fundedByHlWithdraw =
          legChain === ARBITRUM_ID &&
          !isHlWithdraw &&
          plan.legs.slice(0, i).some((p) => /hyperliquid/i.test(p.protocol) && p.side.toLowerCase() === "withdraw");
        const execution = legChain !== undefined && !isActiveChain(legChain) ? (
          <NotWired
            venue={protocolLabel(leg.protocol)}
            reason={`Meridian executes on ${ACTIVE_CHAIN_IDS.map((id) => CHAIN_LABEL[id]).join(", ")} — not ${leg.chain ?? "this chain"}.`}
          />
        ) : noSize ? (
          <NotWired venue={protocolLabel(leg.protocol)} reason="This step came back without an amount. Ask again with the amount you want (e.g. “$500”) so nothing is guessed." />
        ) : dedicated || isUnsupported(resolved) ? (
            isHlWithdraw ? (
              <HyperliquidWithdrawButton leg={leg} />
            ) : isVenueOther ? (
              <NotWired venue={protocolLabel(leg.protocol)} reason={`${leg.side} on ${protocolLabel(leg.protocol)} is done in its own app — Meridian places orders and deposits there.`} />
            ) : isPendleExit ? (
              <NotWired venue="Pendle" reason="Selling or redeeming a PT is done in the Pendle app (app.pendle.finance) for now." />
            ) : isHlSpotSell ? (
              <HyperliquidSpotSellButton leg={leg} />
            ) : isHlSpotBuy ? (
              <HyperliquidSpotBuyButton leg={leg} onFilled={recordFill(i)} />
            ) : isPerp && !FEATURES.perps ? (
              <NotWired venue={leg.protocol} reason="Perps are paused during the beta while spot execution is validated end to end." />
            ) : isPerp && /hyperliquid/i.test(leg.protocol || "") ? (
              <PerpExecuteButton leg={leg} hedged={hedgesSpot(leg, plan.legs)} onFilled={recordFill(i)} baseQty={partnerQty(i)} />
            ) : /extended/i.test(leg.protocol || "") ? (
              <ExtendedPerpExecuteButton leg={leg} prices={prices} onFilled={recordFill(i)} baseQty={partnerQty(i)} />
            ) : /ondo/i.test(leg.protocol || "") ? (
              <LifiPerpExecuteButton leg={leg} prices={prices} provider="ondo" />
            ) : /lighter/i.test(leg.protocol || "") ? (
              <LifiPerpExecuteButton leg={leg} prices={prices} provider="lighter" />
            ) : /uniswap/i.test(leg.protocol || "") ? (
              <SwapExecuteButton leg={leg} prices={prices} />
            ) : isMorpho ? (
              legSide === "withdraw" ? <MorphoWithdrawButton leg={leg} prices={prices} /> : <MorphoExecuteButton leg={leg} prices={prices} />
            ) : isPendle ? (
              <PendleExecuteButton leg={leg} prices={prices} />
            ) : isLidoWithdraw ? (
              <LidoUnstakeButton leg={leg} prices={prices} />
            ) : isBridge ? (
              <BridgeExecuteButton leg={leg} prices={prices} />
            ) : isLifiSwap ? (
              <NotWired venue="LI.FI" reason="Same-chain LI.FI swaps aren't wired yet — cross-chain moves use the Bridge step." />
            ) : isUnsupported(resolved) ? (
              <NotWired venue={protocolLabel(leg.protocol)} reason={resolved.unsupported} />
            ) : null
          ) : (
            <>
              <OrderRow label="Amount" value={orderAmountDisplay(resolved)} valueColor="var(--color-accent-700)" />
              <ValidatedExecuteButton order={resolved} label={`Execute on ${leg.protocol} →`} />
            </>
          );
        return (
          <StrategyLegContext.Provider key={i} value={{ plan, legIndex: i }}>
          <div className="leg-card" style={{ opacity: building ? 0.55 : 1 }}>
            <div className="leg-card__header">
              {plan.legs.length > 1 && <span className="leg-card__step" aria-label={`Step ${i + 1}`}>{i + 1}</span>}
              <span className="leg-card__side">{leg.side}</span>
              <span className="leg-card__detail">{legRowValue(leg)}</span>
            </div>
            {leg.note && <span className="leg-card__note">{leg.note}</span>}
            <LegRiskBadge leg={leg} />
            <StakeYieldBadge leg={leg} />
            {(fundedByBridge || fundedByHlWithdraw) && legChain !== undefined ? (
              <FundsArrivalGate leg={leg} chainId={legChain} prices={prices} from={fundedByHlWithdraw ? "hyperliquid" : "bridge"}>
                {execution}
              </FundsArrivalGate>
            ) : (
              execution
            )}
          </div>
          </StrategyLegContext.Provider>
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
export function ExecuteStrategyButton({ plan }: { plan: TradePlan }) {
  const { data: prices } = useLivePrices();
  const { chain, isConnected, address } = useAccount();
  const { progress, executeAll, cancel, reset } = useStrategyExecutor();
  const [confirming, setConfirming] = useState(false);

  // One-click execution only when EVERY leg resolves to a directly signable
  // order: running a subset (e.g. "supply on Optimism" without its bridge)
  // could leave the user half-way through a strategy.
  const connectedChainId = chain?.id;
  const resolvedOrders = useMemo(() => {
    const results: { leg: TradeLeg; order: Order; legIndex: number }[] = [];
    let allSignable = true;
    plan.legs.forEach((leg, i) => {
      const resolved = resolveOrderForLeg(leg, undefined, prices, legChainId(leg, connectedChainId));
      if (isUnsupported(resolved) || needsLiveCompletion(resolved)) allSignable = false;
      else results.push({ leg, order: resolved, legIndex: i });
    });
    return allSignable ? results : [];
  }, [plan.legs, prices, connectedChainId]);

  // Each leg the batch run confirms is recorded against the strategy (once per hash).
  const recorded = useRef(new Set<string>());
  useEffect(() => {
    progress.legs.forEach((lp, i) => {
      const entry = resolvedOrders[i];
      if (lp.status !== "confirmed" || !lp.hash || !entry || recorded.current.has(lp.hash)) return;
      recorded.current.add(lp.hash);
      confirmStrategyLeg(plan, entry.legIndex, { hash: lp.hash, chainId: entry.order.chainId, owner: address });
    });
  }, [progress.legs, resolvedOrders, plan, address]);

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
        {progress.status === "running" && (() => {
          const current = progress.legs[progress.currentLeg];
          const entry = resolvedOrders[progress.currentLeg];
          if (!current || !entry) return null;
          const chain = CHAIN_LABEL[entry.order.chainId] ?? "the network";
          const waitingWallet = current.status === "approving" || current.status === "executing" || current.status === "switching-chain";
          return (
            <p className="txp__hint" style={{ fontSize: 11 }}>
              {waitingWallet
                ? "Check your wallet: each step asks for its own signature. Nothing moves until you approve it."
                : `Waiting for ${chain} to confirm (${typicalWait(entry.order.chainId)}). Your funds are safe meanwhile.`}
            </p>
          );
        })()}
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

/** A short whose asset the plan also holds spot (ETH vs wstETH, weETH, WETH): a hedge, not a bet. */
export function hedgesSpot(perp: TradeLeg, legs: TradeLeg[]): boolean {
  if (!/^short$/i.test(perp.side.trim())) return false;
  const base = perp.asset.replace(/[-\s]?PERP$/i, "").trim().toUpperCase();
  if (!base) return false;
  return legs.some((l) => l !== perp && !/^(long|short)$/i.test(l.side.trim()) && l.asset.toUpperCase().split(/[\s→]+/).some((t) => t.endsWith(base)));
}
