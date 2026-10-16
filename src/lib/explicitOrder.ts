/**
 * explicitOrder.ts — when the user types an order ("short ETH levier 2, SL
 * 20% on Hyperliquid"), the first strategy is that order, whatever the LLM
 * proposed. The planner is told so; this is the deterministic guarantee: a
 * small capital or a better yield elsewhere is never a reason to replace
 * what the user asked for.
 */

import { deployableUsd, hyperliquidMarginOnlyUsd, type BudgetAsset } from "@/lib/budgetFit";
import type { LLMLeg, LLMStrategy } from "@/lib/strategyIntegrity";
import { marketBase } from "@/lib/perpVenues";
import { SIZING_POLICY } from "@/lib/planner/policy";

export interface ExplicitPerpOrder {
  side: "Long" | "Short";
  /** Market as the perp layer resolves it ("ETH", "TSLA", "SP500"…). */
  asset: string;
  leverage?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  /** Position size in USD when the user gave one. */
  sizeUsd?: number;
  /** The venue the user named; Hyperliquid when none. */
  venue?: "Hyperliquid" | "Extended";
}

/** Names people write for markets → the perp ticker (HIP-3 stocks and commodities resolve by ticker). */
const NAMED: Record<string, string> = {
  ether: "ETH", ethereum: "ETH", bitcoin: "BTC", solana: "SOL", hype: "HYPE",
  tesla: "TSLA", nvidia: "NVDA", apple: "AAPL", microsoft: "MSFT", google: "GOOGL", alphabet: "GOOGL",
  amazon: "AMZN", meta: "META", amd: "AMD", intel: "INTC", coinbase: "COIN", microstrategy: "MSTR",
  gold: "GOLD", silver: "SILVER", argent: "SILVER", oil: "CL", petrole: "CL", "pétrole": "CL", brent: "BRENTOIL",
  "s&p": "SP500", "s&p500": "SP500", sp500: "SP500", spx: "SP500", nasdaq: "XYZ100",
};

/** Words that follow "short"/"long" without naming a market ("short term", "long position"). */
const NOT_A_MARKET = new Set(["TERM", "POSITION", "POSITIONS", "SUR", "ON", "THE", "A", "UN", "UNE", "MY", "MES", "MA", "MON", "DE", "DU", "LE", "LA", "AND", "ET", "WITH", "AVEC", "AT", "X", "LEVIER", "LEVERAGE"]);

const num = (s: string | undefined) => (s ? Number(s.replace(",", ".")) : undefined);

export function parseExplicitPerpOrder(thesis: string): ExplicitPerpOrder | null {
  const text = thesis.trim();
  const m = text.match(/\b(short|long|shorter|longer|vendre à découvert)\s+(?:(?:du|de|le|la|l'|on|sur|un|une)\s+)?([a-zA-Z&]{2,12}\d{0,3}(?::[A-Za-z0-9]+)?)\b/i);
  if (!m) return null;
  const side = /^short/i.test(m[1]) || /découvert/i.test(m[1]) ? "Short" : "Long";
  const word = m[2];
  const asset = NAMED[word.toLowerCase()] ?? word.toUpperCase();
  if (NOT_A_MARKET.has(asset) || /^(USDC|USDT|DAI|USD)$/.test(asset)) return null;

  const lev = text.match(/(?:levier|leverage|lev)\s*(?:de|of|x|à|:)?\s*x?\s*(\d+(?:[.,]\d+)?)/i) ?? text.match(/\b(\d+(?:[.,]\d+)?)\s*x\b/i) ?? text.match(/\bx\s*(\d+(?:[.,]\d+)?)\b/i);
  const sl = text.match(/(?:\bsl\b|stop[\s-]?loss|stop)\s*(?:à|at|of|de|:)?\s*(-?\d+(?:[.,]\d+)?)\s*%/i) ?? text.match(/(\d+(?:[.,]\d+)?)\s*%\s*(?:de\s+)?(?:\bsl\b|stop)/i);
  const tp = text.match(/(?:\btp\b|take[\s-]?profit)\s*(?:à|at|of|de|:)?\s*(\d+(?:[.,]\d+)?)\s*%/i) ?? text.match(/(\d+(?:[.,]\d+)?)\s*%\s*(?:de\s+)?(?:\btp\b|take)/i);
  const size = text.match(/\$\s?(\d[\d,.]*)|(\d[\d.]*)\s?(?:\$|usd\b|usdc\b|dollars?)/i);

  const leverage = num(lev?.[1]);
  const stopLossPct = sl ? Math.abs(num(sl[1]) ?? 0) : undefined;
  const takeProfitPct = num(tp?.[1]);
  const sizeUsd = size ? Number((size[1] ?? size[2]).replace(/,/g, "")) : undefined;
  const venue = /\b(extended|x10)\b/i.test(text) ? ("Extended" as const) : /\b(hyperliquid|hl)\b/i.test(text) ? ("Hyperliquid" as const) : undefined;
  return {
    venue,
    side,
    asset,
    leverage: leverage && leverage > 0 ? leverage : undefined,
    stopLossPct: stopLossPct && stopLossPct > 0 && stopLossPct < 100 ? stopLossPct : undefined,
    takeProfitPct: takeProfitPct && takeProfitPct > 0 ? takeProfitPct : undefined,
    sizeUsd: sizeUsd && sizeUsd > 0 ? sizeUsd : undefined,
  };
}

/** Hyperliquid refuses orders under $10 of notional: aim a little above. */
const MIN_NOTIONAL_USD = 11;

/** The order as Meridian executes it: margin deposited on Hyperliquid when needed, then the position. */
export function strategyForOrder(order: ExplicitPerpOrder, assets?: BudgetAsset[], extendedFreeUsd?: number): LLMStrategy {
  if (order.venue === "Extended") return extendedOrder(order, extendedFreeUsd);
  const lev = order.leverage ?? 1;
  const capital = deployableUsd(assets) + hyperliquidMarginOnlyUsd(assets);
  // Without a size: most of what the user can put up as margin (the budget fit trims it to the wallet).
  const notional = Math.max(MIN_NOTIONAL_USD, Math.floor(order.sizeUsd ?? (capital > 0 ? capital * SIZING_POLICY.maxUtilization * lev : 100)));
  // Margin for the notional plus the 2% the order keeps for fees and slippage (and a little rounding).
  const margin = Math.ceil((notional * 1.03) / lev);
  const protection = [order.stopLossPct ? `stop-loss ${order.stopLossPct}%` : "", order.takeProfitPct ? `take-profit ${order.takeProfitPct}%` : ""].filter(Boolean).join(", ");
  const perp: LLMLeg = {
    side: order.side,
    asset: `${order.asset} PERP`,
    protocol: "Hyperliquid",
    chain: "Arbitrum",
    sizeUsd: notional,
    leverage: lev,
    stopLossPct: order.stopLossPct,
    takeProfitPct: order.takeProfitPct,
    note: `${order.side} ${order.asset} at ${lev}x${protection ? `, ${protection}` : ""}, as you asked.`,
  };
  return {
    name: `${order.side} ${order.asset} ${lev}x`,
    risk: "aggressive",
    summary: `Your order: ${order.side.toLowerCase()} ${order.asset} on Hyperliquid, ${lev}x${protection ? `, ${protection}` : ""}.`,
    variantNote: `Directional ${order.side.toLowerCase()}: a ${(100 / lev).toFixed(0)}% move against you approaches liquidation; funding is paid or earned every hour.`,
    legs: [{ side: "Deposit", asset: "USDC", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: Math.max(5, margin), note: "Margin for the position (skipped when your Hyperliquid account already holds it)." }, perp],
  };
}

/**
 * The order on Extended: no deposit leg (Meridian can't deposit there), sized
 * from the Extended account's free margin when the user gave no size. With no
 * margin there, it says so rather than moving the order to another venue.
 */
function extendedOrder(order: ExplicitPerpOrder, freeUsd = 0): LLMStrategy {
  const lev = order.leverage ?? 1;
  const notional = Math.max(MIN_NOTIONAL_USD, Math.floor(order.sizeUsd ?? (freeUsd > 0 ? freeUsd * SIZING_POLICY.maxUtilization * lev : 20)));
  const protection = [order.stopLossPct ? `stop-loss ${order.stopLossPct}%` : "", order.takeProfitPct ? `take-profit ${order.takeProfitPct}%` : ""].filter(Boolean).join(", ");
  const needs = Math.ceil((notional * 1.03) / lev);
  return {
    name: `${order.side} ${order.asset} ${lev}x (Extended)`,
    risk: "aggressive",
    summary: `Your order: ${order.side.toLowerCase()} ${order.asset} on Extended, ${lev}x${protection ? `, ${protection}` : ""}.`,
    variantNote: `Directional ${order.side.toLowerCase()}: a ${(100 / lev).toFixed(0)}% move against you approaches liquidation; funding is paid or earned every hour.`,
    fundingNotes:
      freeUsd >= needs
        ? undefined
        : [`Your Extended account has $${Math.floor(freeUsd)} free; this order needs ~$${needs} of margin there. Deposit USDC on extended.exchange with this wallet, then sign.`],
    legs: [
      {
        side: order.side,
        asset: `${order.asset} PERP`,
        protocol: "Extended",
        chain: "Arbitrum",
        sizeUsd: notional,
        leverage: lev,
        stopLossPct: order.stopLossPct,
        takeProfitPct: order.takeProfitPct,
        note: `${order.side} ${order.asset} on Extended at ${lev}x${protection ? `, ${protection}` : ""}, as you asked.`,
      },
    ],
  };
}

/**
 * Put the user's order first: a strategy that already places it (same side,
 * same market) gets the asked leverage / stop-loss / take-profit and moves to
 * the top; otherwise the order itself becomes strategy 1 and the LLM's
 * proposals follow as alternatives.
 */
export function enforceExplicitOrder(
  strategies: LLMStrategy[],
  order: ExplicitPerpOrder | null,
  assets?: BudgetAsset[],
  extendedFreeUsd?: number,
): LLMStrategy[] {
  if (!order) return strategies;
  const venueOk = (l: LLMLeg) => (order.venue === "Extended" ? /extended/i.test(l.protocol) : !/extended/i.test(l.protocol));
  const matches = (l: LLMLeg) => l.side.trim().toLowerCase() === order.side.toLowerCase() && marketBase(l.asset) === marketBase(order.asset) && venueOk(l);
  const i = strategies.findIndex((s) => Array.isArray(s.legs) && s.legs.some(matches));
  if (i < 0) return [strategyForOrder(order, assets, extendedFreeUsd), ...strategies].slice(0, 3);
  const fixed: LLMStrategy = {
    ...strategies[i],
    legs: strategies[i].legs.map((l) =>
      matches(l)
        ? {
            ...l,
            leverage: order.leverage ?? l.leverage,
            stopLossPct: order.stopLossPct ?? l.stopLossPct,
            takeProfitPct: order.takeProfitPct ?? l.takeProfitPct,
            sizeUsd: order.sizeUsd ?? l.sizeUsd,
          }
        : l,
    ),
  };
  return [fixed, ...strategies.filter((_, k) => k !== i)];
}
