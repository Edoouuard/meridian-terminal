/**
 * policy.ts — Transaction policy engine.
 *
 * Pre-sign validation layer that enforces safety rules before any
 * transaction reaches the user's wallet for signing. Checks:
 *
 * 1. Per-tx value limits (reject unusually large transfers)
 * 2. Daily volume limits (cumulative spending caps)
 * 3. Address whitelist / blacklist (known scam contracts)
 * 4. Rate limiting (prevent accidental rapid-fire signing)
 * 5. Chain restrictions (only approved chains)
 * 6. Slippage bounds (reject routes with excessive slippage)
 *
 * Pure and synchronous — no I/O, no wallet interaction.
 * The orchestrator calls `evaluatePolicy()` before presenting
 * a transaction for signing. If refused, the tx is blocked.
 */

import type { Address } from "viem";

// ─── Policy configuration ────────────────────────────────────────────

export interface PolicyConfig {
  /** Max single transaction value in USD. Default: $50,000. */
  maxTxValueUsd: number;
  /** Max cumulative daily volume in USD. Default: $500,000. */
  maxDailyVolumeUsd: number;
  /** Min seconds between transactions. Default: 5. */
  minTxIntervalSeconds: number;
  /** Max slippage allowed (0..1). Default: 0.03 (3%). */
  maxSlippage: number;
  /** Allowed chain IDs. Empty = all chains allowed. */
  allowedChainIds: number[];
  /** Blocked addresses (known scam contracts, sanctioned). */
  blockedAddresses: Set<string>;
  /** Whether to require explicit confirmation for cross-chain txs. */
  requireCrossChainConfirmation: boolean;
}

export const DEFAULT_POLICY: PolicyConfig = {
  maxTxValueUsd: 50_000,
  maxDailyVolumeUsd: 500_000,
  minTxIntervalSeconds: 5,
  maxSlippage: 0.03,
  allowedChainIds: [], // empty = all allowed
  blockedAddresses: new Set(),
  requireCrossChainConfirmation: true,
};

// ─── Policy evaluation ───────────────────────────────────────────────

export interface PolicyInput {
  /** Target contract address. */
  to: Address;
  /** Transaction value in USD. */
  valueUsd: number;
  /** Chain ID. */
  chainId: number;
  /** Destination chain ID (for cross-chain). Undefined = same-chain. */
  destChainId?: number;
  /** Slippage tolerance (0..1). */
  slippage?: number;
  /** Cumulative volume already spent today (USD). */
  dailyVolumeUsd: number;
  /** Timestamp of the last transaction (ms). */
  lastTxTimestamp: number;
}

export type PolicyVerdict = "allow" | "warn" | "block";

export interface PolicyResult {
  verdict: PolicyVerdict;
  violations: PolicyViolation[];
}

export interface PolicyViolation {
  rule: string;
  severity: PolicyVerdict;
  message: string;
}

/**
 * Evaluate a transaction against the policy engine.
 * Returns a verdict (allow/warn/block) and a list of violations.
 */
export function evaluatePolicy(
  input: PolicyInput,
  config: PolicyConfig = DEFAULT_POLICY,
): PolicyResult {
  const violations: PolicyViolation[] = [];

  // 1. Blocked address
  if (config.blockedAddresses.has(input.to.toLowerCase())) {
    violations.push({
      rule: "blocked_address",
      severity: "block",
      message: `Address ${input.to} is on the blocklist (known scam or sanctioned).`,
    });
  }

  // 2. Per-tx value limit
  if (input.valueUsd > config.maxTxValueUsd) {
    violations.push({
      rule: "max_tx_value",
      severity: "block",
      message: `Transaction value $${input.valueUsd.toLocaleString()} exceeds the $${config.maxTxValueUsd.toLocaleString()} per-tx limit.`,
    });
  } else if (input.valueUsd > config.maxTxValueUsd * 0.8) {
    violations.push({
      rule: "max_tx_value_warning",
      severity: "warn",
      message: `Transaction value $${input.valueUsd.toLocaleString()} is close to the $${config.maxTxValueUsd.toLocaleString()} limit.`,
    });
  }

  // 3. Daily volume limit
  const projectedDaily = input.dailyVolumeUsd + input.valueUsd;
  if (projectedDaily > config.maxDailyVolumeUsd) {
    violations.push({
      rule: "daily_volume",
      severity: "block",
      message: `This transaction would push daily volume to $${projectedDaily.toLocaleString()}, exceeding the $${config.maxDailyVolumeUsd.toLocaleString()} daily limit.`,
    });
  }

  // 4. Rate limiting
  const elapsed = (Date.now() - input.lastTxTimestamp) / 1000;
  if (input.lastTxTimestamp > 0 && elapsed < config.minTxIntervalSeconds) {
    violations.push({
      rule: "rate_limit",
      severity: "warn",
      message: `Only ${elapsed.toFixed(1)}s since last transaction. Minimum interval is ${config.minTxIntervalSeconds}s.`,
    });
  }

  // 5. Chain restriction
  if (config.allowedChainIds.length > 0) {
    if (!config.allowedChainIds.includes(input.chainId)) {
      violations.push({
        rule: "chain_not_allowed",
        severity: "block",
        message: `Chain ${input.chainId} is not in the allowed chains list.`,
      });
    }
    if (input.destChainId && !config.allowedChainIds.includes(input.destChainId)) {
      violations.push({
        rule: "dest_chain_not_allowed",
        severity: "block",
        message: `Destination chain ${input.destChainId} is not in the allowed chains list.`,
      });
    }
  }

  // 6. Slippage bounds
  if (input.slippage !== undefined && input.slippage > config.maxSlippage) {
    violations.push({
      rule: "excessive_slippage",
      severity: "block",
      message: `Slippage ${(input.slippage * 100).toFixed(1)}% exceeds the ${(config.maxSlippage * 100).toFixed(1)}% maximum.`,
    });
  }

  // 7. Cross-chain confirmation
  if (
    config.requireCrossChainConfirmation &&
    input.destChainId !== undefined &&
    input.destChainId !== input.chainId
  ) {
    violations.push({
      rule: "cross_chain_confirmation",
      severity: "warn",
      message: `Cross-chain transaction from chain ${input.chainId} to ${input.destChainId} requires explicit confirmation.`,
    });
  }

  // Determine overall verdict
  const hasBlock = violations.some((v) => v.severity === "block");
  const hasWarn = violations.some((v) => v.severity === "warn");
  const verdict: PolicyVerdict = hasBlock ? "block" : hasWarn ? "warn" : "allow";

  return { verdict, violations };
}

// ─── Daily volume tracker ────────────────────────────────────────────

interface VolumeTracker {
  date: string; // YYYY-MM-DD
  totalUsd: number;
  lastTxTimestamp: number;
}

let volumeState: VolumeTracker = {
  date: "",
  totalUsd: 0,
  lastTxTimestamp: 0,
};

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Get current daily volume and last tx timestamp. */
export function getDailyVolume(): { dailyVolumeUsd: number; lastTxTimestamp: number } {
  if (volumeState.date !== todayKey()) {
    volumeState = { date: todayKey(), totalUsd: 0, lastTxTimestamp: volumeState.lastTxTimestamp };
  }
  return { dailyVolumeUsd: volumeState.totalUsd, lastTxTimestamp: volumeState.lastTxTimestamp };
}

/** Record a completed transaction for volume tracking. */
export function recordTransaction(valueUsd: number): void {
  if (volumeState.date !== todayKey()) {
    volumeState = { date: todayKey(), totalUsd: 0, lastTxTimestamp: 0 };
  }
  volumeState.totalUsd += valueUsd;
  volumeState.lastTxTimestamp = Date.now();
}
