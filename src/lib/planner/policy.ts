/**
 * policy.ts — product parameters for sizing and economics, given to the
 * planner as data (it must not invent them) and used by the server checks.
 * Every value here is an ASSUMPTION in the planner's provenance terms.
 */

export const SIZING_POLICY = {
  /** Share of the free amount committed when the user gave no size. */
  maxUtilization: 0.8,
  /** USD kept aside per venue for fees and rounding. */
  feeReserveUsd: 1,
  /** Margin requested above notional / leverage, for fees and price moves while the order fills. */
  marginBufferPct: 3,
  /** Leverage when the user gave none. */
  defaultLeverage: { neutral: 1, carry: 1, farming: 1, directional: 2 },
  /** Holding period used to spread entry + exit costs over a year, in days, when the user gave none. */
  defaultHoldingDays: { carry: 30, farming: 7, directional: 7, yield: 365, hedge: 30 },
  /** A two-leg neutral position is within tolerance when |long qty − short qty| / qty ≤ this, after rounding. */
  residualDeltaTolerancePct: 2,
} as const;

export function policySection(): string {
  const p = SIZING_POLICY;
  return [
    "# Sizing policy (product parameters — cite them as assumptions)",
    `- No size given: commit at most ${p.maxUtilization * 100}% of the FREE amount on the venue that pays (free margin for perps, free wallet balance for spot), after a $${p.feeReserveUsd} reserve per venue.`,
    `- Margin per perp leg = notional / leverage × (1 + ${p.marginBufferPct}%).`,
    `- Default leverage: neutral / carry / farming ${p.defaultLeverage.neutral}x, directional ${p.defaultLeverage.directional}x — only when the user gave none.`,
    `- Default holding period (to annualize entry + exit costs): carry ${p.defaultHoldingDays.carry} days, farming ${p.defaultHoldingDays.farming}, directional ${p.defaultHoldingDays.directional}, yield ${p.defaultHoldingDays.yield}, hedge ${p.defaultHoldingDays.hedge}.`,
    `- A two-leg neutral position uses the SAME BASE QUANTITY on both legs (not the same dollars), rounded down to the coarser of the two size steps; residual delta tolerance ${p.residualDeltaTolerancePct}%.`,
  ].join("\n");
}
