"use client";

import { useState } from "react";
import { ThreadItem, fmtUsd } from "@/lib/data";
import type { TradePlan } from "@/lib/tradePlan";
import { ExecuteStrategyButton, StrategyLegs } from "@/components/thread/StrategyLegs";
import { YieldFinderCard } from "@/components/thread/YieldFinderCard";

const RISK_COLORS: Record<string, string> = {
  conservative: "var(--risk-good)",
  moderate: "var(--risk-warning)",
  aggressive: "var(--risk-serious)",
};

const RISK_BG: Record<string, string> = {
  conservative: "color-mix(in srgb, var(--risk-good) 8%, transparent)",
  moderate: "color-mix(in srgb, var(--risk-warning) 8%, transparent)",
  aggressive: "color-mix(in srgb, var(--risk-serious) 8%, transparent)",
};

const RISK_BORDER: Record<string, string> = {
  conservative: "color-mix(in srgb, var(--risk-good) 20%, transparent)",
  moderate: "color-mix(in srgb, var(--risk-warning) 20%, transparent)",
  aggressive: "color-mix(in srgb, var(--risk-serious) 20%, transparent)",
};

function riskLabel(plan: TradePlan): string | null {
  if (plan.riskTier) return plan.riskTier;
  const note = (plan.variantNote ?? "").toLowerCase();
  if (note.includes("conservative")) return "conservative";
  if (note.includes("moderate")) return "moderate";
  if (note.includes("aggressive")) return "aggressive";
  const label = (plan.variantLabel ?? "").toLowerCase();
  if (label.includes("conservative")) return "conservative";
  if (label.includes("moderate")) return "moderate";
  if (label.includes("aggressive")) return "aggressive";
  return null;
}

/** Individual strategy card — collapsed (preview) or expanded (full details). */
function StrategyCard({ plan, item, isActive, onClick }: {
  plan: TradePlan;
  item: ThreadItem;
  isActive: boolean;
  onClick: () => void;
}) {
  const risk = riskLabel(plan);
  const riskColor = risk ? RISK_COLORS[risk] : undefined;
  const protocols = [...new Set(plan.legs.map((l) => l.protocol).filter(Boolean))];

  return (
    <div
      className={`strategy-card${isActive ? " strategy-card--active" : ""}`}
      onClick={isActive ? undefined : onClick}
      role={isActive ? undefined : "button"}
      tabIndex={isActive ? undefined : 0}
      onKeyDown={isActive ? undefined : (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
    >
      {/* Risk-colored top bar */}
      <div
        className="strategy-card__risk-bar"
        style={{ background: riskColor || "var(--color-divider)" }}
      />

      {/* Header */}
      <div className="strategy-card__header">
        <span className="strategy-card__name">
          {plan.variantLabel || "Strategy"}
        </span>
        {risk && (
          <span
            className="strategy-card__risk-label"
            style={{
              color: riskColor,
              background: risk ? RISK_BG[risk] : undefined,
            }}
          >
            {risk}
          </span>
        )}
      </div>

      {/* Body */}
      <div className="strategy-card__body">
        <p className="strategy-card__summary">{plan.summary}</p>

        {/* Protocol pills */}
        {protocols.length > 0 && (
          <div className="strategy-card__protocols">
            {protocols.map((p) => (
              <span key={p} className="protocol-pill">{p}</span>
            ))}
          </div>
        )}

        {/* Meta */}
        <div className="strategy-card__meta">
          {plan.legs.length > 0 && <span>{plan.legs.length} leg{plan.legs.length > 1 ? "s" : ""}</span>}
          {plan.sizeUsd && plan.sizeUsd > 0 && <span>{fmtUsd(plan.sizeUsd)}</span>}
          {plan.leverage && <span>{plan.leverage}x</span>}
        </div>
      </div>

      {/* Expanded details when active */}
      {isActive && (
        <div className="strategy-card__exec">
          {/* Risk note */}
          {plan.variantNote && (
            <div
              className="risk-note"
              style={{
                background: risk ? RISK_BG[risk] : "color-mix(in srgb, var(--color-text) 4%, transparent)",
                border: `1px solid ${risk ? RISK_BORDER[risk] : "var(--color-divider)"}`,
              }}
            >
              <div className="risk-note__label" style={{ color: riskColor || "var(--color-neutral-500)" }}>
                {riskColor && <span style={{ width: 5, height: 5, borderRadius: "50%", background: riskColor }} />}
                {risk || "Note"}
              </div>
              <span style={{ color: "var(--color-text)" }}>{plan.variantNote}</span>
            </div>
          )}

          {/* Yield search */}
          {plan.intent === "yieldSearch" && (
            <YieldFinderCard asset={plan.asset ?? "USDC"} sizeUsd={plan.sizeUsd ?? 10000} />
          )}

          {/* Execution legs */}
          <StrategyLegs plan={plan} />

          {/* Batch execute button — only when there are multiple executable legs */}
          {plan.legs.length > 1 && <ExecuteStrategyButton plan={plan} />}
        </div>
      )}
    </div>
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
  const [activeIdx, setActiveIdx] = useState(() => {
    if (!item.plan || strategies.length <= 1) return 0;
    // Default to moderate
    const moderateIdx = strategies.findIndex((s) => {
      const r = riskLabel(s);
      return r === "moderate";
    });
    if (moderateIdx >= 0) return moderateIdx;
    const idx = strategies.indexOf(item.plan);
    return idx >= 0 ? idx : 0;
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      {/* User message */}
      <div className="user-bubble"><p>{item.text || "Describe your thesis."}</p></div>

      {/* AI response */}
      <div className="ai-bubble">
        {item.notice && (
          <div className="risk-note" role="status" style={{ border: "1px solid var(--color-divider)", marginBottom: "var(--space-2)" }}>
            <div className="risk-note__label" style={{ color: "var(--color-neutral-500)" }}>Heads up</div>
            <span style={{ color: "var(--color-text)" }}>{item.notice}</span>
          </div>
        )}
        {/* Understanding line */}
        <p className="ai-bubble-text">
          <span style={{
            fontFamily: "var(--font-heading)",
            fontWeight: 600,
            color: "var(--color-accent)",
            fontSize: 14,
          }}>
            {intentLabel(activePlan.intent)}
          </span>
          {hasMultiple && (
            <span style={{ color: "var(--color-neutral-500)", fontSize: 12 }}>
              {" "}— {strategies.length} strategies designed. Click to explore.
            </span>
          )}
        </p>

        {/* Strategy cards grid */}
        {hasMultiple ? (
          <div className="strategy-grid">
            {strategies.map((plan, i) => (
              <StrategyCard
                key={i}
                plan={plan}
                item={item}
                isActive={i === activeIdx}
                onClick={() => {
                  setActiveIdx(i);
                  onSelectVariant?.(plan);
                }}
              />
            ))}
          </div>
        ) : (
          /* Single strategy — always expanded */
          <div
            className="strategy-card strategy-card--active"
            style={{ cursor: "default" }}
          >
            <div
              className="strategy-card__risk-bar"
              style={{ background: riskLabel(activePlan) ? RISK_COLORS[riskLabel(activePlan)!] : "var(--color-accent)" }}
            />
            <div className="strategy-card__header">
              <span className="strategy-card__name">
                {activePlan.variantLabel || intentLabel(activePlan.intent)}
              </span>
              {(() => {
                const risk = riskLabel(activePlan);
                return risk ? (
                  <span className="strategy-card__risk-label" style={{ color: RISK_COLORS[risk], background: RISK_BG[risk] }}>
                    {risk}
                  </span>
                ) : null;
              })()}
            </div>
            <div className="strategy-card__body">
              <p className="strategy-card__summary" style={{ WebkitLineClamp: "unset" as unknown as number, overflow: "visible" }}>
                {activePlan.summary}
              </p>
              {(() => {
                const protocols = [...new Set(activePlan.legs.map((l) => l.protocol).filter(Boolean))];
                return protocols.length > 0 ? (
                  <div className="strategy-card__protocols">
                    {protocols.map((p) => <span key={p} className="protocol-pill">{p}</span>)}
                  </div>
                ) : null;
              })()}
            </div>
            <div className="strategy-card__exec">
              {activePlan.variantNote && (() => {
                const risk = riskLabel(activePlan);
                const riskColor = risk ? RISK_COLORS[risk] : undefined;
                return (
                  <div className="risk-note" style={{
                    background: risk ? RISK_BG[risk] : "color-mix(in srgb, var(--color-text) 4%, transparent)",
                    border: `1px solid ${risk ? RISK_BORDER[risk] : "var(--color-divider)"}`,
                  }}>
                    <div className="risk-note__label" style={{ color: riskColor || "var(--color-neutral-500)" }}>
                      {riskColor && <span style={{ width: 5, height: 5, borderRadius: "50%", background: riskColor }} />}
                      {risk || "Note"}
                    </div>
                    <span style={{ color: "var(--color-text)" }}>{activePlan.variantNote}</span>
                  </div>
                );
              })()}
              {activePlan.intent === "yieldSearch" && (
                <YieldFinderCard asset={activePlan.asset ?? "USDC"} sizeUsd={activePlan.sizeUsd ?? 10000} />
              )}
              <StrategyLegs plan={activePlan} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
