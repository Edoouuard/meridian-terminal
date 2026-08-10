/**
 * Health-factor safety guardrails for REAL-money Aave actions (and anything
 * that lowers a borrower's health factor).
 *
 * Borrowing increases debt; withdrawing reduces collateral. Both push a position
 * toward liquidation. This pure module computes whether an estimated action would
 * push the resulting health factor below a safety floor, and tells callers whether
 * they can compute that at all. We NEVER fabricate a live health factor: if the
 * caller has no real read at signing time, the action must at minimum be
 * double-confirmed in the UI with an explicit warning.
 */

/** Minimum acceptable resulting health factor. Below this, an action is refused. */
export const MIN_HEALTH_FACTOR = 1.1;

/** Default Aave v3 liquidation threshold (0..1) used when a live one is absent. */
const DEFAULT_LIQUIDATION_THRESHOLD = 0.8;

export type HfLoweringKind = "borrow" | "withdraw";

/** Order types that lower a borrower's Aave health factor. */
const HF_LOWERING_TYPES: ReadonlySet<string> = new Set<HfLoweringKind>(["borrow", "withdraw"]);

/** True if the order type lowers a borrower's health factor (borrow / withdraw). */
export function isHfLoweringAction(orderType: string): boolean {
  return HF_LOWERING_TYPES.has(orderType);
}

export interface HealthFactorEstimateInput {
  /** Order type — only "borrow" and "withdraw" lower the health factor. */
  orderType: string;
  /**
   * Current health factor as an unscaled numeric value (>= 1). Aave returns the
   * `getUserAccountData` health factor scaled by 1e18 — divide before passing.
   * Omit when no live read is available (see computable below).
   */
  currentHealthFactor?: number;
  /**
   * USD value of the new debt (borrow) or of the collateral being removed
   * (withdraw). Required to estimate the resulting health factor.
   */
  hfDeltaUsd?: number;
  /**
   * Current total debt in USD. Required to scale the delta. Omit when unknown.
   */
  totalDebtUsd?: number;
  /** Aave liquidation threshold (0..1). Defaults to a conservative 0.8. */
  liquidationThreshold?: number;
}

export interface HealthFactorEstimateResult {
  /** Order type lowers the health factor (borrow/withdraw). */
  lowersHealthFactor: boolean;
  /** A live estimate could be computed (real HF + debt + delta present). */
  computable: boolean;
  /** Null when not computable. */
  estimatedHf: number | null;
  /**
   * True when the action must be refused — estimated resulting health factor
   * is below MIN_HEALTH_FACTOR. Callers must not sign when this is set.
   */
  refused: boolean;
  /** Human-readable reason to surface (present whenever the guardrail matters). */
  reason: string | null;
  /**
   * When true but computable is false, the caller has no live HF at signing time
   * and MUST double-confirm the action with an explicit warning instead.
   */
  needsExplicitConfirmation: boolean;
}

function estimate(
  kind: HfLoweringKind,
  currentHf: number,
  hfDeltaUsd: number,
  totalDebtUsd: number,
  liquidationThreshold: number,
): number | null {
  if (!Number.isFinite(totalDebtUsd) || totalDebtUsd <= 0) return null;
  const delta = Number.isFinite(hfDeltaUsd) ? Math.max(hfDeltaUsd, 0) : 0;

  if (kind === "borrow") {
    // Collateral stays put; debt grows by `delta`.
    //   HF = (collateral * lt) / debt
    //   newHF = (collateral * lt) / (debt + delta)
    // Since (collateral * lt) = currentHf * debt:
    //   newHF = (currentHf * debt) / (debt + delta)
    const newHf = (currentHf * totalDebtUsd) / (totalDebtUsd + delta);
    return Number.isFinite(newHf) ? newHf : null;
  }

  // Withdraw removes `delta` of collateral. The lt-weighted collateral base is
  // (collateral * lt) = currentHf * debt; removing `delta` erodes it by
  // delta * lt. Debt is unchanged.
  //   newHF = ((collateral * lt) - delta * lt) / debt
  const base = currentHf * totalDebtUsd;
  const reduced = base - delta * liquidationThreshold;
  if (reduced <= 0) return 0;
  const newHf = reduced / totalDebtUsd;
  return Number.isFinite(newHf) ? newHf : null;
}

/**
 * Assess an order against the health-factor guardrail. Pure — never reads the
 * chain and never signs. Callers pass a genuinely-live currentHealthFactor when
 * they have one; otherwise the result reports computable=false so the caller
 * MUST double-confirm.
 */
export function assessHealthFactorGuardrail(input: HealthFactorEstimateInput): HealthFactorEstimateResult {
  const lowers = isHfLoweringAction(input.orderType);
  if (!lowers) {
    return {
      lowersHealthFactor: false,
      computable: false,
      estimatedHf: null,
      refused: false,
      reason: null,
      needsExplicitConfirmation: false,
    };
  }

  const kind = input.orderType as HfLoweringKind;
  const hasLiveHf =
    input.currentHealthFactor !== undefined &&
    input.totalDebtUsd !== undefined &&
    Number.isFinite(input.currentHealthFactor) &&
    Number.isFinite(input.totalDebtUsd) &&
    input.totalDebtUsd > 0;

  if (!hasLiveHf) {
    // Honest refusal-to-refuse: no live read exists, so we do NOT invent one.
    // The caller must at least double-confirm the action.
    return {
      lowersHealthFactor: true,
      computable: false,
      estimatedHf: null,
      refused: false,
      reason: `Live health factor is unavailable. ${kind === "borrow" ? "Borrowing" : "Withdrawing"} lowers your Aave health factor — confirm you understand before proceeding.`,
      needsExplicitConfirmation: true,
    };
  }

  const estimatedHf = estimate(
    kind,
    input.currentHealthFactor as number,
    input.hfDeltaUsd ?? 0,
    input.totalDebtUsd as number,
    input.liquidationThreshold ?? DEFAULT_LIQUIDATION_THRESHOLD,
  );

  if (estimatedHf === null) {
    return {
      lowersHealthFactor: true,
      computable: false,
      estimatedHf: null,
      refused: false,
      reason: `Cannot verify the resulting health factor for this ${kind}. Confirm you understand it lowers your health factor.`,
      needsExplicitConfirmation: true,
    };
  }

  if (estimatedHf < MIN_HEALTH_FACTOR) {
    return {
      lowersHealthFactor: true,
      computable: true,
      estimatedHf,
      refused: true,
      reason: `This ${kind} would lower your health factor to ${estimatedHf.toFixed(2)}, below the ${MIN_HEALTH_FACTOR.toFixed(1)} safety floor. Execution is blocked.`,
      needsExplicitConfirmation: false,
    };
  }

  return {
    lowersHealthFactor: true,
    computable: true,
    estimatedHf,
    refused: false,
    reason: `This ${kind} lowers your health factor to ~${estimatedHf.toFixed(2)}.`,
    needsExplicitConfirmation: false,
  };
}