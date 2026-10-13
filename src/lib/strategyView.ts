/**
 * strategyView.ts — what a strategy card shows, derived from a TradePlan.
 *
 * The planner returns an explicit blended APY, exit terms and risks; when it
 * doesn't (older answers, the local fallback parser), the APY is recovered
 * from the rates each leg's note quotes ("Currently 4.80% APY"), weighted by
 * leg size. Pure and unit-tested.
 */

import type { TradePlan, TradeLeg } from "@/lib/tradePlan";

export type RiskTier = "conservative" | "moderate" | "aggressive";

export interface StrategyView {
  /** Blended APY in percent, when known. */
  apyPct?: number;
  /** "fixed" when the rate is locked (Pendle PT), else "variable". */
  apyKind: "fixed" | "variable";
  /** Capital deployed (USD). */
  sizeUsd?: number;
  /** Expected yearly earnings at apyPct on sizeUsd. */
  yearlyUsd?: number;
  /** Chains in execution order, deduplicated ("Base", "Arbitrum"). */
  chains: string[];
  protocols: string[];
  /** Signature steps (each leg is one or two signatures). */
  steps: number;
  needsBridge: boolean;
  exit?: string;
  fit?: string;
  risks: string[];
  tier?: RiskTier;
}

const MOVE_SIDES = new Set(["bridge", "swap", "transfer"]);

/** Rate quoted in a leg note: "4.80% APY", "11.4% fixed", "APR 3.1%". */
export function rateFromNote(note: string | undefined): number | undefined {
  if (!note) return undefined;
  const m = /(-?\d+(?:\.\d+)?)\s*%\s*(?:APY|APR|fixed|annuali[sz]ed|yield)/i.exec(note) ?? /(?:APY|APR)[^\d-]{0,6}(-?\d+(?:\.\d+)?)\s*%/i.exec(note);
  if (!m) return undefined;
  const v = Number(m[1]);
  return Number.isFinite(v) && v > -100 && v < 1000 ? v : undefined;
}

/** Size-weighted APY of the legs that hold a position, from their notes. */
export function blendedApyFromLegs(legs: TradeLeg[]): number | undefined {
  let weighted = 0;
  let weight = 0;
  for (const l of legs) {
    if (MOVE_SIDES.has(l.side.toLowerCase())) continue;
    const r = rateFromNote(l.note);
    if (r === undefined) continue;
    const w = l.sizeUsd && l.sizeUsd > 0 ? l.sizeUsd : 1;
    weighted += r * w;
    weight += w;
  }
  return weight > 0 ? Math.round((weighted / weight) * 100) / 100 : undefined;
}

export function riskTierOf(plan: TradePlan): RiskTier | undefined {
  if (plan.riskTier) return plan.riskTier;
  const text = `${plan.variantNote ?? ""} ${plan.variantLabel ?? ""}`.toLowerCase();
  if (text.includes("conservative")) return "conservative";
  if (text.includes("moderate")) return "moderate";
  if (text.includes("aggressive")) return "aggressive";
  return undefined;
}

export function strategyView(plan: TradePlan): StrategyView {
  const legs = plan.legs;
  const apyPct = plan.apyPct ?? blendedApyFromLegs(legs);
  const fixed = legs.some((l) => /pendle/i.test(l.protocol) || /\bfixed\b/i.test(l.note ?? "")) || /\bfixed\b/i.test(plan.exit ?? "");
  const chains: string[] = [];
  for (const l of legs) {
    for (const c of [l.chain, l.toChain]) if (c && !chains.includes(c)) chains.push(c);
  }
  const sizeUsd = plan.sizeUsd && plan.sizeUsd > 0 ? plan.sizeUsd : undefined;
  return {
    apyPct,
    apyKind: fixed ? "fixed" : "variable",
    sizeUsd,
    yearlyUsd: apyPct !== undefined && sizeUsd !== undefined ? Math.round((sizeUsd * apyPct) / 100) : undefined,
    chains,
    protocols: [...new Set(legs.map((l) => l.protocol).filter(Boolean))],
    steps: legs.length,
    needsBridge: legs.some((l) => l.side.toLowerCase() === "bridge"),
    exit: plan.exit,
    fit: plan.fit,
    risks: plan.risks ?? [],
    tier: riskTierOf(plan),
  };
}

/** The strategy to open first: the planner's pick, else the moderate one, else the first. */
export function defaultStrategyIndex(plans: TradePlan[], recommendedIndex?: number): number {
  if (recommendedIndex !== undefined && recommendedIndex >= 0 && recommendedIndex < plans.length) return recommendedIndex;
  const moderate = plans.findIndex((p) => riskTierOf(p) === "moderate");
  return moderate >= 0 ? moderate : 0;
}

export function fmtPct(v: number): string {
  return `${v.toFixed(v >= 100 ? 0 : 2)}%`;
}
