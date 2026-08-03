/**
 * riskModel.ts — pure, unit-testable risk engine for the Meridian DeFi terminal.
 *
 * All functions here are pure: they take plain numbers / arrays of plain
 * objects, perform no I/O, and touch no React state. This is the single source
 * of truth for the terminal's risk math (net ETH delta, staking concentration,
 * and the Aave-repay / delta-hedge / concentration suggestions). The live
 * portfolio hook and the Risk panel both consume this module so the numbers
 * they show are always computed the same way.
 *
 * Thresholds and targets below intentionally mirror the behavior the terminal
 * had when these calculations lived inline in the hook/panel, so refactoring
 * preserves output exactly. They are also exported as named constants so the
 * dev "Simulate a portfolio" fixture and unit tests share the same values.
 */

export const ETH_TRACKING_SYMBOLS = new Set(["ETH", "WETH", "stETH", "wstETH"]);

/** The ETH representative symbols probed (in priority order) to derive a spot ETH price. */
export const ETH_PRICE_SYMBOLS = ["ETH", "stETH", "WETH", "wstETH"];

export const STAKING_SYMBOLS = new Set(["stETH", "wstETH"]);

/** Health-factor thresholds for the Aave repay suggestion. */
export const HF_SKIP_ABOVE = 1.95;
export const HF_TARGET = 1.8;
export const HF_MIN_REPAY_USD = 50;

/** Net-delta hedge thresholds. */
export const DELTA_THRESHOLD_ETH = 0.15;
export const DELTA_TARGET_AFTER_ETH = 0.02;
export const DELTA_MIN_NOTIONAL_USD = 100;

/** Staking-concentration thresholds. */
export const CONCENTRATION_MIN_PCT = 20;
export const CONCENTRATION_MAX_PCT = 97;
export const CONCENTRATION_TARGET_PCT = 30;
export const CONCENTRATION_MIN_AMOUNT_USD = 1000;

export interface RiskAsset {
  symbol: string;
  usd: number;
  balance: number;
}

/**
 * Net directional spot exposure to ETH (tracked ETH/WETH/stETH/wstETH holdings),
 * expressed in units of ETH. Returns null when an ETH price cannot be derived.
 */
export function netEthDelta(assets: RiskAsset[], ethPrice: number | null): number | null {
  const ethExposureUsd = assets
    .filter((a) => ETH_TRACKING_SYMBOLS.has(a.symbol))
    .reduce((sum, a) => sum + a.usd, 0);
  if (ethPrice == null || ethPrice <= 0) return null;
  return ethExposureUsd / ethPrice;
}

/**
 * Approximate spot ETH price derived from a tracked holding. Probes the
 * representative symbols in `ethSymbols` order, returning the first positive
 * balance's unit price. Returns null if none is found.
 */
export function ethPriceFromAssets(assets: RiskAsset[], ethSymbols: string[] = ETH_PRICE_SYMBOLS): number | null {
  for (const sym of ethSymbols) {
    const asset = assets.find((a) => a.symbol === sym && a.balance > 0);
    if (asset) return asset.usd / asset.balance;
  }
  return null;
}

/**
 * stETH + wstETH as a percent of net portfolio value. Returns null when
 * `netUsd` is not positive.
 */
export function stakingConcentration(assets: RiskAsset[], netUsd: number): number | null {
  const stakingUsd = assets
    .filter((a) => STAKING_SYMBOLS.has(a.symbol))
    .reduce((sum, a) => sum + a.usd, 0);
  if (netUsd <= 0) return null;
  return (stakingUsd / netUsd) * 100;
}

/** Round a dollar amount to a clean, human-parseable figure (nearest $50). */
export function roundUsd(n: number): number {
  return Math.round(n / 50) * 50;
}

export interface HealthRepaySuggestion {
  skip: boolean;
  /** Raw (unrounded) USDC repay amount that lifts HF toward `target`. Present when !skip. */
  repay?: number;
  target: number;
}

/**
 * Size a USDC repay that lifts the Aave health factor toward a safe target.
 * Returns null when no health factor is available to reason about; otherwise a
 * suggestion that may be `skip`ped (HF already safe, no debt, or repay too
 * small to bother with).
 */
export function suggestHealthFactorRepay(
  healthFactor: number | null,
  debtUsd: number,
): HealthRepaySuggestion | null {
  if (healthFactor == null) return null;
  const target = HF_TARGET;
  if (healthFactor >= HF_SKIP_ABOVE || debtUsd <= 0) return { skip: true, target };
  // HF = (collateral * liqThreshold) / debt  ⇒  repay R → HF' = HF * debt / (debt - R)
  const repay = debtUsd * (1 - healthFactor / target);
  if (repay <= HF_MIN_REPAY_USD) return { skip: true, target };
  return { skip: false, repay, target };
}

export interface DeltaHedgeSuggestion {
  skip: boolean;
  /** Rounded notional (USD) of the hedge. Present when !skip. */
  shortUsd?: number;
  /** 'long' = portfolio is net long ETH (want a short hedge) · 'short' = net short ETH. */
  direction?: "long" | "short";
}

/**
 * Size a perp hedge that flattens a non-zero net ETH delta. Returns null when
 * the inputs needed to size it are unavailable; otherwise a suggestion that may
 * be `skip`ped (delta already small, or notional not worth the trade).
 */
export function suggestDeltaHedge(
  netDeltaEth: number | null,
  ethPrice: number | null,
): DeltaHedgeSuggestion | null {
  if (netDeltaEth == null || ethPrice == null || ethPrice <= 0) return null;
  if (Math.abs(netDeltaEth) < DELTA_THRESHOLD_ETH) return { skip: true };
  // Rounded before the minimum-notional check, matching the prior inline math.
  const shortUsd = roundUsd(Math.abs(netDeltaEth) * ethPrice);
  if (shortUsd <= DELTA_MIN_NOTIONAL_USD) return { skip: true };
  return { skip: false, shortUsd, direction: netDeltaEth > 0 ? "long" : "short" };
}

export interface ConcentrationSuggestion {
  skip: boolean;
  /** Raw (unrounded) dollar amount to move in/out. Present when !skip. */
  amount?: number;
  target: number;
}

/**
 * Size a move out of (or into) Lido staking to hit a target concentration.
 * Returns null when no concentration is available; otherwise a suggestion that
 * may be `skip`ped when the concentration is already in an acceptable band or
 * the move is too small to bother with.
 */
export function suggestConcentrationReduction(
  netUsd: number,
  pct: number | null,
): ConcentrationSuggestion | null {
  if (pct == null) return null;
  const target = CONCENTRATION_TARGET_PCT;
  if (netUsd <= 0) return { skip: true, target };
  if (pct < CONCENTRATION_MIN_PCT || pct > CONCENTRATION_MAX_PCT) return { skip: true, target };
  const amount = (netUsd * (pct - target)) / 100;
  if (amount <= CONCENTRATION_MIN_AMOUNT_USD) return { skip: true, target };
  return { skip: false, amount, target };
}
