/**
 * orchestrator.ts — Meridian Agent / top-level orchestration.
 *
 * The single entry point that ties together the full pipeline:
 *
 *   User intent (natural language)
 *     → Intent engine (Claude LLM)
 *       → Portfolio + risk layer (positions, health, delta)
 *         → Routing layer (Haiku/deBridge/LI.FI/Base MCPs)
 *           → Transaction policy engine (limits, whitelist, rate)
 *             → Execution plan (unsigned txs for wallet signing)
 *               → Broadcast + monitoring + alerting
 *
 * This module orchestrates each step, handling fallbacks and errors
 * at every layer. It produces an `ActionPlan` that the UI can present
 * for user approval before any signing occurs.
 */

import type { Address } from "viem";
import type { ThreadItem } from "@/lib/data";
import type { TradePlan } from "@/lib/tradePlan";
import type { RouteQuote, RouteRequest, McpProviderStatus } from "./mcp/types";
import type { PolicyResult, PolicyConfig } from "./policy";
import type { TxTracker } from "./mcp/types";

import { routeThesisAsync, type PortfolioContext } from "./intentEngine";
import { findBestRoute, buildRouteExecution, checkAllProviders, getAllProviderStatus, type RouteComparison } from "./mcp/router";
import { evaluatePolicy, getDailyVolume, recordTransaction, DEFAULT_POLICY } from "./policy";
import { trackTransaction, onTxEvent, type TxEvent } from "./broadcast";
import * as haiku from "./mcp/providers/haiku";
import * as base from "./mcp/providers/base";

// ─── Action plan (what the UI shows before signing) ──────────────────

export interface ActionStep {
  id: string;
  type: "approve" | "swap" | "bridge" | "supply" | "borrow" | "repay" | "withdraw" | "stake" | "transfer";
  description: string;
  chainId: number;
  destChainId?: number;
  valueUsd: number;
  provider: string;
  /** Policy evaluation result for this step. */
  policy: PolicyResult;
}

export interface ActionPlan {
  /** The parsed intent / strategy from the LLM. */
  intent: ThreadItem;
  /** Selected strategy (from variants). */
  strategy: TradePlan;
  /** Route comparison (if cross-chain/swap involved). */
  routeComparison?: RouteComparison;
  /** Ordered execution steps. */
  steps: ActionStep[];
  /** Overall verdict: can we proceed? */
  canExecute: boolean;
  /** Reasons why execution might be blocked or warned. */
  warnings: string[];
  /** Provider health at plan time. */
  providerStatus: McpProviderStatus[];
}

// ─── Orchestrator state ──────────────────────────────────────────────

let policyConfig: PolicyConfig = { ...DEFAULT_POLICY };

/** Update the policy configuration (e.g., user adjusts limits). */
export function setPolicyConfig(config: Partial<PolicyConfig>): void {
  policyConfig = { ...policyConfig, ...config };
}

/** Get current policy configuration. */
export function getPolicyConfig(): PolicyConfig {
  return { ...policyConfig };
}

// ─── Main orchestration pipeline ─────────────────────────────────────

/**
 * Full orchestration: user text → action plan ready for signing.
 *
 * 1. Parse intent via Claude (with portfolio context)
 * 2. Enrich with live portfolio data from Haiku MCP
 * 3. Route cross-chain legs via deBridge/LI.FI
 * 4. Evaluate each step against the policy engine
 * 5. Return the complete ActionPlan for UI presentation
 */
export async function planAction(
  userText: string,
  userAddress: Address,
  portfolio?: PortfolioContext,
): Promise<ActionPlan> {
  const warnings: string[] = [];

  // 1. Parse intent
  const intent = await routeThesisAsync(userText, portfolio);
  const strategy = intent.plan ?? intent.variants?.[0];

  if (!strategy) {
    return {
      intent,
      strategy: { intent: "unknown", asset: "ETH", legs: [], summary: "Could not parse intent" } as TradePlan,
      steps: [],
      canExecute: false,
      warnings: ["Could not parse a valid strategy from your input."],
      providerStatus: getAllProviderStatus(),
    };
  }

  // 2. Build steps from strategy legs
  const steps: ActionStep[] = [];
  let routeComparison: RouteComparison | undefined;

  for (const leg of strategy.legs) {
    const side = leg.side.toLowerCase();
    const stepType = mapLegToStepType(side);

    // 3. For swap/bridge legs, get cross-chain route
    if (stepType === "swap" || stepType === "bridge") {
      try {
        const routeReq = await buildRouteRequest(leg, userAddress);
        if (routeReq) {
          const comparison = await findBestRoute(routeReq);
          if (comparison) {
            routeComparison = comparison;
          }
        }
      } catch (err) {
        warnings.push(`Route lookup failed for ${leg.asset}: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    }

    // 4. Evaluate policy
    const { dailyVolumeUsd, lastTxTimestamp } = getDailyVolume();
    const policy = evaluatePolicy(
      {
        to: "0x0000000000000000000000000000000000000000" as Address, // placeholder, real address from execution plan
        valueUsd: leg.sizeUsd ?? 0,
        chainId: 1, // derived from leg context
        slippage: routeComparison?.slippage,
        dailyVolumeUsd,
        lastTxTimestamp,
      },
      policyConfig,
    );

    if (policy.verdict === "block") {
      for (const v of policy.violations.filter((v) => v.severity === "block")) {
        warnings.push(v.message);
      }
    }

    steps.push({
      id: `step-${steps.length}`,
      type: stepType,
      description: `${leg.side} ${leg.asset} via ${leg.protocol}${leg.sizeUsd ? ` ($${leg.sizeUsd.toLocaleString()})` : ""}`,
      chainId: 1,
      valueUsd: leg.sizeUsd ?? 0,
      provider: leg.protocol,
      policy,
    });
  }

  const canExecute = steps.every((s) => s.policy.verdict !== "block") && steps.length > 0;

  return {
    intent,
    strategy,
    routeComparison,
    steps,
    canExecute,
    warnings,
    providerStatus: getAllProviderStatus(),
  };
}

// ─── Execute an approved plan ────────────────────────────────────────

/**
 * After the user approves a plan, execute it step by step.
 * Returns transaction trackers for monitoring.
 *
 * NOTE: This does NOT sign transactions — it prepares them for
 * the wallet to sign. The actual signing is handled by the UI
 * (useExecute hook) which calls wagmi's writeContract.
 */
export function recordExecution(
  hash: string,
  step: ActionStep,
  bridgeOrderId?: string,
): TxTracker {
  // Record in policy volume tracker
  recordTransaction(step.valueUsd);

  // Track in broadcast layer
  return trackTransaction({
    hash,
    chainId: step.chainId,
    provider: step.provider as any, // provider name from step
    destinationChainId: step.destChainId,
    bridgeOrderId,
  });
}

// ─── System health ───────────────────────────────────────────────────

export interface SystemHealth {
  providers: McpProviderStatus[];
  haiku: McpProviderStatus;
  base: McpProviderStatus;
  routingHealthy: boolean;
  dataHealthy: boolean;
}

/**
 * Check the health of all system components.
 */
export async function checkSystemHealth(): Promise<SystemHealth> {
  const [routerStatus, haikuStatus, baseStatus] = await Promise.all([
    checkAllProviders(),
    haiku.checkHealth(),
    base.checkHealth(),
  ]);

  const routingHealthy = routerStatus.some((s) => s.healthy);
  const dataHealthy = haikuStatus.healthy;

  return {
    providers: routerStatus,
    haiku: haikuStatus,
    base: baseStatus,
    routingHealthy,
    dataHealthy,
  };
}

// ─── Event forwarding ────────────────────────────────────────────────

/** Subscribe to all transaction events from the broadcast layer. */
export function onTransactionEvent(listener: (event: TxEvent) => void): () => void {
  return onTxEvent(listener);
}

// ─── Helpers ─────────────────────────────────────────────────────────

function mapLegToStepType(side: string): ActionStep["type"] {
  switch (side) {
    case "long":
    case "buy":
    case "swap":
      return "swap";
    case "short":
    case "sell":
      return "swap";
    case "bridge":
      return "bridge";
    case "supply":
      return "supply";
    case "borrow":
      return "borrow";
    case "repay":
      return "repay";
    case "withdraw":
      return "withdraw";
    case "stake":
    case "restake":
      return "stake";
    case "transfer":
      return "transfer";
    default:
      return "swap";
  }
}

import type { TradeLeg } from "./tradePlan";

async function buildRouteRequest(
  leg: TradeLeg,
  userAddress: Address,
): Promise<RouteRequest | null> {
  // Resolve token addresses via Haiku MCP
  const asset = leg.asset.replace(/\s*PERP$/i, "").trim();
  const parts = asset.split("→").map((s) => s.trim());

  if (parts.length < 2) return null; // not a swap/bridge leg

  const fromSymbol = parts[0];
  const toSymbol = parts[1];

  const [fromToken, toToken] = await Promise.all([
    haiku.resolveToken(fromSymbol, 1),
    haiku.resolveToken(toSymbol, 1),
  ]);

  if (!fromToken || !toToken) return null;

  return {
    fromChainId: fromToken.chainId,
    toChainId: toToken.chainId,
    fromToken: fromToken.address,
    toToken: toToken.address,
    fromAmount: leg.sizeUsd?.toString() ?? "0",
    userAddress,
  };
}
