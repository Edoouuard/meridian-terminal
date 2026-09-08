"use client";

import { useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import type { YieldSnapshot } from "@/app/api/yield/route";
import { ThreadCard } from "@/components/ThreadCard";
import { RiskPanel } from "@/components/RiskPanel";
import { TickerBanner } from "@/components/TickerBanner";
import { WalletConnectButton } from "@/components/WalletConnectButton";
import { HistoryPanel } from "@/components/HistoryPanel";
import { HyperliquidPanel } from "@/components/HyperliquidPanel";
import { ExtendedConnectPanel } from "@/components/ExtendedConnectPanel";
import { LidoWithdrawalsPanel } from "@/components/LidoWithdrawalsPanel";
import { ChainOverview } from "@/components/ChainOverview";
import { VaultRiskPanel } from "@/components/VaultRiskPanel";
import { SolanaPanel } from "@/components/SolanaPanel";
import { LiveAsset, LivePortfolio, useLivePortfolio } from "@/hooks/useLivePortfolio";
import { useLiveFeed } from "@/hooks/useLiveFeed";
import { NewsFeed } from "@/components/NewsFeed";
import { CHAIN_LABEL, SUPPORTED_CHAINS } from "@/lib/onchain";
import { EXAMPLE_THESIS_FOR_TYPE, routeThesis } from "@/lib/routeThesis";
import { recordExecution } from "@/lib/history";

// Expose the local order-history API on the page module so real execution
// sites (ThreadCard's useExecute / useHyperliquid) can log orders going
// forward: `recordExecution({ type, label, amount, asset, protocol, chainId, status, hash })`.
export { recordExecution };

const CHAIN_NAMES = SUPPORTED_CHAINS.map((c) => CHAIN_LABEL[c.id]).join(", ");
import {
  ALLOCATION,
  HIGHLIGHT,
  PORTFOLIO_VALUE,
  POSITIONS,
  ROTATION_BARS,
  ThreadItem,
  ThreadType,
  fmtUsd,
} from "@/lib/data";

const ALLOCATION_COLORS = [
  "var(--color-accent-700)",
  "var(--color-accent-500)",
  "var(--color-accent-300)",
  "var(--color-neutral-500)",
  "var(--color-neutral-300)",
];

function fmtUsdCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function formatAssetAmount(asset: LiveAsset): string {
  if (asset.usd > 0) return fmtUsd(asset.usd);
  return `${asset.balance.toFixed(4)} ${asset.symbol}`;
}

function buildLiveAllocation(live: LivePortfolio): { label: string; pct: number; color: string }[] {
  const slices = live.assets.map((a) => ({ label: `${a.symbol} · ${a.chain}`, usd: a.usd }));
  const aaveNet = live.aaveCollateralUsd - live.aaveDebtUsd;
  if (aaveNet > 0) slices.push({ label: "Aave (net)", usd: aaveNet });

  const total = slices.reduce((sum, s) => sum + s.usd, 0);
  if (total <= 0) return [];

  slices.sort((a, b) => b.usd - a.usd);
  const top = slices.slice(0, 4);
  const restUsd = slices.slice(4).reduce((sum, s) => sum + s.usd, 0);
  const finalSlices = restUsd > 0 ? [...top, { label: "Other", usd: restUsd }] : top;

  return finalSlices.map((s, i) => ({
    label: s.label,
    pct: Math.round((s.usd / total) * 1000) / 10,
    color: ALLOCATION_COLORS[i],
  }));
}

export default function TerminalApp() {
  const [thread, setThread] = useState<ThreadItem[]>([
    routeThesis(EXAMPLE_THESIS_FOR_TYPE.pendle),
    routeThesis(EXAMPLE_THESIS_FOR_TYPE.betaneutral),
  ]);
  const [promptText, setPromptText] = useState("");

  const { isConnected } = useAccount();
  const live = useLivePortfolio();
  const feed = useLiveFeed();
  const { data: yieldSnapshot, isLoading: yieldLoading } = useQuery<YieldSnapshot | null>({
    queryKey: ["yield-snapshot"],
    queryFn: async () => {
      const res = await fetch("/api/yield");
      if (!res.ok) throw new Error("yield fetch failed");
      return res.json();
    },
    staleTime: 5 * 60_000,
  });

  const isLiveFeed = !feed.loading && !!feed.data;

  // Live top-movers / flow list — built from Hyperliquid metaAndAssetCtxs.
  // Use 24h notional (dayNtlVlm) as the flow proxy, normalised into bar widths.
  const liveBars =
    isLiveFeed && feed.data?.highlights && feed.data.highlights.movers.length > 0
      ? feed.data.highlights.movers.map((m) => ({
          name: m.coin,
          width: "0%",
          color: m.changePct >= 0 ? "var(--color-accent-700)" : "var(--color-neutral-600)",
          value: `${m.changePct >= 0 ? "+" : ""}${m.changePct.toFixed(1)}%`,
          flow: m.dayNtlVlm,
        }))
      : null;

  // Compute relative bar widths from the largest flow.
  let displayBars = ROTATION_BARS;
  if (liveBars && liveBars.length > 0) {
    const maxFlow = Math.max(...liveBars.map((b) => b.flow), 1);
    displayBars = liveBars.map((b) => ({ ...b, width: `${Math.max(4, Math.round((b.flow / maxFlow) * 100))}%` }));
  }

  // Live "fastest growing" card from the same metadata.
  const fastestLive = isLiveFeed ? feed.data?.highlights?.fastest : null;
  const displayHighlight = fastestLive
    ? {
        protocol: fastestLive.coin,
        chg: `${fastestLive.changePct >= 0 ? "+" : ""}${fastestLive.changePct.toFixed(1)}%`,
        tvlStart: "24h vol",
        tvlEnd: fmtUsdCompact(fastestLive.dayNtlVlm) || "$—",
        points: HIGHLIGHT.points,
      }
    : HIGHLIGHT;

  const displayPortfolioValue = isConnected ? live.netUsd : PORTFOLIO_VALUE;

  const livePositions = [
    ...live.assets.map((a) => ({ asset: a.symbol, venue: `${a.venue} · ${a.chain}`, amount: formatAssetAmount(a) })),
    ...live.aavePositions.flatMap((p) => [
      ...(p.collateralUsd > 0 ? [{ asset: `${p.protocol} supply`, venue: p.chain, amount: fmtUsd(p.collateralUsd) }] : []),
      ...(p.debtUsd > 0 ? [{ asset: `${p.protocol} borrow`, venue: p.chain, amount: "-" + fmtUsd(p.debtUsd) }] : []),
    ]),
  ];
  const displayPositions = isConnected ? livePositions : POSITIONS;
  const displayAllocation = isConnected ? buildLiveAllocation(live) : ALLOCATION;

  const usedTypes = new Set(thread.map((t) => t.type));

  // Quick-prompt buttons and news/alpha "discuss" links both land here. Routes
  // through the real engine (routeThesis) rather than pushing static demo
  // content, so what's shown always reflects actual live-execution status —
  // no separate hardcoded card that can silently go stale once a venue gets
  // wired up for real.
  function addExample(type: ThreadType, text?: string) {
    const thesis = text ?? (type !== "custom" ? EXAMPLE_THESIS_FOR_TYPE[type] : undefined);
    const routed = thesis ? routeThesis(thesis) : { type, text };
    setThread((cur) => {
      // Dedup-by-type only applies to the canned quick-prompt buttons (no
      // explicit text). A "Discuss ->" click from a live news mover always
      // carries its own distinct text (a specific coin) and should always be
      // added, even when another thread of the same resolved type exists.
      if (!text && cur.some((t) => t.type === routed.type)) return cur;
      return cur.concat([routed]);
    });
  }

  function submitPrompt() {
    const text = promptText.trim();
    if (!text) return;
    const routed = routeThesis(text);
    setThread((cur) => (cur.some((t) => t.type === routed.type) && routed.type !== "custom" ? cur : cur.concat([routed])));
    setPromptText("");
  }

  return (
    <div style={{ background: "var(--color-bg)", color: "var(--color-text)", height: "100vh", display: "flex", flexDirection: "column" }}>
      <TickerBanner />
      <div className="nav" style={{ background: "var(--color-surface)", flex: "none" }}>
        <Link href="/" className="nav-brand" style={{ color: "var(--color-text)" }}>
          Meridian
        </Link>
        <span className="text-muted" style={{ fontSize: 13 }}>
          {isConnected ? `${SUPPORTED_CHAINS.length} chains · connected` : `${SUPPORTED_CHAINS.length} chains · not connected`}
        </span>
        <WalletConnectButton />
        <span className="tag tag-neutral" style={{ fontVariantNumeric: "tabular-nums" }}>
          {fmtUsd(displayPortfolioValue)}
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "290px 1fr 320px", overflow: "hidden" }}>
        {/* Portfolio column */}
        <div className="col-scroll" style={{ minWidth: 0, borderRight: "1px solid var(--color-divider)", padding: "var(--space-4)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <h6 style={{ color: "var(--color-accent)", margin: 0 }}>Portfolio</h6>
            <span className="text-muted" style={{ fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase" }}>
              {isConnected ? "Live" : "Example"}
            </span>
          </div>
          <p
            style={{
              fontFamily: "var(--font-heading)",
              fontSize: 28,
              margin: "0 0 var(--space-3)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {fmtUsd(displayPortfolioValue)}
          </p>

          {displayAllocation.length > 0 && (
            <>
              <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", marginBottom: "var(--space-2)" }}>
                {displayAllocation.map((a) => (
                  <div key={a.label} style={{ width: `${a.pct}%`, background: a.color }} />
                ))}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, marginBottom: "var(--space-4)" }}>
                {displayAllocation.map((a) => (
                  <div key={a.label} style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>{a.label}</span>
                    <span className="text-muted">{a.pct}%</span>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="hr" style={{ margin: "var(--space-3) 0" }} />
          <h6 style={{ color: "var(--color-accent)" }}>Positions</h6>
          <div style={{ display: "flex", flexDirection: "column", marginTop: "var(--space-2)" }}>
            {displayPositions.map((pos, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  padding: "6px 0",
                  borderBottom: "1px solid var(--color-divider)",
                  fontSize: 12,
                }}
              >
                <span>
                  {pos.asset}
                  <span className="text-muted"> · {pos.venue}</span>
                </span>
                <span style={{ fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{pos.amount}</span>
              </div>
            ))}
            {isConnected && livePositions.length === 0 && (
              <p style={{ fontSize: 12, margin: "6px 0 0" }} className="text-muted">
                {live.isLoading
                  ? "Reading your wallet balances and Aave position…"
                  : `No tracked assets or Aave position found across ${CHAIN_NAMES}. Connect an Extended account (left panel) to trade Extended perps — Variational and Pendle aren't wired up yet.`}
              </p>
            )}
          </div>

          <RiskPanel live={live} isConnected={isConnected} />
                    <VaultRiskPanel />
                    <HyperliquidPanel />
                    <ExtendedConnectPanel />
                    <LidoWithdrawalsPanel />
                    <HistoryPanel />
                    <ChainOverview />
                    <SolanaPanel />
                  </div>

        {/* Trade column */}
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0, padding: "var(--space-4)" }}>
          <div
            className="col-scroll"
            style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column", gap: "var(--space-3)", paddingRight: 4 }}
          >
            <p className="card-kicker" style={{ margin: 0 }}>
              This week in DeFi
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: "var(--space-3)", minWidth: 0 }}>
              <div className="card" style={{ gap: 6, padding: "var(--space-2)", minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: 12, fontWeight: 600, fontFamily: "var(--font-heading)" }}>
                  Net TVL flows, 7 days{liveBars && liveBars.length > 0 ? "" : " (example)"}
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 2, minWidth: 0 }}>
                  {displayBars.map((rb) => (
                    <div key={rb.name} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, minWidth: 0 }}>
                      <span style={{ width: 64, flex: "none", height: 15, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                        {rb.name}
                      </span>
                      <div style={{ flex: 1, minWidth: 0, height: 8, background: "var(--color-neutral-200)", borderRadius: 2, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: rb.width, background: rb.color, borderRadius: 2 }} />
                      </div>
                      <span style={{ width: 36, flex: "none", textAlign: "right", fontVariantNumeric: "tabular-nums", color: rb.color }}>
                        {rb.value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                <div className="card" style={{ gap: 4, padding: "var(--space-3)" }}>
                  <p style={{ margin: 0, fontSize: 12, fontWeight: 600, fontFamily: "var(--font-heading)" }}>
                    Fastest growing: {displayHighlight.protocol}
                    {fastestLive ? "" : " (example)"}
                  </p>
                  <p style={{ margin: 0, fontSize: 11 }} className="text-muted">
                    {displayHighlight.tvlStart} → <strong style={{ color: "var(--color-text)" }}>{displayHighlight.tvlEnd}</strong>{" "}
                    <span style={{ color: "var(--color-accent-700)" }}>({displayHighlight.chg})</span>
                  </p>
                  <svg width="100%" height="24" viewBox="0 0 36 24" preserveAspectRatio="none">
                    <polyline points={displayHighlight.points} fill="none" stroke="var(--color-accent)" strokeWidth={1.6} />
                  </svg>
                </div>
                <div className="card" style={{ gap: 4, padding: "var(--space-3)" }}>
                  <p style={{ margin: 0, fontSize: 12, fontWeight: 600, fontFamily: "var(--font-heading)" }}>Aave USDC variable APY, live</p>
                  {yieldSnapshot ? (
                    <>
                      <p style={{ margin: 0, fontSize: 22, fontFamily: "var(--font-heading)", fontVariantNumeric: "tabular-nums" }}>
                        {yieldSnapshot.apy.toFixed(2)}%
                      </p>
                      <p style={{ margin: 0, fontSize: 11 }} className="text-muted">
                        {yieldSnapshot.apyPct7D !== null
                          ? `${yieldSnapshot.apyPct7D >= 0 ? "+" : ""}${yieldSnapshot.apyPct7D.toFixed(2)}pp over 7 days`
                          : "7-day trend unavailable"}
                        {yieldSnapshot.apyPct30D !== null &&
                          ` · ${yieldSnapshot.apyPct30D >= 0 ? "+" : ""}${yieldSnapshot.apyPct30D.toFixed(2)}pp over 30 days`}
                      </p>
                    </>
                  ) : (
                    <p style={{ margin: 0, fontSize: 11 }} className="text-muted">
                      {yieldLoading ? "Fetching live yield data…" : "No live yield data right now."}
                    </p>
                  )}
                </div>
              </div>
            </div>

            <div className="hr" style={{ margin: 0 }} />

            <h6 style={{ color: "var(--color-accent)", flex: "none" }}>Prompt to trade</h6>
            <div style={{ maxWidth: "80%" }}>
              <p style={{ margin: 0, fontSize: 14, color: "color-mix(in srgb, var(--color-text) 70%, transparent)" }}>
                Describe a thesis. I will translate it into an executable order across Aave, Morpho, Lido, Pendle, Hyperliquid, Extended,
                Variational, or Uniswap.
              </p>
            </div>

            {thread.map((item, i) => (
              <ThreadCard key={i} item={item} />
            ))}

            {isConnected && live.isLoading && (
              <p style={{ margin: 0, fontSize: 12 }} className="text-muted">
                Loading your live positions…
              </p>
            )}

            {thread.length === 0 && (
              <div className="card" style={{ gap: 6, padding: "var(--space-3)" }}>
                <p style={{ margin: 0, fontSize: 12, fontWeight: 600, fontFamily: "var(--font-heading)" }}>
                  No positions yet
                </p>
                <p style={{ margin: 0, fontSize: 12 }} className="text-muted">
                  Describe a thesis above or add an example to draft your first order.
                </p>
              </div>
            )}
          </div>

          <div style={{ flex: "none", display: "flex", gap: 6, flexWrap: "wrap", margin: "var(--space-3) 0 var(--space-2)" }}>
            <button
              className="btn btn-secondary"
              style={{ fontSize: 12, opacity: 0.6, borderStyle: "dashed" }}
              disabled={usedTypes.has("pendle")}
              onClick={() => addExample("pendle")}
              title="Pendle isn't wired for live execution yet"
            >
              Lock a fixed yield · Building
            </button>
            <button
              className="btn btn-secondary"
              style={{ fontSize: 12 }}
              disabled={usedTypes.has("betaneutral")}
              onClick={() => addExample("betaneutral")}
            >
              Beta neutral ETH
            </button>
            <button className="btn btn-secondary" style={{ fontSize: 12 }} disabled={usedTypes.has("perp")} onClick={() => addExample("perp")}>
              Directional perp
            </button>
            <button className="btn btn-secondary" style={{ fontSize: 12 }} disabled={usedTypes.has("swap")} onClick={() => addExample("swap")}>
              Swap
            </button>
            <button className="btn btn-secondary" style={{ fontSize: 12 }} disabled={usedTypes.has("hedge")} onClick={() => addExample("hedge")}>
              Hedge my portfolio
            </button>
          </div>
          <div style={{ flex: "none", display: "flex", gap: 8 }}>
            <input
              className="input"
              placeholder="e.g. Lock in a fixed rate on my stETH before it drops"
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitPrompt();
              }}
            />
            <button className="btn btn-primary btn-icon" aria-label="Send" onClick={submitPrompt}>
              →
            </button>
          </div>
        </div>

        {/* News / Alpha column */}
        <div className="col-scroll" style={{ minWidth: 0, borderLeft: "1px solid var(--color-divider)", padding: "var(--space-4)" }}>
          <NewsFeed feed={feed} onAddThread={addExample} />
        </div>
      </div>
    </div>
  );
}
