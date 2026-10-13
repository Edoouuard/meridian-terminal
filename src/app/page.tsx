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
import { BridgePanel } from "@/components/BridgePanel";
import { LiveAsset, LivePortfolio, useLivePortfolio } from "@/hooks/useLivePortfolio";
import { useHaikuPortfolio } from "@/hooks/useHaikuPortfolio";
import { NewsFeed } from "@/components/NewsFeed";
import { ACTIVE_CHAIN_IDS, CHAIN_LABEL, SUPPORTED_CHAINS } from "@/lib/onchain";
import { FEATURES } from "@/lib/features";
import { routeThesis, type TradePlan } from "@/lib/routeThesis";
import { routeThesisAsync, type PortfolioContext } from "@/lib/intentEngine";
import { fundPlan } from "@/lib/fundingPlanner";
import { browserFundingDeps } from "@/lib/fundingDeps";
import { useLivePrices } from "@/hooks/useLivePrices";
import { recordExecution } from "@/lib/history";
import { onAsk } from "@/lib/askBus";

// Expose the local order-history API on the page module so real execution
// sites (lib/orderRunner, useHyperliquid) can log orders going
// forward: `recordExecution({ type, label, amount, asset, protocol, chainId, status, hash })`.
export { recordExecution };

/** Protocols useLivePortfolio already reads on-chain (lending pools + Morpho indexer). */
const LIVE_TRACKED_PROTOCOLS = /aave|spark|compound|morpho/i;

const CHAIN_NAMES = SUPPORTED_CHAINS.map((c) => CHAIN_LABEL[c.id]).join(", ");
import { ThreadItem, fmtUsd } from "@/lib/data";

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

interface QuickPrompt {
  label: string;
  hint: string;
  thesis: string;
}

const STABLES = new Set(["USDC", "USDT", "DAI", "USDS", "USDE", "GHO", "PYUSD", "USDC.E"]);

function fmtAmount(n: number): string {
  return n >= 100 ? Math.round(n).toLocaleString("en-US") : n >= 1 ? n.toFixed(2) : n.toPrecision(2);
}

/**
 * The three suggested starts. Generic without a wallet; with one, the stable
 * and ETH prompts quote what the wallet holds ("Put my 1,250 USDC to work").
 */
function buildQuickPrompts(assets: { symbol: string; balance: number; usd: number }[]): QuickPrompt[] {
  const stables = assets.filter((a) => STABLES.has(a.symbol.toUpperCase()));
  const stableUsd = stables.reduce((sum, a) => sum + a.usd, 0);
  const mainStable = [...stables].sort((a, b) => b.usd - a.usd)[0]?.symbol ?? "USDC";
  const eth = assets.filter((a) => /^(ETH|WETH)$/i.test(a.symbol)).reduce((sum, a) => sum + a.balance, 0);
  return [
    stableUsd >= 10
      ? {
          label: `Put my $${fmtAmount(stableUsd)} of stablecoins to work`,
          hint: "Best live rate across 7 chains, bridging only when it pays",
          thesis: `Find the best yield on my $${fmtAmount(stableUsd)} of stablecoins (mostly ${mainStable}) across all chains. Bridge or swap only if it pays off.`,
        }
      : {
          label: "Best yield on my stablecoins",
          hint: "Aave, Morpho, Pendle — across 7 chains, bridging only when it pays",
          thesis: "Find the best yield on my stablecoins across all chains. Bridge or swap only if it pays off.",
        },
    eth >= 0.005
      ? {
          label: `Stake my ${fmtAmount(eth)} ETH`,
          hint: "Lido staking, optional EigenLayer restaking",
          thesis: `I want to stake my ${fmtAmount(eth)} ETH for yield: Lido, and restaking on EigenLayer if it makes sense.`,
        }
      : {
          label: "Stake my ETH",
          hint: "Lido staking, optional EigenLayer restaking",
          thesis: "I want to stake my ETH for yield: Lido, and restaking on EigenLayer if it makes sense.",
        },
    {
      label: "Lock a fixed rate",
      hint: "Pendle PT on major stablecoins, held to maturity",
      thesis: `Lock a fixed rate on my ${stableUsd >= 10 ? mainStable : "USDC"} with Pendle, on a major stablecoin market.`,
    },
  ];
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

  const { isConnected, address, chain } = useAccount();
  const live = useLivePortfolio();
  const { data: livePrices } = useLivePrices();
  const haikuData = useHaikuPortfolio();

  // Haiku reads the same wallet balances (LI.FI) and Aave positions (Aave MCP)
  // that useLivePortfolio reads on-chain, so only its positions in protocols
  // the live reader doesn't track are added — never its balances.
  const haikuExtraPositions = haikuData.positions.filter(
    (p) => p.depositedUsd > 1 && !LIVE_TRACKED_PROTOCOLS.test(p.protocol),
  );
  const haikuExtraUsd = haikuExtraPositions.reduce((sum, p) => sum + p.depositedUsd, 0);
  const portfolioValue = isConnected ? live.netUsd + haikuExtraUsd : null;

  // Build live positions from on-chain data + Haiku MCP enrichment
  const livePositions = [
    ...live.assets.map((a) => ({ asset: a.symbol, venue: `${a.venue} · ${a.chain}`, amount: formatAssetAmount(a) })),
    ...live.aavePositions.flatMap((p) => [
      ...(p.collateralUsd > 0 ? [{ asset: `${p.protocol} supply`, venue: p.chain, amount: fmtUsd(p.collateralUsd) }] : []),
      ...(p.debtUsd > 0 ? [{ asset: `${p.protocol} borrow`, venue: p.chain, amount: "-" + fmtUsd(p.debtUsd) }] : []),
    ]),
    // Haiku MCP: DeFi positions from protocols not tracked by wagmi multicall
    ...haikuExtraPositions.map((p) => ({
        asset: `${p.protocol} ${p.type}`,
        venue: `${p.asset} · chain ${p.chainId}`,
        amount: fmtUsd(p.depositedUsd),
      })),
  ];
  const displayPositions = isConnected ? livePositions : [];
  const displayAllocation = isConnected ? buildLiveAllocation(live) : [];

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
      const routed = await fundThreadItem(await routeThesisAsync(trimmed, portfolioSnapshot));
      setThread((cur) => cur.concat([routed]));
    } catch {
      setThread((cur) => cur.concat([{ ...routeThesis(trimmed), notice: "Something went wrong building your plan. Below is a basic plan from local rules, without live rates; ask again in a moment." }]));
    } finally {
      stepTimers.forEach(clearTimeout);
      setIsAnalyzing(false);
      setPendingText("");
      setAnalyzeStep(0);
    }
  }

  // Fit every strategy to the wallet's real balances: add the bridges a leg
  // needs, keep a leg on the funds' chain when bridging doesn't pay, resize
  // what can't be fully funded (lib/fundingPlanner.ts).
  async function fundThreadItem(item: ThreadItem): Promise<ThreadItem> {
    if (!item.plan || !isConnected || !address) return item;
    const deps = browserFundingDeps({ address, assets: live.assets, prices: livePrices, connectedChainId: chain?.id });
    try {
      const variants = item.variants ? await Promise.all(item.variants.map((v) => fundPlan(v, deps))) : undefined;
      const index = item.variants?.indexOf(item.plan) ?? -1;
      const plan = variants && index >= 0 ? variants[index] : await fundPlan(item.plan, deps);
      return { ...item, plan, variants };
    } catch {
      return item;
    }
  }

  function selectVariant(index: number, plan: TradePlan) {
    setThread((cur) => cur.map((item, i) => (i === index ? { ...item, plan } : item)));
  }

  // Three starting points, each one an end-to-end path Meridian has proven on
  // forks (lend, stake/restake, fixed rate) — the first thing a new user tries
  // should be something that works. With a wallet connected, they name what
  // the wallet actually holds.
  const QUICK_PROMPTS = buildQuickPrompts(isConnected ? live.assets : []);

  // Panels ("Ask Meridian" on a risk, a chain, an alpha item) send prompts here.
  const submitRef = useRef(submitThesis);
  useEffect(() => {
    submitRef.current = submitThesis;
  });
  useEffect(() => onAsk((prompt) => void submitRef.current(prompt)), []);

  // "/" focuses the composer from anywhere outside a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      textareaRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const FOLLOW_UPS = [
    { label: "Lower risk", thesis: "Same idea but more conservative, less leverage" },
    { label: "More yield", thesis: "I want to push for higher yield, I can take more risk" },
    { label: "Stay on one chain", thesis: "Same goal, but keep everything on the chain where my funds already are — no bridge" },
    { label: "Explain the risks", thesis: "Explain the risks of these strategies in plain words, and what could make me lose money" },
    { label: "Delta neutral", thesis: "Make it delta neutral, I don't want directional exposure", perps: true },
  ].filter((p) => FEATURES.perps || !("perps" in p));

  return (
    <div className="app-shell" style={{ background: "var(--color-bg)", color: "var(--color-text)", height: "100vh", display: "flex", flexDirection: "column" }}>
      <TickerBanner />
      <div className="nav topbar" style={{ background: "var(--color-surface)", flex: "none" }}>
        <Link href="/" className="nav-brand" style={{ color: "var(--color-text)" }}>
          Meridian
        </Link>
        <span className={`status-pill${isConnected ? " status-pill--on" : ""}`} title={`Meridian executes on ${ACTIVE_CHAIN_IDS.map((id) => CHAIN_LABEL[id]).join(", ")}`}>
          <span className="status-pill__dot" aria-hidden="true" />
          {isConnected ? `Connected · ${chain?.name ?? "wallet"}` : "Not connected"}
          <span className="status-pill__sep" aria-hidden="true">·</span>
          {ACTIVE_CHAIN_IDS.length} chains
        </span>
        <span className="topbar__spacer" />
        {portfolioValue !== null && (
          <span className="topbar__value" title="Wallet balances plus tracked positions">
            <span className="topbar__value-label">Portfolio</span>
            {fmtUsd(portfolioValue)}
          </span>
        )}
        <WalletConnectButton />
      </div>

      <div className="app-grid" style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "290px 1fr 320px", overflow: "hidden" }}>
        {/* Portfolio column */}
        <div className="col-scroll app-col-portfolio side-col" style={{ minWidth: 0, borderRight: "1px solid var(--color-divider)" }}>
          <section className="panel-card">
            <div className="panel-card__head">
              <h6 className="panel-card__title">Portfolio</h6>
              <span className={`live-chip${isConnected ? " live-chip--on" : ""}`}>{isConnected ? (live.isLoading ? "Reading…" : "Live") : "No wallet"}</span>
            </div>
            {portfolioValue !== null && <p className="portfolio-value">{fmtUsd(portfolioValue)}</p>}
            {!isConnected && (
              <div className="empty-hint">
                <p>Connect a wallet to see your balances and positions across {SUPPORTED_CHAINS.length} chains, and to execute strategies.</p>
                <WalletConnectButton />
              </div>
            )}

            {displayAllocation.length > 0 && (
              <>
                <div className="alloc-bar" aria-hidden="true">
                  {displayAllocation.map((a) => (
                    <div key={a.label} style={{ width: `${a.pct}%`, background: a.color }} />
                  ))}
                </div>
                <ul className="alloc-legend">
                  {displayAllocation.map((a) => (
                    <li key={a.label}>
                      <span className="alloc-legend__swatch" style={{ background: a.color }} />
                      <span>{a.label}</span>
                      <span className="text-muted">{a.pct}%</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          {isConnected && (
            <section className="panel-card">
              <div className="panel-card__head">
                <h6 className="panel-card__title">Positions</h6>
                <span className="text-muted" style={{ fontSize: 11 }}>{livePositions.length || ""}</span>
              </div>
              {livePositions.length > 0 ? (
                <ul className="position-list">
                  {displayPositions.map((pos, i) => (
                    <li key={i} className="position-row">
                      <span className="position-row__main">
                        <span className="position-row__asset">{pos.asset}</span>
                        <span className="position-row__venue">{pos.venue}</span>
                      </span>
                      <span className="position-row__amount">{pos.amount}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
                  {live.isLoading
                    ? "Reading your wallet balances and Aave position…"
                    : `Nothing found yet across ${CHAIN_NAMES}. Fund this wallet, or ask for a strategy and Meridian will tell you what's needed.`}
                </p>
              )}
            </section>
          )}

          <div className="seg side-tabs" role="tablist" aria-label="Portfolio tools">
            <label className="seg-opt">
              <input type="radio" name="left-tab" checked={leftTab === "risk"} onChange={() => setLeftTab("risk")} />
              <span>Risk</span>
            </label>
            <label className="seg-opt">
              <input type="radio" name="left-tab" checked={leftTab === "venues"} onChange={() => setLeftTab("venues")} />
              <span>Tools</span>
            </label>
            <label className="seg-opt">
              <input type="radio" name="left-tab" checked={leftTab === "activity"} onChange={() => setLeftTab("activity")} />
              <span>History</span>
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
              {!isConnected && (
                <section className="panel-card">
                  <h6 className="panel-card__title">Tools</h6>
                  <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
                    Bridge funds between chains and claim Lido withdrawals here once a wallet is connected. Strategies add the bridges they need on their own.
                  </p>
                </section>
              )}
              <BridgePanel />
              <LidoWithdrawalsPanel />
              {FEATURES.perps && (
                <>
                  <HyperliquidPanel />
                  <ExtendedConnectPanel />
                  <LifiPerpsConnectPanel provider="ondo" />
                  <LifiPerpsConnectPanel provider="lighter" />
                </>
              )}
              {FEATURES.solana && <SolanaPanel />}
              <details className="system-status">
                <summary>System status</summary>
                <McpStatusPanel />
              </details>
            </>
          )}
          {leftTab === "activity" && <HistoryPanel />}
        </div>

        {/* Trade column — chat-first layout */}
        <div className="app-col-trade" style={{ display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>
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
                  {!isConnected && (
                    <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
                      Connect a wallet to fit strategies to your real balances and execute them. You can explore without one.
                    </p>
                  )}
                </div>
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
                  gap: 8,
                  width: "100%",
                  maxWidth: 600,
                }}>
                  {QUICK_PROMPTS.map((qp) => (
                    <button
                      key={qp.label}
                      className="btn btn-secondary quick-prompt"
                      disabled={isAnalyzing}
                      onClick={() => submitThesis(qp.thesis)}
                    >
                      <span className="quick-prompt__label">{qp.label}</span>
                      <span className="quick-prompt__hint">{qp.hint}</span>
                      <span className="quick-prompt__go" aria-hidden="true">→</span>
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
              <div className="followups">
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
                  title="Start a new conversation"
                >
                  New chat
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
            <p className="text-muted composer-hint" style={{ margin: "4px 0 0", fontSize: 10, textAlign: "center" }}>
              Enter to send &middot; Shift+Enter for a new line &middot; <kbd>/</kbd> to focus
            </p>
          </div>
        </div>

        {/* News / Alpha column */}
        <div className="col-scroll app-col-news side-col" style={{ minWidth: 0, borderLeft: "1px solid var(--color-divider)" }}>
          <NewsFeed />
        </div>
      </div>
    </div>
  );
}
