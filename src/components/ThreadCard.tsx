"use client";

import { useState } from "react";
import { ThreadItem, fmtUsd } from "@/lib/data";
import type { TradePlan } from "@/lib/tradePlan";
import { defaultStrategyIndex, fmtPct, strategyView, type RiskTier, type StrategyView } from "@/lib/strategyView";
import { ExecuteStrategyButton, StrategyLegs } from "@/components/thread/StrategyLegs";
import { YieldFinderCard } from "@/components/thread/YieldFinderCard";

const RISK_COLORS: Record<RiskTier, string> = {
  conservative: "var(--risk-good)",
  moderate: "var(--risk-warning)",
  aggressive: "var(--risk-serious)",
};

const RISK_LEVEL: Record<RiskTier, number> = { conservative: 1, moderate: 2, aggressive: 3 };

const RISK_WORD: Record<RiskTier, string> = { conservative: "Low risk", moderate: "Medium risk", aggressive: "High risk" };

/** Risk tier as a word plus a three-step meter, so it reads without relying on colour alone. */
function RiskTag({ tier }: { tier?: RiskTier }) {
  if (!tier) return null;
  const color = RISK_COLORS[tier];
  return (
    <span className="risk-tag" style={{ color }}>
      <span className="risk-tag__meter" aria-hidden="true">
        {[1, 2, 3].map((n) => (
          <span key={n} style={{ background: n <= RISK_LEVEL[tier] ? color : "var(--color-divider)" }} />
        ))}
      </span>
      {RISK_WORD[tier]}
    </span>
  );
}

function ApyFigure({ view, size = "md" }: { view: StrategyView; size?: "md" | "lg" }) {
  return (
    <div className={`apy apy--${size}`}>
      <span className="apy__value">{view.apyPct !== undefined ? fmtPct(view.apyPct) : "—"}</span>
      <span className="apy__kind">{view.apyPct !== undefined ? `APY · ${view.apyKind}` : "rate shown per step"}</span>
    </div>
  );
}

function earnLine(view: StrategyView): string | null {
  if (view.yearlyUsd === undefined || view.sizeUsd === undefined) return view.sizeUsd ? `on ${fmtUsd(view.sizeUsd)}` : null;
  return `≈ ${fmtUsd(view.yearlyUsd)} / year on ${fmtUsd(view.sizeUsd)}`;
}

function chainsLine(view: StrategyView): string {
  return view.chains.length > 0 ? view.chains.join(" → ") : "Your current chain";
}

/** One strategy in the side-by-side comparison: the numbers a user decides on. */
function CompareCard({ plan, isActive, isRecommended, onSelect }: {
  plan: TradePlan;
  isActive: boolean;
  isRecommended: boolean;
  onSelect: () => void;
}) {
  const view = strategyView(plan);
  const earn = earnLine(view);
  return (
    <button
      type="button"
      className={`scard${isActive ? " scard--active" : ""}`}
      aria-pressed={isActive}
      onClick={onSelect}
    >
      <span className="scard__top">
        <RiskTag tier={view.tier} />
        {isRecommended && <span className="scard__badge">Recommended</span>}
      </span>
      <span className="scard__name">{plan.variantLabel || "Strategy"}</span>
      <ApyFigure view={view} />
      {earn && <span className="scard__earn">{earn}</span>}
      <span className="scard__facts">
        <span><span className="scard__fact-label">Where</span><span>{chainsLine(view)}</span></span>
        {view.exit && <span><span className="scard__fact-label">Exit</span><span>{view.exit}</span></span>}
        <span>
          <span className="scard__fact-label">Steps</span>
          <span>{view.steps} {view.steps === 1 ? "signature step" : "steps"}{view.needsBridge ? " · bridge included" : ""}</span>
        </span>
      </span>
      {view.protocols.length > 0 && (
        <span className="scard__protocols">
          {view.protocols.map((p) => <span key={p} className="protocol-pill">{p}</span>)}
        </span>
      )}
    </button>
  );
}

/** Everything about the chosen strategy: why, risks, then the steps to sign. */
function StrategyDetail({ plan, isRecommended, single }: { plan: TradePlan; isRecommended: boolean; single: boolean }) {
  const view = strategyView(plan);
  const earn = earnLine(view);
  const risks = view.risks.length > 0 ? view.risks : plan.variantNote ? [plan.variantNote] : [];
  return (
    <section className="sdetail" aria-label={`${plan.variantLabel || "Strategy"} details`}>
      <header className="sdetail__head">
        <div className="sdetail__title">
          <span className="sdetail__kicker">
            {single ? "Strategy" : isRecommended ? "Recommended for you" : "Selected strategy"}
          </span>
          <h4 className="sdetail__name">{plan.variantLabel || intentLabel(plan.intent)}</h4>
          <span className="sdetail__sub">
            <RiskTag tier={view.tier} />
            <span className="text-muted">{chainsLine(view)}</span>
          </span>
        </div>
        <div className="sdetail__apy">
          <ApyFigure view={view} size="lg" />
          {earn && <span className="scard__earn">{earn}</span>}
        </div>
      </header>

      <p className="sdetail__summary">{plan.summary}</p>

      {(view.fit || risks.length > 0 || view.exit) && (
        <div className="sdetail__grid">
          {view.fit && (
            <div className="sdetail__block">
              <h6>Good fit if</h6>
              <p>{view.fit}</p>
            </div>
          )}
          {view.exit && (
            <div className="sdetail__block">
              <h6>Getting out</h6>
              <p>{view.exit}</p>
            </div>
          )}
          {risks.length > 0 && (
            <div className="sdetail__block sdetail__block--risks">
              <h6>Risks</h6>
              <ul>
                {risks.map((r, k) => <li key={k}>{r}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {plan.intent === "yieldSearch" && (
        <YieldFinderCard asset={plan.asset ?? "USDC"} sizeUsd={plan.sizeUsd ?? 10000} />
      )}

      <div className="sdetail__steps">
        <h6>{plan.legs.length > 1 ? `How it runs · ${plan.legs.length} steps` : "How it runs"}</h6>
        <StrategyLegs plan={plan} />
        {plan.legs.length > 1 && <ExecuteStrategyButton plan={plan} />}
      </div>
    </section>
  );
}

/** Intent label for the AI understanding line. */
function intentLabel(intent: string): string {
  const map: Record<string, string> = {
    lockYield: "Lock in a fixed yield",
    betaNeutral: "Delta-neutral points farming",
    directional: "Directional position",
    swap: "Token swap",
    hedge: "Portfolio hedge",
    supply: "Earn yield via lending",
    borrow: "Borrow against collateral",
    repay: "Repay debt",
    stake: "Liquid staking",
    restake: "Restaking for extra yield",
    options: "Options position",
    bridge: "Cross-chain bridge",
    transfer: "Direct transfer",
    withdraw: "Withdraw position",
    yieldSearch: "Find the best yield",
  };
  return map[intent] || "Custom strategy";
}

export function ThreadCard({ item, onSelectVariant }: { item: ThreadItem; onSelectVariant?: (plan: TradePlan) => void }) {
  const strategies = item.variants && item.variants.length > 1 ? item.variants : item.plan ? [item.plan] : [];
  const recommendedIdx = strategies.length > 1 ? defaultStrategyIndex(strategies, item.recommendedIndex) : 0;
  const [activeIdx, setActiveIdx] = useState(() => {
    if (!item.plan || strategies.length <= 1) return 0;
    const idx = strategies.indexOf(item.plan);
    return idx >= 0 ? idx : recommendedIdx;
  });

  if (!item.plan) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <div className="user-bubble"><p>{item.text}</p></div>
        <div className="ai-bubble">
          <p className="ai-bubble-text">
            Describe your goal — yield, exposure, hedge, airdrops — and I&apos;ll design strategies with live rates.
          </p>
        </div>
      </div>
    );
  }

  const hasMultiple = strategies.length > 1;
  const activePlan = strategies[activeIdx] || item.plan;
  const best = hasMultiple
    ? strategies.reduce((acc, p) => {
        const a = strategyView(p).apyPct;
        return a !== undefined && (acc === undefined || a > acc) ? a : acc;
      }, undefined as number | undefined)
    : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <div className="user-bubble"><p>{item.text || "Describe your thesis."}</p></div>

      <div className="ai-bubble ai-bubble--wide">
        {item.notice && (
          <div className="risk-note" role="status" style={{ border: "1px solid var(--color-divider)" }}>
            <div className="risk-note__label" style={{ color: "var(--color-neutral-500)" }}>Heads up</div>
            <span style={{ color: "var(--color-text)" }}>{item.notice}</span>
          </div>
        )}

        <div className="answer-head">
          <span className="answer-head__kicker">
            {intentLabel(activePlan.intent)}
            {hasMultiple && ` · ${strategies.length} strategies`}
            {best !== undefined && ` · up to ${fmtPct(best)}`}
          </span>
          {item.understanding && <p className="answer-head__text">{item.understanding}</p>}
          {hasMultiple && (
            <p className="answer-head__hint">Compare them below, pick one, then sign its steps. Rates are live and change.</p>
          )}
        </div>

        {hasMultiple && (
          <div className="strategy-grid" role="group" aria-label="Strategies">
            {strategies.map((plan, i) => (
              <CompareCard
                key={i}
                plan={plan}
                isActive={i === activeIdx}
                isRecommended={i === recommendedIdx}
                onSelect={() => {
                  setActiveIdx(i);
                  onSelectVariant?.(plan);
                }}
              />
            ))}
          </div>
        )}

        <StrategyDetail plan={activePlan} isRecommended={hasMultiple && activeIdx === recommendedIdx} single={!hasMultiple} />
      </div>
    </div>
  );
}
