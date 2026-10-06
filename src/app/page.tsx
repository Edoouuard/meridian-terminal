"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { ThreadCard } from "@/components/ThreadCard";
import { RiskPanel } from "@/components/RiskPanel";
import { TickerBanner } from "@/components/TickerBanner";
import { WalletConnectButton } from "@/components/WalletConnectButton";
import { HistoryPanel } from "@/components/HistoryPanel";
import { HyperliquidPanel } from "@/components/HyperliquidPanel";
import { ExtendedConnectPanel } from "@/components/ExtendedConnectPanel";
import { LifiPerpsConnectPanel } from "@/components/LifiPerpsConnectPanel";
import { LidoWithdrawalsPanel } from "@/components/LidoWithdrawalsPanel";
import { VaultRiskPanel } from "@/components/VaultRiskPanel";
import { SolanaPanel } from "@/components/SolanaPanel";
import { McpStatusPanel } from "@/components/McpStatusPanel";
import { LiveAsset, LivePortfolio, useLivePortfolio } from "@/hooks/useLivePortfolio";
import { useHaikuPortfolio } from "@/hooks/useHaikuPortfolio";
import { NewsFeed } from "@/components/NewsFeed";
import { CHAIN_LABEL, SUPPORTED_CHAINS } from "@/lib/onchain";
import { routeThesis, type TradePlan } from "@/lib/routeThesis";
import { routeThesisAsync, type PortfolioContext } from "@/lib/intentEngine";
import { recordExecution } from "@/lib/history";

// Expose the local order-history API on the page module so real execution
// sites (ThreadCard's useExecute / useHyperliquid) can log orders going
// forward: `recordExecution({ type, label, amount, asset, protocol, chainId, status, hash })`.
export { recordExecution };

const CHAIN_NAMES = SUPPORTED_CHAINS.map((c) => CHAIN_LABEL[c.id]).join(", ");
import {
  ALLOCATION,
  PORTFOLIO_VALUE,
  POSITIONS,
  ThreadItem,
  fmtUsd,
} from "@/lib/data";

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
  const [thread, setThread] = useState<ThreadItem[]>([]);
  const [promptText, setPromptText] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [pendingText, setPendingText] = useState("");
  const [analyzeStep, setAnalyzeStep] = useState(0);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Everything below Positions used to stack 9 panels in one long scroll
  // (Risk, Vault risk, 4 venue connect panels, History, Chains, Solana) --
  // grouped into tabs so the left column stays scannable instead of dense.
  const [leftTab, setLeftTab] = useState<"risk" | "venues" | "activity">("risk");

  const { isConnected } = useAccount();
  const live = useLivePortfolio();
  const haikuData = useHaikuPortfolio();

  // Merge Haiku MCP data into portfolio value when available
  const haikuExtraUsd = haikuData.totalBalancesUsd + haikuData.totalPositionsUsd;
  const displayPortfolioValue = isConnected ? live.netUsd + haikuExtraUsd : PORTFOLIO_VALUE;

  // Build live positions from on-chain data + Haiku MCP enrichment
  const livePositions = [
    ...live.assets.map((a) => ({ asset: a.symbol, venue: `${a.venue} · ${a.chain}`, amount: formatAssetAmount(a) })),
    ...live.aavePositions.flatMap((p) => [
      ...(p.collateralUsd > 0 ? [{ asset: `${p.protocol} supply`, venue: p.chain, amount: fmtUsd(p.collateralUsd) }] : []),
      ...(p.debtUsd > 0 ? [{ asset: `${p.protocol} borrow`, venue: p.chain, amount: "-" + fmtUsd(p.debtUsd) }] : []),
    ]),
    // Haiku MCP: DeFi positions from protocols not tracked by wagmi multicall
    ...haikuData.positions
      .filter((p) => p.depositedUsd > 1)
      .map((p) => ({
        asset: `${p.protocol} ${p.type}`,
        venue: `${p.asset} · chain ${p.chainId}`,
        amount: fmtUsd(p.depositedUsd),
      })),
  ];
  const displayPositions = isConnected ? livePositions : POSITIONS;
  const displayAllocation = isConnected ? buildLiveAllocation(live) : ALLOCATION;

  // Auto-scroll to bottom when thread changes or analysis starts
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread, isAnalyzing, pendingText]);

  // Submit a thesis to the LLM engine (used by both input and quick prompts)
  async function submitThesis(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isAnalyzing) return;
    setPromptText("");
    setPendingText(trimmed);
    setIsAnalyzing(true);
    setAnalyzeStep(0);

    // Animate loading steps
    const stepTimers = [
      setTimeout(() => setAnalyzeStep(1), 800),
      setTimeout(() => setAnalyzeStep(2), 2200),
    ];

    // Snapshot the live portfolio for the LLM (only if wallet connected)
    // Free balance = wallet token holdings (idle assets not locked in protocols)
    const freeBalanceUsd = live.assetsUsd;
    const portfolioSnapshot: PortfolioContext | undefined = live.isConnected
      ? {
          netUsd: live.netUsd,
          freeBalanceUsd,
          assets: live.assets,
          lendingPositions: live.aavePositions,
          perps: live.perps,
          netDeltaEthTotal: live.netDeltaEthTotal,
        }
      : undefined;

    try {
      const routed = await routeThesisAsync(trimmed, portfolioSnapshot);
      setThread((cur) => cur.concat([routed]));
    } catch {
      setThread((cur) => cur.concat([routeThesis(trimmed)]));
    } finally {
      stepTimers.forEach(clearTimeout);
      setIsAnalyzing(false);
      setPendingText("");
      setAnalyzeStep(0);
    }
  }

  function selectVariant(index: number, plan: TradePlan) {
    setThread((cur) => cur.map((item, i) => (i === index ? { ...item, plan } : item)));
  }

  const QUICK_PROMPTS = [
    { label: "Yield on stables", thesis: "I want the best yield on my USDC across all protocols" },
    { label: "ETH exposure", thesis: "I want exposure to ETH with different risk levels" },
    { label: "Farm airdrops", thesis: "I want to farm airdrops and points with a delta-neutral strategy" },
    { label: "Hedge portfolio", thesis: "I need to hedge my ETH exposure, I think the market is going down" },
    { label: "Stake ETH", thesis: "I want to stake my ETH for yield, what are the best options?" },
  ];

  const FOLLOW_UPS = [
    { label: "Lower risk", thesis: "Same idea but more conservative, less leverage" },
    { label: "More yield", thesis: "I want to push for higher yield, I can take more risk" },
    { label: "On Arbitrum", thesis: "Show me the same strategies but on Arbitrum" },
    { label: "Delta neutral", thesis: "Make it delta neutral, I don't want directional exposure" },
  ];

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
                  : `No tracked assets or Aave position found across ${CHAIN_NAMES}. Connect Extended, Ondo, or Lighter (left panel) to trade their perps — Variational and Pendle aren't wired up yet.`}
              </p>
            )}
          </div>

          <div className="hr" style={{ margin: "var(--space-3) 0" }} />
          <div className="seg" style={{ marginBottom: "var(--space-2)" }}>
            <label className="seg-opt">
              <input type="radio" name="left-tab" checked={leftTab === "risk"} onChange={() => setLeftTab("risk")} />
              <span>Risk</span>
            </label>
            <label className="seg-opt">
              <input type="radio" name="left-tab" checked={leftTab === "venues"} onChange={() => setLeftTab("venues")} />
              <span>Venues</span>
            </label>
            <label className="seg-opt">
              <input type="radio" name="left-tab" checked={leftTab === "activity"} onChange={() => setLeftTab("activity")} />
              <span>Activity</span>
            </label>
          </div>

          {leftTab === "risk" && (
            <>
              <RiskPanel live={live} isConnected={isConnected} />
              <VaultRiskPanel />
            </>
          )}
          {leftTab === "venues" && (
            <>
              <McpStatusPanel />
              <HyperliquidPanel />
              <ExtendedConnectPanel />
              <LifiPerpsConnectPanel provider="ondo" />
              <LifiPerpsConnectPanel provider="lighter" />
              <LidoWithdrawalsPanel />
              <SolanaPanel />
            </>
          )}
          {leftTab === "activity" && <HistoryPanel />}
        </div>

        {/* Trade column — chat-first layout */}
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>
          {/* Scrollable thread area */}
          <div
            ref={scrollContainerRef}
            className="col-scroll"
            style={{
              flex: 1,
              minHeight: 0,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-3)",
              padding: "var(--space-4)",
              paddingBottom: "var(--space-2)",
            }}
          >
            {thread.length === 0 && !isAnalyzing && (
              <div style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "var(--space-6)",
                padding: "var(--space-8) var(--space-4)",
                textAlign: "center",
              }}>
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", alignItems: "center" }}>
                  <h3 style={{
                    fontFamily: "var(--font-heading)",
                    color: "var(--color-text)",
                    margin: 0,
                    fontSize: 28,
                    letterSpacing: "-0.02em",
                  }}>
                    What do you want to do?
                  </h3>
                  <p style={{
                    margin: 0,
                    fontSize: 14,
                    color: "color-mix(in srgb, var(--color-text) 50%, transparent)",
                    maxWidth: 440,
                    lineHeight: 1.7,
                  }}>
                    Describe your goal. Meridian fetches live rates across every protocol and designs strategies at different risk levels.
                  </p>
                </div>
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                  gap: 8,
                  width: "100%",
                  maxWidth: 500,
                }}>
                  {QUICK_PROMPTS.map((qp) => (
                    <button
                      key={qp.label}
                      className="btn btn-secondary"
                      style={{
                        fontSize: 12,
                        padding: "10px 12px",
                        textAlign: "left",
                        justifyContent: "flex-start",
                        borderRadius: "var(--radius-lg)",
                      }}
                      disabled={isAnalyzing}
                      onClick={() => submitThesis(qp.thesis)}
                    >
                      {qp.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {thread.map((item, i) => (
              <ThreadCard key={i} item={item} onSelectVariant={(plan) => selectVariant(i, plan)} />
            ))}

            {isAnalyzing && (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                <div className="user-bubble">
                  <p>{pendingText}</p>
                </div>
                <div className="ai-bubble">
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {[
                      "Reading your portfolio & market context",
                      "Fetching live rates across protocols",
                      "Designing risk-tiered strategies",
                    ].map((step, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, opacity: analyzeStep >= i ? 1 : 0.3, transition: "opacity 0.4s" }}>
                        {analyzeStep > i ? (
                          <span style={{ width: 16, height: 16, fontSize: 13, color: "var(--color-accent)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>&#10003;</span>
                        ) : analyzeStep === i ? (
                          <span style={{ display: "inline-block", width: 16, height: 16, borderRadius: "50%", border: "2px solid var(--color-accent)", borderTopColor: "transparent", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                        ) : (
                          <span style={{ width: 16, height: 16, borderRadius: "50%", border: "1.5px solid var(--color-divider)", flexShrink: 0 }} />
                        )}
                        <span style={{ fontSize: 13, color: analyzeStep >= i ? "var(--color-text)" : "var(--color-neutral-400)" }}>{step}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div ref={threadEndRef} />
          </div>

          {/* Sticky input bar */}
          <div style={{
            flex: "none",
            padding: "var(--space-2) var(--space-4) var(--space-3)",
            borderTop: "1px solid var(--color-divider)",
            background: "var(--color-bg)",
          }}>
            {thread.length > 0 && !isAnalyzing && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: "var(--space-2)", alignItems: "center" }}>
                {FOLLOW_UPS.map((f) => (
                  <button
                    key={f.label}
                    className="btn btn-secondary"
                    style={{ fontSize: 11, padding: "2px 8px" }}
                    disabled={isAnalyzing}
                    onClick={() => submitThesis(f.thesis)}
                  >
                    {f.label}
                  </button>
                ))}
                <button
                  className="btn btn-secondary"
                  style={{ fontSize: 11, padding: "2px 8px", marginLeft: "auto", color: "var(--color-neutral-500)" }}
                  onClick={() => setThread([])}
                  title="Clear conversation"
                >
                  Clear
                </button>
              </div>
            )}
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
              <textarea
                ref={textareaRef}
                className="input"
                placeholder="Describe what you want: yield, exposure, hedge, airdrops..."
                value={promptText}
                disabled={isAnalyzing}
                onChange={(e) => {
                  setPromptText(e.target.value);
                  // Auto-grow
                  const ta = e.target;
                  ta.style.height = "auto";
                  ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submitThesis(promptText);
                    // Reset height
                    if (textareaRef.current) textareaRef.current.style.height = "auto";
                  }
                }}
                rows={1}
                style={{ fontSize: 14, resize: "none", lineHeight: 1.5 }}
              />
              <button
                className="btn btn-primary btn-icon"
                aria-label="Send"
                onClick={() => {
                  submitThesis(promptText);
                  if (textareaRef.current) textareaRef.current.style.height = "auto";
                }}
                disabled={isAnalyzing || !promptText.trim()}
                style={{ flexShrink: 0 }}
              >
                &#8593;
              </button>
            </div>
            <p className="text-muted" style={{ margin: "4px 0 0", fontSize: 10, textAlign: "center" }}>
              Enter to send &middot; Shift+Enter for new line
            </p>
          </div>
        </div>

        {/* News / Alpha column */}
        <div className="col-scroll" style={{ minWidth: 0, borderLeft: "1px solid var(--color-divider)", padding: "var(--space-4)" }}>
          <NewsFeed />
        </div>
      </div>
    </div>
  );
}
