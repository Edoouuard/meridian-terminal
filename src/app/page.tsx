"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { ThreadCard } from "@/components/ThreadCard";
import { RiskPanel } from "@/components/RiskPanel";
import { TickerBanner } from "@/components/TickerBanner";
import { WalletConnectButton } from "@/components/WalletConnectButton";
import { FeedbackButton } from "@/components/FeedbackButton";
import { HistoryPanel } from "@/components/HistoryPanel";
import { StrategiesPanel } from "@/components/StrategiesPanel";
import { PortfolioDayChange, PortfolioHoldings } from "@/components/PortfolioHoldings";
import { Celebration } from "@/components/Celebration";
import { ProductTour, startTour, TOUR_OPEN_TAB_EVENT } from "@/components/ProductTour";
import { OPEN_STRATEGIES_EVENT, useTrackedStrategies } from "@/lib/strategyTracker";
import { HyperliquidPanel } from "@/components/HyperliquidPanel";
import { ExtendedConnectPanel } from "@/components/ExtendedConnectPanel";
import { TxflowPanel } from "@/components/TxflowPanel";
import { PerpVenuesSummary, VENUE_ANCHOR } from "@/components/PerpVenuesSummary";
import { NeutralBotPanel } from "@/components/NeutralBotPanel";
import { OPEN_BOT_EVENT, OPEN_TOOLS_EVENT, SHOW_BOT_EVENT } from "@/lib/neutralBot/bus";
import { NeutralBotHost } from "@/components/NeutralBotHost";
import { executableCoverage } from "@/lib/coverage";

import { ArbView, ARB_MIN_NET_PCT, useArbScan } from "@/components/ArbView";
import { NeutralBotView } from "@/components/NeutralBotView";
import { BotStatusChip } from "@/components/BotStatusChip";
import { LifiPerpsConnectPanel } from "@/components/LifiPerpsConnectPanel";
import { LidoWithdrawalsPanel } from "@/components/LidoWithdrawalsPanel";
import { PerpPositionsPanel } from "@/components/PerpPositionsPanel";
import { SolanaPanel } from "@/components/SolanaPanel";
import { McpStatusPanel } from "@/components/McpStatusPanel";
import { BridgePanel } from "@/components/BridgePanel";
import { LiveAsset, useLivePortfolio } from "@/hooks/useLivePortfolio";
import { useHaikuPortfolio } from "@/hooks/useHaikuPortfolio";
import { NewsFeed } from "@/components/NewsFeed";
import { ACTIVE_CHAIN_IDS, CHAIN_LABEL, SUPPORTED_CHAINS } from "@/lib/onchain";
import { FEATURES } from "@/lib/features";
import { deployableUsd } from "@/lib/budgetFit";
import { routeThesis, type TradePlan } from "@/lib/routeThesis";
import { routeThesisAsync, threadHistory, type PortfolioContext } from "@/lib/intentEngine";
import { useExtendedAccount } from "@/hooks/useExtendedAccount";
import { fetchExtendedBalance } from "@/lib/integrations/extended-live";
import { fetchTxflowAccount } from "@/lib/integrations/txflow-live";
import type { Signer as ExtendedSigner } from "@blackcube/extended-sdk";
import { fundPlan } from "@/lib/fundingPlanner";
import { browserFundingDeps } from "@/lib/fundingDeps";
import { useLivePrices } from "@/hooks/useLivePrices";
import { recordExecution } from "@/lib/history";
import { onAsk, onShowPlan } from "@/lib/askBus";

// Expose the local order-history API on the page module so real execution
// sites (lib/orderRunner, useHyperliquid) can log orders going
// forward: `recordExecution({ type, label, amount, asset, protocol, chainId, status, hash })`.
export { recordExecution };

/** Protocols useLivePortfolio already reads on-chain (lending pools, Morpho indexer, vaults, EigenLayer, Lido). */
const LIVE_TRACKED_PROTOCOLS = /aave|spark|compound|morpho|fluid|yearn|sky|ethena|curve|eigen|lido/i;

const CHAIN_NAMES = SUPPORTED_CHAINS.map((c) => CHAIN_LABEL[c.id]).join(", ");
import { ThreadItem, fmtUsd } from "@/lib/data";

/** Protocols Meridian signs into, across its chains (lib/coverage.ts). */
const EXECUTABLE_PROTOCOLS = executableCoverage().protocols.length;


function formatAssetAmount(asset: LiveAsset): string {
  if (asset.usd > 0) return fmtUsd(asset.usd);
  return `${asset.balance.toFixed(4)} ${asset.symbol}`;
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
          hint: "Best live rate across 8 chains, bridging only when it pays",
          thesis: `Find the best yield on my $${fmtAmount(stableUsd)} of stablecoins (mostly ${mainStable}) across all chains. Bridge or swap only if it pays off.`,
        }
      : {
          label: "Best yield on my stablecoins",
          hint: "Aave, Morpho, Pendle — across 8 chains, bridging only when it pays",
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

/** The Extended account as the planner sees it: connected or not, and its USDC (a slow read never holds the plan up). */
async function extendedSnapshot(signer: ExtendedSigner | null): Promise<PortfolioContext["extended"]> {
  if (!signer) return { connected: false };
  try {
    const b = await Promise.race([fetchExtendedBalance(signer), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000))]);
    return { connected: true, network: signer.network, equityUsd: b?.equity ?? 0, availableUsd: b?.availableForTrade ?? 0 };
  } catch {
    return { connected: true, network: signer.network };
  }
}

/** The wallet's TxFlow account as the planner sees it (null = not read; a slow read never holds the plan up). */
async function txflowSnapshot(address: `0x${string}` | undefined): Promise<PortfolioContext["txflow"]> {
  if (!address) return null;
  try {
    const a = await Promise.race([fetchTxflowAccount(address), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000))]);
    return { equityUsd: a.accountValue, availableUsd: a.withdrawable };
  } catch {
    return null;
  }
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
  // (Risk, Perp positions, 4 venue connect panels, History, Chains, Solana) --
  // grouped into tabs so the left column stays scannable instead of dense.
  const [leftTab, setLeftTab] = useState<"risk" | "strategies" | "venues" | "activity">("risk");
  const sideTabsRef = useRef<HTMLDivElement>(null);
  // "Monitor it" from the celebration opens the Strategies tab.
  useEffect(() => {
    const open = () => {
      setLeftTab("strategies");
      sideTabsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    window.addEventListener(OPEN_STRATEGIES_EVENT, open);
    return () => window.removeEventListener(OPEN_STRATEGIES_EVENT, open);
  }, []);
  // The neutral bot has its own view in the centre column; "Run it as a bot" from a plan opens it.
  const [centerView, setCenterView] = useState<"terminal" | "bot" | "arb">("terminal");
  const arbScan = useArbScan(1000, FEATURES.perps);
  const arbCount = (arbScan.data?.opportunities ?? []).filter((o) => o.netPct >= ARB_MIN_NET_PCT).length;
  useEffect(() => {
    const open = () => setCenterView("bot");
    window.addEventListener(OPEN_BOT_EVENT, open);
    window.addEventListener(SHOW_BOT_EVENT, open);
    return () => {
      window.removeEventListener(OPEN_BOT_EVENT, open);
      window.removeEventListener(SHOW_BOT_EVENT, open);
    };
  }, []);
  // "Deposit on Extended" from the bot: Tools, at that venue's panel.
  useEffect(() => {
    const open = (e: Event) => {
      const anchor = (e as CustomEvent<unknown>).detail;
      setLeftTab("venues");
      if (typeof anchor === "string") setTimeout(() => document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    };
    window.addEventListener(OPEN_TOOLS_EVENT, open);
    return () => window.removeEventListener(OPEN_TOOLS_EVENT, open);
  }, []);
  // A tour step pointing inside a side tab opens it first.
  useEffect(() => {
    const open = (e: Event) => {
      const tab = (e as CustomEvent<unknown>).detail;
      if (tab === "risk" || tab === "strategies" || tab === "venues" || tab === "activity") setLeftTab(tab);
    };
    window.addEventListener(TOUR_OPEN_TAB_EVENT, open);
    return () => window.removeEventListener(TOUR_OPEN_TAB_EVENT, open);
  }, []);

  const { isConnected, address, chain } = useAccount();
  const extendedSigner = useExtendedAccount();
  const trackedStrategies = useTrackedStrategies(address);
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

  // Auto-scroll to bottom when thread changes or analysis starts
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread, isAnalyzing, pendingText]);

  // Submit a thesis to the LLM engine (used by both input and quick prompts)
  async function submitThesis(text: string) {
    setCenterView("terminal");
    const typed = text.trim();
    if (!typed || isAnalyzing) return;
    // A reply to the planner's question carries the original request with it.
    const last = thread[thread.length - 1];
    const answering = last?.clarify && last.text ? last : undefined;
    const trimmed = answering ? `${answering.text} — ${typed}` : typed;
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
    // Free balance = what can fund a new strategy: wallet tokens and free Hyperliquid spot
    // (not staked HYPE, HLP or vault equity, nor the perps account's margin).
    const freeBalanceUsd = deployableUsd(live.assets);
    const portfolioSnapshot: PortfolioContext | undefined = live.isConnected
      ? {
          netUsd: live.netUsd,
          freeBalanceUsd,
          assets: live.assets,
          lendingPositions: live.aavePositions,
          perps: live.perps,
          netDeltaEthTotal: live.netDeltaEthTotal,
          hyperliquid: live.hyperliquidAccount,
          extended: await extendedSnapshot(extendedSigner),
          txflow: await txflowSnapshot(address),
        }
      : undefined;

    try {
      const routed = await fundThreadItem(await routeThesisAsync(trimmed, portfolioSnapshot, {
            clarified: !!answering,
            answeredQuestion: answering?.clarify?.question,
            // The question being answered is already in the request: the turns before it give the context.
            history: threadHistory(answering ? thread.slice(0, -1) : thread),
          }));
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
  // A plan built outside the chat (a strategy's exit) joins the thread as is: it spends positions, not wallet funds,
  // so the wallet-funding pass (bridges, resizing to balances) doesn't apply.
  useEffect(() => onShowPlan((item) => setThread((cur) => cur.concat([{ type: "custom", text: item.text, plan: item.plan, understanding: item.understanding }]))), []);

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
      {FEATURES.perps && <NeutralBotHost />}
      <Celebration />
      <ProductTour />
      <div className="nav topbar" style={{ background: "var(--color-surface)", flex: "none" }}>
        <Link href="/" className="nav-brand" style={{ color: "var(--color-text)" }}>
          Meridian
        </Link>
        <span data-tour="status" className={`status-pill${isConnected ? " status-pill--on" : ""}`} title={`Meridian executes on ${ACTIVE_CHAIN_IDS.map((id) => CHAIN_LABEL[id]).join(", ")}`}>
          <span className="status-pill__dot" aria-hidden="true" />
          {isConnected ? `Connected · ${chain?.name ?? "wallet"}` : "Not connected"}
          <span className="status-pill__sep" aria-hidden="true">·</span>
          {ACTIVE_CHAIN_IDS.length} chains · {EXECUTABLE_PROTOCOLS} protocols
        </span>
        <span className="topbar__spacer" />
        {FEATURES.perps && <BotStatusChip onOpen={() => setCenterView("bot")} />}
        {portfolioValue !== null && (
          <span className="topbar__value" title="Wallet balances plus tracked positions">
            <span className="topbar__value-label">Portfolio</span>
            {fmtUsd(portfolioValue)}
          </span>
        )}
        <button type="button" className="tour-trigger" onClick={startTour} title="Take the product tour">
          Tour
        </button>
        <FeedbackButton lastRequest={thread[thread.length - 1]?.text} />
        <WalletConnectButton />
      </div>

      <div className="app-grid" style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "290px 1fr 320px", overflow: "hidden" }}>
        {/* Portfolio column */}
        <div className="col-scroll app-col-portfolio side-col" style={{ minWidth: 0, borderRight: "1px solid var(--color-divider)" }}>
          <section className="panel-card" data-tour="portfolio">
            <div className="panel-card__head">
              <h6 className="panel-card__title">Portfolio</h6>
              <span className={`live-chip${isConnected ? " live-chip--on" : ""}`}>{isConnected ? (live.isLoading ? "Reading…" : "Live") : "No wallet"}</span>
            </div>
            {portfolioValue !== null && <p className="portfolio-value">{fmtUsd(portfolioValue)}</p>}
            {isConnected && <PortfolioDayChange live={live} />}
            {!isConnected && (
              <div className="empty-hint">
                <p>Connect a wallet to see your balances and positions across {ACTIVE_CHAIN_IDS.length} chains, and to execute strategies.</p>
                <WalletConnectButton />
              </div>
            )}

          </section>

          {isConnected && (
            <section className="panel-card">
              <div className="panel-card__head">
                <h6 className="panel-card__title">Holdings</h6>
                <span className="text-muted" style={{ fontSize: 11 }}>{livePositions.length || ""}</span>
              </div>
              {livePositions.length > 0 ? (
                <>
                  <PortfolioHoldings live={live} />
                  {haikuExtraPositions.length > 0 && (
                    <ul className="position-list" style={{ marginTop: 8 }}>
                      {haikuExtraPositions.map((p, i) => (
                        <li key={i} className="position-row">
                          <span className="position-row__main">
                            <span className="position-row__asset">{`${p.protocol} ${p.type}`}</span>
                            <span className="position-row__venue">{`${p.asset} · chain ${p.chainId}`}</span>
                          </span>
                          <span className="position-row__amount">{fmtUsd(p.depositedUsd)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
                  {live.isLoading
                    ? "Reading your wallet balances and Aave position…"
                    : `Nothing found yet across ${CHAIN_NAMES}. Fund this wallet, or ask for a strategy and Meridian will tell you what's needed.`}
                </p>
              )}
            </section>
          )}

          <div className="seg side-tabs" role="tablist" aria-label="Portfolio tools" ref={sideTabsRef} data-tour="tabs">
            <label className="seg-opt">
              <input type="radio" name="left-tab" checked={leftTab === "risk"} onChange={() => setLeftTab("risk")} />
              <span>Risk</span>
            </label>
            <label className="seg-opt">
              <input type="radio" name="left-tab" checked={leftTab === "strategies"} onChange={() => setLeftTab("strategies")} />
              <span>
                Strategies
                {trackedStrategies.length > 0 && <span className="tab-count">{trackedStrategies.length}</span>}
              </span>
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
              <PerpPositionsPanel />
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
                  <PerpVenuesSummary />
                  <NeutralBotPanel />
                  <div id={VENUE_ANCHOR.hyperliquid}>
                    <HyperliquidPanel />
                  </div>
                  <div data-tour="extended" id={VENUE_ANCHOR.extended}>
                    <ExtendedConnectPanel />
                  </div>
                  <div id={VENUE_ANCHOR.txflow}>
                    <TxflowPanel />
                  </div>
                  <div id={VENUE_ANCHOR.ondo}>
                    <LifiPerpsConnectPanel provider="ondo" />
                  </div>
                  <div id={VENUE_ANCHOR.lighter}>
                    <LifiPerpsConnectPanel provider="lighter" />
                  </div>
                </>
              )}
              {FEATURES.solana && <SolanaPanel />}
              <details className="system-status">
                <summary>System status</summary>
                <McpStatusPanel />
              </details>
            </>
          )}
          {leftTab === "strategies" && <StrategiesPanel />}
          {leftTab === "activity" && <HistoryPanel />}
        </div>

        {/* Trade column — chat-first layout */}
        <div className="app-col-trade" style={{ display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>
          {FEATURES.perps && (
            <div className="center-switch" role="tablist" aria-label="Main view">
              <button type="button" role="tab" aria-selected={centerView === "terminal"} className={`center-switch__tab${centerView === "terminal" ? " is-on" : ""}`} onClick={() => setCenterView("terminal")}>
                Terminal
              </button>
              <button type="button" role="tab" aria-selected={centerView === "bot"} className={`center-switch__tab${centerView === "bot" ? " is-on" : ""}`} onClick={() => setCenterView("bot")}>
                Neutral bot <span className="center-switch__badge">farm points</span>
              </button>
              <button type="button" role="tab" aria-selected={centerView === "arb"} className={`center-switch__tab${centerView === "arb" ? " is-on" : ""}`} onClick={() => setCenterView("arb")}>
                Arbitrage {arbCount > 0 && <span className="center-switch__badge center-switch__badge--hot">{arbCount} live</span>}
              </button>
            </div>
          )}
          {centerView === "bot" && (
            <div className="col-scroll" style={{ flex: 1, minHeight: 0, minWidth: 0, padding: "var(--space-4)" }}>
              <NeutralBotView />
            </div>
          )}
          {centerView === "arb" && (
            <div className="col-scroll" style={{ flex: 1, minHeight: 0, minWidth: 0, padding: "var(--space-4)" }}>
              <ArbView />
            </div>
          )}
          {/* Scrollable thread area */}
          <div
            ref={scrollContainerRef}
            className="col-scroll"
            style={{
              display: centerView !== "terminal" ? "none" : "flex",
              flex: 1,
              minHeight: 0,
              minWidth: 0,
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
                {FEATURES.perps && (
                  <button type="button" className="bot-promo" onClick={() => setCenterView("bot")}>
                    <span className="bot-promo__tag">Neutral bot</span>
                    <span className="bot-promo__title">Farm points and airdrops on autopilot</span>
                    <span className="bot-promo__text">Delta-neutral volume and open interest across Hyperliquid, Extended and TxFlow, at random times and sizes, monitored live.</span>
                    <span className="bot-promo__go" aria-hidden="true">Open →</span>
                  </button>
                )}
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
              <ThreadCard
                key={i}
                item={item}
                onSelectVariant={(plan) => selectVariant(i, plan)}
                onAnswer={i === thread.length - 1 && !isAnalyzing ? (answer) => void submitThesis(answer) : undefined}
              />
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
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }} data-tour="composer">
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
        <div className="col-scroll app-col-news side-col" style={{ minWidth: 0, borderLeft: "1px solid var(--color-divider)" }} data-tour="markets">
          <NewsFeed />
        </div>
      </div>
    </div>
  );
}
