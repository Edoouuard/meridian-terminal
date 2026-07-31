"use client";

import { useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { ThreadCard } from "@/components/ThreadCard";
import { RiskPanel } from "@/components/RiskPanel";
import { TickerBanner } from "@/components/TickerBanner";
import { WalletConnectButton } from "@/components/WalletConnectButton";
import { LiveAsset, LivePortfolio, useLivePortfolio } from "@/hooks/useLivePortfolio";
import { CHAIN_LABEL, SUPPORTED_CHAINS } from "@/lib/onchain";
import { routeThesis } from "@/lib/routeThesis";

const CHAIN_NAMES = SUPPORTED_CHAINS.map((c) => CHAIN_LABEL[c.id]).join(", ");
import {
  ALLOCATION,
  ALPHA,
  AlphaTag,
  HIGHLIGHT,
  NEWS,
  PORTFOLIO_VALUE,
  POSITIONS,
  ROTATION_BARS,
  ThreadItem,
  ThreadType,
  YIELD_CHART,
  fmtUsd,
} from "@/lib/data";

const ALPHA_TAG_CLASS: Record<AlphaTag, string> = {
  "New protocol": "tag-neutral",
  "Points farm": "tag-accent",
  "Airdrop rumor": "tag-outline",
};

const ALLOCATION_COLORS = [
  "var(--color-accent-700)",
  "var(--color-accent-500)",
  "var(--color-accent-300)",
  "var(--color-neutral-500)",
  "var(--color-neutral-300)",
];

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
  const [thread, setThread] = useState<ThreadItem[]>([{ type: "pendle" }, { type: "betaneutral" }]);
  const [promptText, setPromptText] = useState("");
  const [executed, setExecuted] = useState<Record<string, boolean>>({});
  const [feedTab, setFeedTab] = useState<"news" | "alpha">("news");

  const { isConnected } = useAccount();
  const live = useLivePortfolio();

  const displayPortfolioValue = isConnected ? live.netUsd : PORTFOLIO_VALUE;

  const livePositions = [
    ...live.assets.map((a) => ({ asset: a.symbol, venue: `${a.venue} · ${a.chain}`, amount: formatAssetAmount(a) })),
    ...live.aavePositions.flatMap((p) => [
      ...(p.collateralUsd > 0 ? [{ asset: "Aave supply", venue: p.chain, amount: fmtUsd(p.collateralUsd) }] : []),
      ...(p.debtUsd > 0 ? [{ asset: "Aave borrow", venue: p.chain, amount: "-" + fmtUsd(p.debtUsd) }] : []),
    ]),
  ];
  const displayPositions = isConnected ? livePositions : POSITIONS;
  const displayAllocation = isConnected ? buildLiveAllocation(live) : ALLOCATION;

  const usedTypes = new Set(thread.map((t) => t.type));

  function addExample(type: ThreadType, text?: string) {
    setThread((cur) => (cur.some((t) => t.type === type) ? cur : cur.concat([{ type, text }])));
  }

  function markExecuted(type: ThreadType) {
    setExecuted((cur) => ({ ...cur, [type]: true }));
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
                  : `No tracked assets or Aave position found across ${CHAIN_NAMES}. Morpho, Pendle, Hyperliquid, Extended, Variational, and Uniswap aren't wired up yet.`}
              </p>
            )}
          </div>

          <RiskPanel liveAave={isConnected ? live.riskAave : undefined} isConnected={isConnected} />
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
                <p style={{ margin: 0, fontSize: 12, fontWeight: 600, fontFamily: "var(--font-heading)" }}>Net TVL flows, 7 days</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 2, minWidth: 0 }}>
                  {ROTATION_BARS.map((rb) => (
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
                    Fastest growing: {HIGHLIGHT.protocol}
                  </p>
                  <p style={{ margin: 0, fontSize: 11 }} className="text-muted">
                    TVL {HIGHLIGHT.tvlStart} → <strong style={{ color: "var(--color-text)" }}>{HIGHLIGHT.tvlEnd}</strong> in 30 days (
                    <span style={{ color: "var(--color-accent-700)" }}>{HIGHLIGHT.chg}</span>)
                  </p>
                  <svg width="100%" height="24" viewBox="0 0 36 24" preserveAspectRatio="none">
                    <polyline points={HIGHLIGHT.points} fill="none" stroke="var(--color-accent)" strokeWidth={1.6} />
                  </svg>
                </div>
                <div className="card" style={{ gap: 4, padding: "var(--space-3)" }}>
                  <p style={{ margin: 0, fontSize: 12, fontWeight: 600, fontFamily: "var(--font-heading)" }}>Yield, 30 days: lock now or wait?</p>
                  <svg width="100%" height="30" viewBox="0 0 36 30" preserveAspectRatio="none">
                    <polyline points={YIELD_CHART.fixedPoints} fill="none" stroke="var(--color-accent)" strokeWidth={1.6} />
                    <polyline
                      points={YIELD_CHART.varPoints}
                      fill="none"
                      stroke="var(--color-neutral-500)"
                      strokeWidth={1.6}
                      strokeDasharray="2,2"
                    />
                  </svg>
                  <p style={{ margin: 0, fontSize: 11 }}>
                    <span style={{ color: "var(--color-accent-700)" }}>Pendle fixed, steady at 9.8%</span>
                  </p>
                  <p style={{ margin: 0, fontSize: 11 }} className="text-muted">
                    Aave variable, down from 6.8% to 5.2%
                  </p>
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
              <ThreadCard
                key={i}
                item={item}
                executed={!!executed[item.type]}
                onExecute={() => markExecuted(item.type)}
              />
            ))}
          </div>

          <div style={{ flex: "none", display: "flex", gap: 6, flexWrap: "wrap", margin: "var(--space-3) 0 var(--space-2)" }}>
            <button className="btn btn-secondary" style={{ fontSize: 12 }} disabled={usedTypes.has("pendle")} onClick={() => addExample("pendle")}>
              Lock a fixed yield
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
          <h6 style={{ color: "var(--color-accent)" }}>{feedTab === "news" ? "DeFi news" : "Alpha"}</h6>
          <div className="seg" style={{ marginBottom: "var(--space-2)" }}>
            <label className="seg-opt">
              <input type="radio" name="feed-tab" checked={feedTab === "news"} onChange={() => setFeedTab("news")} />
              <span>News</span>
            </label>
            <label className="seg-opt">
              <input type="radio" name="feed-tab" checked={feedTab === "alpha"} onChange={() => setFeedTab("alpha")} />
              <span>Alpha</span>
            </label>
          </div>

          {feedTab === "news" ? (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {NEWS.map((n, i) => (
                <div key={i} style={{ padding: "var(--space-2) 0", borderBottom: "1px solid var(--color-divider)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span className="tag tag-accent" style={{ marginBottom: 4 }}>
                      {n.protocol}
                    </span>
                    <span style={{ fontSize: 12, fontVariantNumeric: "tabular-nums", color: "var(--color-accent-700)" }}>{n.metric}</span>
                  </div>
                  <p style={{ margin: "4px 0 0", fontSize: 13, lineHeight: 1.4 }}>{n.text}</p>
                  {n.action && (
                    <a
                      href="#"
                      style={{ textDecoration: "none", fontSize: 12 }}
                      onClick={(e) => {
                        e.preventDefault();
                        addExample(n.action as ThreadType);
                      }}
                    >
                      Discuss →
                    </a>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {ALPHA.map((a, i) => (
                <div key={i} style={{ padding: "var(--space-2) 0", borderBottom: "1px solid var(--color-divider)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span className={`tag ${ALPHA_TAG_CLASS[a.tag]}`} style={{ marginBottom: 4 }}>
                      {a.protocol}
                    </span>
                    <span style={{ fontSize: 12, fontVariantNumeric: "tabular-nums", color: "var(--color-accent-700)" }}>{a.metric}</span>
                  </div>
                  <p style={{ margin: "4px 0 0", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase" }} className="text-muted">
                    {a.tag}
                  </p>
                  <p style={{ margin: "4px 0 0", fontSize: 13, lineHeight: 1.4 }}>{a.text}</p>
                  {a.action && (
                    <a
                      href="#"
                      style={{ textDecoration: "none", fontSize: 12 }}
                      onClick={(e) => {
                        e.preventDefault();
                        addExample(a.action as ThreadType);
                      }}
                    >
                      Add to thread →
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
