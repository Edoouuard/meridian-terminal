"use client";

import { ProtocolLogos } from "@/components/ProtocolLogo";
import { useState } from "react";
import { ThreadItem, fmtUsd } from "@/lib/data";
import type { TradePlan } from "@/lib/tradePlan";
import { defaultStrategyIndex, fmtPct, strategyView, type RiskTier, type StrategyView } from "@/lib/strategyView";
import { ExecuteStrategyButton, StrategyLegs } from "@/components/thread/StrategyLegs";
import { YieldFinderCard } from "@/components/thread/YieldFinderCard";
import { askMeridian } from "@/lib/askBus";
import { MarketChart } from "@/components/MarketChart";

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
        {plan.kind === "alternative" && <span className="scard__badge scard__badge--muted">Alternative</span>}
        {plan.status === "blocked" && <span className="scard__badge scard__badge--warn">Blocked</span>}
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
          <ProtocolLogos names={view.protocols} size={22} />
        </span>
      )}
    </button>
  );
}

const FIGURE_KIND: Record<"observed" | "calculated" | "assumption", string> = {
  observed: "observed",
  calculated: "calculated",
  assumption: "assumption",
};

const usd = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) < 100 ? 2 : 0 })}`;

/** The plan's economics, one meaning per line (lib/planner/economics.ts); "—" where a figure is unknown. */
function EconomicsBlock({ e }: { e: NonNullable<TradePlan["economics"]> }) {
  const v = (n: number | null | undefined) => (n === null || n === undefined ? "—" : usd(n));
  const rows: [string, string][] = [
    ["Capital committed (counted once)", v(e.capitalCommittedUsd)],
  ];
  if (e.capitalAvailableUsd !== undefined) rows.push(["Already on the venues", v(e.capitalAvailableUsd)]);
  if (e.capitalToAddUsd !== undefined) rows.push(["Still to bring", v(e.capitalToAddUsd)]);
  if (e.transferFeesUsd !== undefined) rows.push(["Transfer fees", e.transferFeesUsd === null ? "depends on the route" : usd(e.transferFeesUsd)]);
  if (e.volumeUsd !== undefined) rows.push(["Volume per open + close", v(e.volumeUsd)]);
  if (e.annualizedGrossCarryUsd !== undefined) rows.push(["Carry per year at today's rates", v(e.annualizedGrossCarryUsd)]);
  if (e.entryExitCostUsd !== undefined) rows.push(["Fees to enter and exit", v(e.entryExitCostUsd)]);
  rows.push(["Holding period (assumption)", `${e.holdingDays} days`]);
  rows.push([
    "Net return on capital (projection, per year)",
    e.annualizedReturnOnCapitalPct === null ? `— (${e.returnUnavailableReason ?? "unknown"})` : `${e.annualizedReturnOnCapitalPct.toFixed(2)}%`,
  ]);
  return (
    <div className="sdetail__block" style={{ marginBottom: "var(--space-3)" }}>
      <h6>Economics{e.dataStatus === "stale" ? " · indicative (market data older than policy allows)" : ""}</h6>
      <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
        <tbody>
          {rows.map(([k, val]) => (
            <tr key={k}>
              <td className="text-muted" style={{ padding: "2px 0" }}>{k}</td>
              <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{val}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {e.legs && e.legs.length > 0 && (
        <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse", marginTop: 6 }}>
          <thead>
            <tr className="text-muted">
              <th style={{ textAlign: "left", fontWeight: 400 }}>Leg</th>
              <th style={{ textAlign: "right", fontWeight: 400 }}>Qty</th>
              <th style={{ textAlign: "right", fontWeight: 400 }}>Notional</th>
              <th style={{ textAlign: "right", fontWeight: 400 }}>Carry/yr</th>
            </tr>
          </thead>
          <tbody>
            {e.legs.map((l) => (
              <tr key={l.legIndex}>
                <td>
                  {l.side} {l.market} · {l.venue}
                </td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{l.baseQuantity ?? "—"}</td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{v(l.notionalUsd)}</td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {v(l.annualizedCarryUsd)} ({l.legCarryAnnualPct >= 0 ? "+" : ""}
                  {l.legCarryAnnualPct.toFixed(2)}%)
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
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
            {plan.kind === "alternative"
              ? "Alternative — changes your request"
              : plan.kind === "requested"
                ? plan.status === "blocked"
                  ? "Your request — blocked for now"
                  : isRecommended
                    ? "Your request · recommended"
                    : "Your request"
                : single
                  ? "Strategy"
                  : isRecommended
                    ? "Recommended for you"
                    : "Selected strategy"}
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

      {plan.changes && plan.changes.length > 0 && (
        <div className="risk-note" role="note" style={{ border: "1px solid var(--color-divider)" }}>
          <div className="risk-note__label">Changes your request</div>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {plan.changes.map((c) => <li key={c}>{c}</li>)}
          </ul>
          <span className="text-muted" style={{ fontSize: 12 }}>Signing it means you accept these changes.</span>
        </div>
      )}
      {plan.status === "blocked" && plan.blockers && (
        <div className="risk-note" role="status" style={{ border: "1px solid var(--risk-warning)" }}>
          <div className="risk-note__label" style={{ color: "var(--risk-warning)" }}>Blocked for now</div>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {plan.blockers.map((b) => <li key={b}>{b}</li>)}
          </ul>
        </div>
      )}

      <p className="sdetail__summary">{plan.summary}</p>

      {plan.economics && <EconomicsBlock e={plan.economics} />}
      {plan.figures && plan.figures.length > 0 && (
        <details className="how-computed">
          <summary>Where the numbers come from</summary>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12 }}>
            {plan.figures.map((f, k) => (
              <li key={k}>
                <strong>{f.label}</strong> {f.value} · <span className="text-muted">{FIGURE_KIND[f.kind]}: {f.source}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

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
        {plan.pair && (
          <p className="text-muted" style={{ fontSize: 12, margin: "0 0 var(--space-2)" }}>
            Steps {plan.pair.legs[0] + 1} and {plan.pair.legs[1] + 1} form one neutral position at the same quantity of the asset; it is neutral only once
            both are filled.
            {plan.execution &&
              ` Send step ${plan.execution.sequence[0] + 1} first, then step ${plan.execution.sequence[1] + 1} (sized on what the first filled). ${plan.execution.orderType}. If the second hasn't filled within ${plan.execution.maxUnhedgedSeconds}s, the position is exposed: retry it or close the first (each needs your signature).`}
          </p>
        )}
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

export function ThreadCard({
  item,
  onSelectVariant,
  onAnswer,
}: {
  item: ThreadItem;
  onSelectVariant?: (plan: TradePlan) => void;
  /** Answer the planner's question (only on the latest message). */
  onAnswer?: (answer: string) => void;
}) {
  const strategies = item.variants && item.variants.length > 1 ? item.variants : item.plan ? [item.plan] : [];
  const recommendedIdx = strategies.length > 1 ? defaultStrategyIndex(strategies, item.recommendedIndex) : 0;
  const [activeIdx, setActiveIdx] = useState(() => {
    if (!item.plan || strategies.length <= 1) return 0;
    const idx = strategies.indexOf(item.plan);
    return idx >= 0 ? idx : recommendedIdx;
  });

  if (item.clarify) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <div className="user-bubble"><p>{item.text}</p></div>
        <div className="ai-bubble ai-bubble--wide">
          <div className="answer-head">
            <span className="answer-head__kicker">One question first</span>
            {item.understanding && <p className="answer-head__text">{item.understanding}</p>}
          </div>
          <p style={{ fontSize: 14, fontWeight: 600, margin: "var(--space-2) 0 4px" }}>{item.clarify.question}</p>
          {item.clarify.why && (
            <p className="text-muted" style={{ fontSize: 12, margin: "0 0 var(--space-2)" }}>
              {item.clarify.why}
            </p>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
            {item.clarify.options.map((o, i) => (
              <button
                key={o}
                className={i === 0 ? "btn btn-primary" : "btn btn-secondary"}
                style={{ fontSize: 13, textAlign: "left", whiteSpace: "normal" }}
                disabled={!onAnswer}
                onClick={() => onAnswer?.(o)}
              >
                {o}
              </button>
            ))}
          </div>
          {onAnswer && (
            <p className="text-muted" style={{ fontSize: 11, margin: "var(--space-2) 0 0" }}>
              Or type your own answer below.
            </p>
          )}
        </div>
      </div>
    );
  }

  if (item.answer) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <div className="user-bubble"><p>{item.text}</p></div>
        <div className="ai-bubble ai-bubble--wide market-answer">
          <div className="answer-head">
            <span className="answer-head__kicker">Market read · live data</span>
          </div>
          <p className="market-answer__headline">{item.answer.headline}</p>
          <ul className="market-answer__points">
            {item.answer.points.map((p, i) => (
              <li key={i} style={{ animationDelay: `${120 + i * 70}ms` }}>
                {p}
              </li>
            ))}
          </ul>
          {item.answer.charts && item.answer.charts.length > 0 && (
            <div className="market-answer__charts">
              {item.answer.charts.map((c) => (
                <MarketChart key={c.id} chart={c} />
              ))}
            </div>
          )}
          {item.answer.takeaway && <p className="market-answer__takeaway">{item.answer.takeaway}</p>}
          {item.answer.followUps.length > 0 && (
            <div className="market-answer__next">
              <span className="text-muted" style={{ fontSize: 11 }}>Act on it</span>
              {item.answer.followUps.map((f) => (
                <button key={f} type="button" className="btn btn-secondary market-answer__ask" onClick={() => askMeridian(f)}>
                  {f} <span aria-hidden="true">→</span>
                </button>
              ))}
            </div>
          )}
          <p className="text-muted" style={{ fontSize: 11, margin: 0 }}>A read of today&apos;s data, not a forecast or advice.</p>
        </div>
      </div>
    );
  }

  if (!item.plan) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <div className="user-bubble"><p>{item.text}</p></div>
        <div className="ai-bubble">
          <p className="ai-bubble-text">
            {item.notice ?? "Describe your goal — yield, exposure, hedge, airdrops — and I'll design strategies with live rates."}
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
                // A blocked plan is never badged "Recommended": it stays first, saying what blocks it.
                isRecommended={i === recommendedIdx && plan.status !== "blocked"}
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
