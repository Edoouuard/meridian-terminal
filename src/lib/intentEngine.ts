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
import { parseAmount } from "@/lib/tradePlan";
import { deployableUsd } from "@/lib/budgetFit";
import { SIZING_POLICY } from "@/lib/planner/policy";
import { cleanClarify, type PlannerClarify } from "@/lib/planner/clarify";

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
  /** Chain the leg executes on ("Base", "Arbitrum", …). */
  chain?: string;
  /** Destination chain of a Bridge leg. */
  toChain?: string;
  /** Token a Bridge leg spends when it differs from the one it delivers. */
  fromAsset?: string;
  /** Recipient of a Transfer leg (0x… or .eth). */
  to?: string;
  /** Exact token quantity the user gave ("0.5"). */
  sizeToken?: string;
  /** Perp legs: stop-loss / take-profit in % of price from the entry. */
  stopLossPct?: number;
  takeProfitPct?: number;
}

export interface LLMStrategy {
  name: string;
  risk: "conservative" | "moderate" | "aggressive";
  variantNote: string;
  summary: string;
  legs: LLMLeg[];
  /** Blended expected APY (percent) from the live data. */
  apy?: number;
  /** How to exit ("Instant", "Locked until …"). */
  exit?: string;
  /** Who this suits, one line. */
  fit?: string;
  /** Main risks, short items. */
  risks?: string[];
  /** What the server changed to fit the wallet (resized to the free balance…). */
  fundingNotes?: string[];
  kind?: TradePlan["kind"];
  changes?: string[];
  status?: TradePlan["status"];
  blockers?: string[];
  economics?: TradePlan["economics"];
  figures?: TradePlan["figures"];
  pair?: TradePlan["pair"];
  execution?: TradePlan["execution"];
}

export interface ParseIntentResponse {
  understanding: string;
  strategies: LLMStrategy[];
  /** One question the planner asks before planning (STRATEGIST.md section 3). */
  clarify?: PlannerClarify;
  /** Index of the strategy the planner recommends for this user. */
  recommended?: number;
}

const cleanList = (v: unknown): string[] | undefined => {
  const out = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().slice(0, 200)).slice(0, 6) : [];
  return out.length ? out : undefined;
};

const cleanText = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

/* ------------------------------------------------------------------ */
/*  Mapping helpers                                                    */
/* ------------------------------------------------------------------ */

/** Infer a TradeIntent from the dominant action in a set of legs. */
function inferIntent(legs: TradeLeg[]): TradeIntent {
  if (legs.length === 0) return "unknown";
  const sides = new Set(legs.map((l) => l.side.toLowerCase()));

  // Beta-neutral / delta-neutral: ANY long-side exposure (long perp, spot buy,
  // supply, stake) paired with a short perp makes the strategy neutral — not
  // just "Long" + "Short". A basis trade (Buy ETH spot + Short ETH PERP) or a
  // hedged yield play (Supply ETH on Aave + Short ETH PERP) are both neutral.
  const hasLongExposure = sides.has("long") || sides.has("buy") || sides.has("supply") || sides.has("stake") || sides.has("swap");
  const hasShort = sides.has("short");
  if (hasLongExposure && hasShort) return "betaNeutral";
  if (sides.has("long") || hasShort) return "directional";
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

/** A model number that may come back as a string ("5000"): a positive finite number, else undefined. */
function positiveNumber(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Convert an LLM strategy into a TradePlan compatible with ThreadCard. */
function strategyToTradePlan(strategy: LLMStrategy): TradePlan & { riskTier: LLMStrategy["risk"] } {
  const legs: TradeLeg[] = strategy.legs.map((l) => ({
    side: l.side,
    asset: l.asset,
    protocol: l.protocol,
    sizeUsd: positiveNumber(l.sizeUsd),
    leverage: positiveNumber(l.leverage),
    note: l.note,
    chain: typeof l.chain === "string" && l.chain.trim() ? l.chain.trim() : undefined,
    toChain: typeof l.toChain === "string" && l.toChain.trim() ? l.toChain.trim() : undefined,
    fromAsset: typeof l.fromAsset === "string" && l.fromAsset.trim() ? l.fromAsset.trim() : undefined,
    to: typeof l.to === "string" && /^(0x[0-9a-fA-F]{40}|[\w-]+(\.[\w-]+)*\.eth)$/.test(l.to.trim()) ? l.to.trim() : undefined,
    sizeToken: typeof l.sizeToken === "string" && /^\d+(\.\d+)?$/.test(l.sizeToken.trim()) ? l.sizeToken.trim() : undefined,
    stopLossPct: positiveNumber(l.stopLossPct),
    takeProfitPct: positiveNumber(l.takeProfitPct),
  }));

  const intent = inferIntent(legs);
  const asset = primaryAsset(legs);
  const hasShort = legs.some((l) => l.side.toLowerCase() === "short");
  const hasLong = legs.some((l) => l.side.toLowerCase() === "long");

  return {
    intent,
    asset,
    direction: hasShort && !hasLong ? "short" : hasLong ? "long" : undefined,
    sizeUsd: positionSizeUsd(legs),
    leverage: legs.find((l) => l.leverage)?.leverage,
    protocol: legs[0]?.protocol,
    legs,
    summary: strategy.summary,
    variantLabel: strategy.name,
    variantNote: strategy.variantNote,
    riskTier: strategy.risk,
    apyPct: typeof strategy.apy === "number" && Number.isFinite(strategy.apy) && strategy.apy > -100 && strategy.apy < 1000 ? strategy.apy : undefined,
    exit: cleanText(strategy.exit, 80),
    fit: cleanText(strategy.fit, 160),
    risks: Array.isArray(strategy.risks)
      ? strategy.risks.map((r) => cleanText(r, 120)).filter((r): r is string => !!r).slice(0, 4)
      : undefined,
    fundingNotes: strategy.fundingNotes?.length ? strategy.fundingNotes.slice(0, 4) : undefined,
    kind: strategy.kind === "alternative" || strategy.kind === "requested" ? strategy.kind : undefined,
    changes: cleanList(strategy.changes),
    status: strategy.status === "blocked" || strategy.status === "executable" ? strategy.status : undefined,
    blockers: cleanList(strategy.blockers),
    economics: strategy.economics && typeof strategy.economics.holdingDays === "number" ? strategy.economics : undefined,
    figures: Array.isArray(strategy.figures)
      ? strategy.figures.filter((f) => f && typeof f.label === "string" && typeof f.value === "string" && ["observed", "calculated", "assumption"].includes(f.kind)).slice(0, 10)
      : undefined,
    pair: strategy.pair,
    execution: strategy.execution,
  };
}

/**
 * Capital the strategy deploys. A Bridge or Swap leg moves the same money a
 * later leg deposits, so summing every leg double-counts it: count the legs
 * that end in a position, and fall back to the largest leg when none does.
 */
export function positionSizeUsd(legs: TradeLeg[]): number | undefined {
  const moves = new Set(["bridge", "swap", "transfer"]);
  const positions = legs.filter((l) => !moves.has(l.side.toLowerCase()));
  const total = positions.reduce((sum, l) => sum + (l.sizeUsd ?? 0), 0);
  if (total > 0) return total;
  const largest = Math.max(0, ...legs.map((l) => l.sizeUsd ?? 0));
  return largest > 0 ? largest : undefined;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/** Serializable portfolio snapshot for the LLM strategy engine. */
export interface PortfolioContext {
  /** Total net portfolio value in USD. */
  netUsd: number;
  /** Free (idle) wallet balance in USD — tokens sitting in the wallet, not deployed in any protocol. */
  freeBalanceUsd: number;
  /** Wallet token holdings. */
  assets: { symbol: string; venue: string; chain: string; balance: number; usd: number }[];
  /** Lending/borrowing positions (Aave, Compound, Morpho, Spark). */
  lendingPositions: { protocol: string; chain: string; collateralUsd: number; debtUsd: number; healthFactor: number | null }[];
  /** Open Hyperliquid perp positions. */
  perps: { coin: string; size: number; notional: number; unrealizedPnl: number }[];
  /** Net ETH delta across all venues (spot + perps). */
  netDeltaEthTotal: number | null;
  /** The user's Hyperliquid account: collateral, margin in use, free margin (null when not read). */
  hyperliquid?: { unified: boolean; collateralUsd: number; marginUsedUsd: number; freeMarginUsd: number; spotUsdcUsd: number } | null;
  /** The user's Extended account: connected or not, and its USDC when it is. */
  extended?: { connected: boolean; network?: string; equityUsd?: number; availableUsd?: number };
}

/**
 * Async thesis routing via Claude. Produces 3 risk-tiered strategy variants.
 * Falls back to the sync regex parser on any error (network, API key missing,
 * malformed response, etc.) — the app never breaks.
 */
export async function routeThesisAsync(rawText: string, portfolio?: PortfolioContext, opts: { clarified?: boolean; answeredQuestion?: string } = {}): Promise<ThreadItem> {
  const text = (rawText ?? "").trim();
  if (!text) return routeThesis(text);

  try {
    const res = await fetch("/api/parse-intent", {
      method: "POST",
      // Past the server budget (route maxDuration 190s): fall back to local rules.
      signal: AbortSignal.timeout(185_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thesis: text, portfolio, clarified: opts.clarified === true, answeredQuestion: opts.answeredQuestion }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw Object.assign(new Error((errBody as { error?: string }).error ?? `API error ${res.status}`), { status: res.status });
    }

    const data: ParseIntentResponse = await res.json();

    // The planner needs one answer first: show its question, not a fallback plan.
    const clarify = cleanClarify(data.clarify);
    if (clarify && (!data.strategies || data.strategies.length === 0)) {
      return { type: "custom", text, understanding: cleanText(data.understanding, 240), clarify };
    }

    if (!data.strategies || data.strategies.length === 0) {
      throw new Error("No strategies returned");
    }

    const variants = data.strategies.map(strategyToTradePlan);

    // Default to moderate strategy, fall back to middle, then first
    const defaultPlan =
      variants.find((v) => v.variantLabel && /moderate/i.test(v.variantLabel)) ??
      (variants.length >= 2 ? variants[1] : variants[0]);

    const threadType = intentToThreadType(defaultPlan.intent);

    const recommendedIndex =
      typeof data.recommended === "number" && Number.isInteger(data.recommended) && data.recommended >= 0 && data.recommended < variants.length
        ? data.recommended
        : undefined;
    // With no recommendation the plan shown first is the first one, never an alternative picked by risk tier.
    const shownIndex = recommendedIndex ?? (variants.some((v) => v.kind) ? 0 : undefined);

    return {
      type: threadType,
      text,
      plan: shownIndex !== undefined ? variants[shownIndex] : defaultPlan,
      variants: variants.length > 1 ? variants : undefined,
      understanding: cleanText(data.understanding, 240),
      recommendedIndex,
    };
  } catch (err) {
    console.warn("[intentEngine] LLM parsing failed, falling back to regex parser:", err);
    return { ...fitFallbackToPortfolio(routeThesis(text), text, portfolio), notice: plannerFallbackNotice(err) };
  }
}

const isPerpLeg = (l: TradeLeg) => /^(long|short)$/i.test(l.side.trim());
const venueOf = (l: TradeLeg) => (/extended/i.test(l.protocol ?? "") ? "Extended" : /hyperliquid/i.test(l.protocol ?? "") ? "Hyperliquid" : "Wallet");

/**
 * The local-rules plan uses default sizes ($20,000 for a neutral pair). When
 * the user gave no amount and the portfolio is known, size it to what they
 * hold instead: a cross-venue pair from the free margin on each venue (plus
 * half the wallet each, which a deposit can bring), anything else scaled so
 * the money it needs fits the capital, at the sizing policy's utilization.
 * Exported for tests.
 */
export function fitFallbackToPortfolio(item: ThreadItem, text: string, portfolio?: PortfolioContext): ThreadItem {
  if (!portfolio || parseAmount(text) !== undefined) return item;
  const wallet = deployableUsd(portfolio.assets);
  const hl = (portfolio.hyperliquid?.freeMarginUsd ?? 0) + wallet / 2;
  const ext = (portfolio.extended?.connected ? (portfolio.extended.availableUsd ?? 0) : 0) + wallet / 2;
  const capital = (portfolio.hyperliquid?.freeMarginUsd ?? 0) + (portfolio.extended?.connected ? (portfolio.extended.availableUsd ?? 0) : 0) + wallet;
  const util = SIZING_POLICY.maxUtilization;
  const fit = (plan: TradePlan): TradePlan => {
    const perps = plan.legs.filter(isPerpLeg);
    const venues = new Set(perps.map(venueOf));
    let legs: TradeLeg[];
    if (perps.length === 2 && venues.has("Hyperliquid") && venues.has("Extended")) {
      // Equal notional on both legs, capped by the thinner venue.
      const lev = Math.max(1, perps[0].leverage ?? 1);
      const size = Math.floor(Math.min(hl, ext) * util * lev);
      legs = plan.legs.map((l) => (isPerpLeg(l) ? { ...l, sizeUsd: size } : l));
    } else {
      const need = plan.legs.reduce((t, l) => t + (l.sizeUsd ?? 0) / (isPerpLeg(l) ? Math.max(1, l.leverage ?? 1) : 1), 0);
      const factor = need > 0 ? Math.min(1, (capital * util) / need) : 1;
      legs = plan.legs.map((l) => (l.sizeUsd ? { ...l, sizeUsd: Math.floor(l.sizeUsd * factor) } : l));
    }
    return { ...plan, legs, sizeUsd: Math.max(0, ...legs.map((l) => l.sizeUsd ?? 0)) };
  };
  return { ...item, plan: item.plan ? fit(item.plan) : item.plan, variants: item.variants?.map(fit) };
}

/**
 * Why the answer is the basic local plan instead of the AI planner's, in
 * words the user can act on. Exported for tests.
 */
export function plannerFallbackNotice(err: unknown): string {
  const status = (err as { status?: number } | null)?.status;
  const basic = "Below is a basic plan from local rules, without live rates.";
  if (status === 429) return `You're sending requests faster than the planner allows. Wait a minute, then ask again. ${basic}`;
  if (status === 401) return `Your beta session expired. Reload the page and enter the access password again. ${basic}`;
  if ((err as { name?: string } | null)?.name === "TimeoutError") return `The AI planner took too long to answer. Ask again in a moment. ${basic}`;
  if (status === undefined && err instanceof TypeError) return `You seem to be offline. Check your connection and ask again. ${basic}`;
  // The server's short reason (e.g. "No strategies in response") helps testers report what failed.
  const reason = err instanceof Error && status !== undefined && err.message && !/^API error \d+$/.test(err.message) ? ` (${err.message.slice(0, 80)})` : "";
  return `The AI planner is unavailable right now${reason}. Ask again in a moment. ${basic}`;
}
