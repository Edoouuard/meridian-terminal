/**
 * intentEngine.ts — LLM-backed thesis → strategy engine.
 *
 * Calls /api/parse-intent (Claude) to understand free-form user intent and
 * produce 3 risk-tiered, multi-leg strategies. Falls back to the regex parser
 * (routeThesis) when the API is unavailable or misconfigured.
 *
 * This is the "agentic brain" of Meridian — the user says what they want,
 * the LLM figures out HOW across all available protocols.
 */

import type { ThreadItem, ThreadType } from "@/lib/data";
import type { TradePlan, TradeIntent, TradeLeg } from "@/lib/tradePlan";
import { routeThesis } from "@/lib/routeThesis";

/* ------------------------------------------------------------------ */
/*  Types for the /api/parse-intent response                          */
/* ------------------------------------------------------------------ */

export interface LLMLeg {
  side: string;
  asset: string;
  protocol: string;
  sizeUsd?: number;
  leverage?: number;
  note?: string;
}

export interface LLMStrategy {
  name: string;
  risk: "conservative" | "moderate" | "aggressive";
  variantNote: string;
  summary: string;
  legs: LLMLeg[];
}

export interface ParseIntentResponse {
  understanding: string;
  strategies: LLMStrategy[];
}

/* ------------------------------------------------------------------ */
/*  Mapping helpers                                                    */
/* ------------------------------------------------------------------ */

/** Infer a TradeIntent from the dominant action in a set of legs. */
function inferIntent(legs: TradeLeg[]): TradeIntent {
  if (legs.length === 0) return "unknown";
  const sides = new Set(legs.map((l) => l.side.toLowerCase()));

  // Beta-neutral: both long AND short in the same plan
  if (sides.has("long") && sides.has("short")) return "betaNeutral";
  if (sides.has("long") || sides.has("short")) return "directional";
  if (sides.has("stake") || sides.has("restake")) return "stake";
  if (sides.has("swap") || sides.has("buy")) return "swap";
  if (sides.has("supply")) return "supply";
  if (sides.has("borrow")) return "borrow";
  if (sides.has("repay")) return "repay";
  if (sides.has("withdraw")) return "withdraw";
  if (sides.has("bridge")) return "bridge";
  if (sides.has("transfer")) return "transfer";
  return "supply";
}

/** Map TradeIntent → ThreadType for backward-compat with the UI category system. */
function intentToThreadType(intent: TradeIntent): ThreadType {
  switch (intent) {
    case "lockYield":
      return "pendle";
    case "betaNeutral":
      return "betaneutral";
    case "directional":
      return "perp";
    case "swap":
      return "swap";
    case "hedge":
      return "hedge";
    case "supply":
    case "borrow":
      return "swap";
    case "repay":
    case "withdraw":
      return "hedge";
    case "stake":
    case "restake":
      return "pendle";
    default:
      return "custom";
  }
}

/** Extract the primary asset from legs (strip PERP suffix, take post-arrow for swaps). */
function primaryAsset(legs: TradeLeg[]): string {
  const first = legs[0]?.asset ?? "ETH";
  return first
    .replace(/\s*PERP$/i, "")
    .replace(/^.*→\s*/, "")
    .trim();
}

/** Convert an LLM strategy into a TradePlan compatible with ThreadCard. */
function strategyToTradePlan(strategy: LLMStrategy): TradePlan & { riskTier: LLMStrategy["risk"] } {
  const legs: TradeLeg[] = strategy.legs.map((l) => ({
    side: l.side,
    asset: l.asset,
    protocol: l.protocol,
    sizeUsd: l.sizeUsd,
    leverage: l.leverage,
    note: l.note,
  }));

  const intent = inferIntent(legs);
  const asset = primaryAsset(legs);
  const hasShort = legs.some((l) => l.side.toLowerCase() === "short");
  const hasLong = legs.some((l) => l.side.toLowerCase() === "long");

  return {
    intent,
    asset,
    direction: hasShort && !hasLong ? "short" : hasLong ? "long" : undefined,
    sizeUsd: legs.reduce((sum, l) => sum + (l.sizeUsd ?? 0), 0) || undefined,
    leverage: legs.find((l) => l.leverage)?.leverage,
    protocol: legs[0]?.protocol,
    legs,
    summary: strategy.summary,
    variantLabel: strategy.name,
    variantNote: strategy.variantNote,
    riskTier: strategy.risk,
  };
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Async thesis routing via Claude. Produces 3 risk-tiered strategy variants.
 * Falls back to the sync regex parser on any error (network, API key missing,
 * malformed response, etc.) — the app never breaks.
 */
export async function routeThesisAsync(rawText: string): Promise<ThreadItem> {
  const text = (rawText ?? "").trim();
  if (!text) return routeThesis(text);

  try {
    const res = await fetch("/api/parse-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thesis: text }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error((errBody as { error?: string }).error ?? `API error ${res.status}`);
    }

    const data: ParseIntentResponse = await res.json();

    if (!data.strategies || data.strategies.length === 0) {
      throw new Error("No strategies returned");
    }

    const variants = data.strategies.map(strategyToTradePlan);

    // Default to moderate strategy, fall back to middle, then first
    const defaultPlan =
      variants.find((v) => v.variantLabel && /moderate/i.test(v.variantLabel)) ??
      (variants.length >= 2 ? variants[1] : variants[0]);

    const threadType = intentToThreadType(defaultPlan.intent);

    return {
      type: threadType,
      text,
      plan: defaultPlan,
      variants: variants.length > 1 ? variants : undefined,
    };
  } catch (err) {
    console.warn("[intentEngine] LLM parsing failed, falling back to regex parser:", err);
    return routeThesis(text);
  }
}
