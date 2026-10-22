/**
 * policy.ts — product parameters, given to the planner as data (it must not
 * invent them) and applied by the server checks. Every value here is an
 * ASSUMPTION in the planner's provenance terms.
 */

import { MARKET_SLIPPAGE } from "@/lib/integrations/hyperliquidTrade";

export const SIZING_POLICY = {
  /** Share of the free amount committed when the user gave no size. */
  maxUtilization: 0.8,
  /** USD kept aside per venue for fees and rounding. */
  feeReserveUsd: 1,
  /** Margin requested above notional / leverage, for fees and price moves while the order fills. */
  marginBufferPct: 3,
  /** Leverage when the user gave none. */
  defaultLeverage: { neutral: 1, carry: 1, farming: 3, directional: 1 },
  /** Holding period used to spread entry + exit costs over a year, in days, when the user gave none. */
  defaultHoldingDays: { carry: 30, farming: 7, directional: 7, yield: 365, hedge: 30 },
  /** A two-leg neutral position is within tolerance when |long qty − short qty| / qty ≤ this, after rounding. */
  residualDeltaTolerancePct: 2,
} as const;

/**
 * How old a figure may be for each use. The execution buttons re-read price,
 * balance and market rules when the user signs, so a stale planner figure is
 * only ever indicative: "refresh" means execution reads it again; "block"
 * means the plan can't be called executable on it; "indicative_only" means
 * it explains but never sizes.
 */
export const DATA_POLICY = {
  marketPrice: { maxAgeSeconds: 120, requiredForExecution: true, staleBehavior: "refresh" },
  marketRules: { maxAgeSeconds: 3600, requiredForExecution: true, staleBehavior: "refresh" },
  balance: { maxAgeSeconds: 120, requiredForExecution: true, staleBehavior: "refresh" },
  funding: { maxAgeSeconds: 3600, requiredForExecution: false, staleBehavior: "indicative_only" },
  yield: { maxAgeSeconds: 3600, requiredForExecution: false, staleBehavior: "indicative_only" },
} as const;

/**
 * How a two-leg position is executed by Meridian today: two orders the user
 * signs one after the other. Nothing is sent or unwound without a signature.
 */
export const EXECUTION_POLICY = {
  /** Open first the leg on the market with the lower 24h volume (the harder fill), then the other. */
  sequence: "lower_volume_first",
  orderType: "IOC market order (fills now within the slippage bound, or not at all)",
  maxSlippagePct: { Hyperliquid: MARKET_SLIPPAGE * 100, Extended: 1, TxFlow: 1 },
  /** Past this, a single filled leg is flagged as an exposed partial fill. */
  maxUnhedgedSeconds: 120,
  /** The second leg trades the quantity the first one filled. */
  secondLegSizing: "first_leg_filled_quantity",
  onPartialFill: "flag_partially_filled; the user retries the missing leg or closes the filled one (reduce-only market)",
  requiresUserApproval: ["every order", "retry of a failed leg", "closing a filled leg"],
} as const;

/** What "SL 20%" means in Meridian: the adverse move of the price from the entry, not a loss on margin. */
export const STOP_LOSS_CONVENTION = {
  basis: "price_move_from_entry",
  /** "SL 20% of margin" converts to a price move of 20% / leverage. */
  marginBasisConversion: "price_pct = margin_pct / leverage",
} as const;

/**
 * Ranking keys per objective, applied in order (lexicographic) by the
 * server to EXECUTABLE requested plans. Venue safety uses only what the data
 * gives (TVL; Philidor risk tier when listed), never an opinion.
 */
export const RANKING_POLICY = {
  explicit_order: ["fidelity to the order (no other key)"],
  farming: ["lowest entry+exit cost per dollar of volume", "lowest capital to add", "lowest capital committed", "highest net carry over the holding period"],
  neutral_carry: ["highest annualized net return on committed capital", "lowest capital to add"],
  yield: ["highest annualized net return on committed capital", "highest TVL of the venue in the data"],
  hedge: ["lowest residual exposure", "lowest entry+exit cost"],
  directional: ["fidelity to the user's parameters"],
  move: ["lowest total fees"],
} as const;

export function policySection(): string {
  const p = SIZING_POLICY;
  const e = EXECUTION_POLICY;
  return [
    "# Product policy (parameters — cite them as assumptions; never replace them with your own)",
    "## Sizing",
    `- No size given: commit at most ${p.maxUtilization * 100}% of the FREE amount on the venue that pays (free margin for perps, free wallet balance for spot), after a $${p.feeReserveUsd} reserve per venue. Unknown free amount: leave the size null (the plan is blocked).`,
    `- Margin per perp leg = notional / leverage × (1 + ${p.marginBufferPct}%).`,
    `- Default leverage: neutral / carry ${p.defaultLeverage.neutral}x, farming (volume / open interest for points) ${p.defaultLeverage.farming}x, directional ${p.defaultLeverage.directional}x — only when the user gave none.`,
    `- Default holding period: carry ${p.defaultHoldingDays.carry} days, farming ${p.defaultHoldingDays.farming}, directional ${p.defaultHoldingDays.directional}, yield ${p.defaultHoldingDays.yield}, hedge ${p.defaultHoldingDays.hedge}.`,
    `- Two-leg neutral position: the same base quantity on both legs, a quantity valid on both markets (the server computes it); residual delta tolerance ${p.residualDeltaTolerancePct}%.`,
    "## Stop-loss convention",
    `- "SL X%" is an adverse price move of X% from the entry. "SL X% of margin" becomes a price move of X% / leverage. State which one you applied.`,
    "## Data freshness",
    ...Object.entries(DATA_POLICY).map(([k, v]) => `- ${k}: max age ${v.maxAgeSeconds}s, ${v.requiredForExecution ? "required to execute" : "not required to execute"}, when stale: ${v.staleBehavior}.`),
    "## Execution of two-leg positions",
    `- Sequence: ${e.sequence.replace(/_/g, " ")}; ${e.orderType}; max slippage Hyperliquid ${e.maxSlippagePct.Hyperliquid}%, Extended ${e.maxSlippagePct.Extended}%, TxFlow ${e.maxSlippagePct.TxFlow}%.`,
    `- Second leg sized on the first leg's filled quantity. A single filled leg older than ${e.maxUnhedgedSeconds}s is an exposed partial fill: ${e.onPartialFill}.`,
    `- Needs a new user signature: ${e.requiresUserApproval.join(", ")}.`,
    "## Ranking (the server applies these keys to executable requested plans)",
    ...Object.entries(RANKING_POLICY).map(([k, v]) => `- ${k}: ${v.join(" → ")}`),
  ].join("\n");
}
