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
import { EXTENDED_MIN_DEPOSIT_USD } from "@/lib/integrations/extendedBridge";

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
  /**
   * How the stop-loss was given. Meridian's convention is a price move from
   * the entry; "SL 20% of margin" is converted to 20% / leverage of price and
   * this keeps what the user typed.
   */
  stopLossAsTyped?: { pct: number; basis: "price" | "margin" };
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
const NOT_A_MARKET = new Set([
  "TERM", "POSITION", "POSITIONS", "SUR", "ON", "THE", "A", "UN", "UNE", "MY", "MES", "MA", "MON", "DE", "DU", "LE", "LA", "AND", "ET", "WITH", "AVEC", "AT", "X", "LEVIER", "LEVERAGE",
  // Venues are where an order goes, never what it trades ("long on Hyperliquid").
  "HYPERLIQUID", "HL", "EXTENDED", "X10", "SIDE", "LEG", "JAMBE",
]);

const num = (s: string | undefined) => (s ? Number(s.replace(",", ".")) : undefined);

export function parseExplicitPerpOrder(thesis: string): ExplicitPerpOrder | null {
  const text = thesis.trim();
  // A long and a short in one request is a two-leg position (lib/planner/pair.ts), not one order.
  if (/\blong\b/i.test(text) && /\bshort\b/i.test(text)) return null;
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
  const slTyped = sl ? Math.abs(num(sl[1]) ?? 0) : undefined;
  // "SL 20% de la marge" / "of margin" / "de perte": a loss on margin, not a price move (policy STOP_LOSS_CONVENTION).
  const marginBasis = !!sl && /(de la marge|sur la marge|of (?:the |my )?margin|de perte|loss of)/i.test(text.slice(sl.index ?? 0, (sl.index ?? 0) + sl[0].length + 25));
  const levForConversion = leverage && leverage > 0 ? leverage : SIZING_POLICY.defaultLeverage.directional;
  const stopLossPct = slTyped === undefined ? undefined : marginBasis ? Math.round((slTyped / levForConversion) * 100) / 100 : slTyped;
  const takeProfitPct = num(tp?.[1]);
  const sizeUsd = size ? Number((size[1] ?? size[2]).replace(/,/g, "")) : undefined;
  const venue = /\b(extended|x10)\b/i.test(text) ? ("Extended" as const) : /\b(hyperliquid|hl)\b/i.test(text) ? ("Hyperliquid" as const) : undefined;
  return {
    venue,
    side,
    asset,
    leverage: leverage && leverage > 0 ? leverage : undefined,
    stopLossPct: stopLossPct && stopLossPct > 0 && stopLossPct < 100 ? stopLossPct : undefined,
    stopLossAsTyped: slTyped && slTyped > 0 ? { pct: slTyped, basis: marginBasis ? "margin" : "price" } : undefined,
    takeProfitPct: takeProfitPct && takeProfitPct > 0 ? takeProfitPct : undefined,
    sizeUsd: sizeUsd && sizeUsd > 0 ? sizeUsd : undefined,
  };
}

/** The stop-loss / take-profit in Meridian's convention (price move from entry), saying how a margin-based stop was converted. */
function protectionText(order: ExplicitPerpOrder, lev: number): string {
  const sl = order.stopLossPct
    ? order.stopLossAsTyped?.basis === "margin"
      ? `stop-loss at a ${order.stopLossPct}% price move (your ${order.stopLossAsTyped.pct}% of margin ÷ ${lev}x)`
      : `stop-loss at a ${order.stopLossPct}% price move from entry`
    : "";
  const tp = order.takeProfitPct ? `take-profit at a ${order.takeProfitPct}% price move` : "";
  return [sl, tp].filter(Boolean).join(", ");
}

/** Hyperliquid refuses orders under $10 of notional: aim a little above. */
const MIN_NOTIONAL_USD = 11;

/** The order as Meridian executes it: margin deposited on Hyperliquid when needed, then the position. */
export function strategyForOrder(order: ExplicitPerpOrder, assets?: BudgetAsset[], extendedFreeUsd?: number): LLMStrategy {
  if (order.venue === "Extended") return extendedOrder(order, extendedFreeUsd, arbitrumUsdcUsd(assets));
  const lev = order.leverage ?? SIZING_POLICY.defaultLeverage.directional;
  const capital = deployableUsd(assets) + hyperliquidMarginOnlyUsd(assets);
  // Without a size: most of what the user can put up as margin (the budget fit trims it to the wallet).
  const notional = Math.max(MIN_NOTIONAL_USD, Math.floor(order.sizeUsd ?? (capital > 0 ? capital * SIZING_POLICY.maxUtilization * lev : 100)));
  // Margin for the notional plus the 2% the order keeps for fees and slippage (and a little rounding).
  const margin = Math.ceil((notional * 1.03) / lev);
  const protection = protectionText(order, lev);
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

/** Native USDC in the wallet on Arbitrum: what a deposit to Extended can spend (Rhino.fi bridge). */
export function arbitrumUsdcUsd(assets: BudgetAsset[] | undefined): number {
  return (assets ?? []).filter((a) => /^wallet$/i.test(a.venue) && /arbitrum/i.test(a.chain) && a.symbol.toUpperCase() === "USDC").reduce((t, a) => t + a.usd, 0);
}

/**
 * The order on Extended, sized from the Extended account's free margin (plus
 * Arbitrum USDC the wallet can deposit) when the user gave no size. When the
 * account lacks margin and the wallet holds enough USDC on Arbitrum, a
 * deposit step (Rhino.fi bridge) comes first; otherwise the plan says what's
 * missing rather than moving the order to another venue.
 */
function extendedOrder(order: ExplicitPerpOrder, freeUsd: number | undefined, arbUsdc: number): LLMStrategy {
  const lev = order.leverage ?? SIZING_POLICY.defaultLeverage.directional;
  const reserve = SIZING_POLICY.feeReserveUsd;
  // A deposit is only possible from a known (connected) account; its bridge fee is covered by the reserve.
  const depositable = freeUsd !== undefined && arbUsdc >= EXTENDED_MIN_DEPOSIT_USD + reserve ? arbUsdc - reserve : 0;
  // No size given and nothing known to size from: the size stays unknown (the plan is blocked), never invented.
  const sizingFrom = freeUsd === undefined ? 0 : Math.max(0, freeUsd - reserve) + depositable;
  const notional =
    order.sizeUsd !== undefined
      ? Math.max(MIN_NOTIONAL_USD, Math.floor(order.sizeUsd))
      : sizingFrom > 0
        ? Math.max(MIN_NOTIONAL_USD, Math.floor(sizingFrom * SIZING_POLICY.maxUtilization * lev))
        : undefined;
  const protection = protectionText(order, lev);
  const needs = notional === undefined ? undefined : Math.ceil((notional * (1 + SIZING_POLICY.marginBufferPct / 100)) / lev);
  const shortfall = needs !== undefined && freeUsd !== undefined ? needs - freeUsd : 0;
  const deposit = shortfall > 0 && depositable >= shortfall ? Math.min(depositable, Math.max(EXTENDED_MIN_DEPOSIT_USD, Math.ceil(shortfall + reserve))) : 0;
  const covered = needs !== undefined && freeUsd !== undefined && freeUsd + deposit >= needs;
  const perp: LLMLeg = {
    side: order.side,
    asset: `${order.asset} PERP`,
    protocol: "Extended",
    chain: "Arbitrum",
    sizeUsd: notional,
    leverage: lev,
    stopLossPct: order.stopLossPct,
    takeProfitPct: order.takeProfitPct,
    note: `${order.side} ${order.asset} on Extended at ${lev}x${protection ? `, ${protection}` : ""}, as you asked.`,
  };
  return {
    name: `${order.side} ${order.asset} ${lev}x (Extended)`,
    risk: "aggressive",
    summary: `Your order: ${order.side.toLowerCase()} ${order.asset} on Extended, ${lev}x${protection ? `, ${protection}` : ""}.`,
    variantNote: `Directional ${order.side.toLowerCase()}: a ${(100 / lev).toFixed(0)}% move against you approaches liquidation; funding is paid or earned every hour.`,
    fundingNotes: covered
      ? undefined
      : [
          freeUsd === undefined
            ? "Your Extended balance is unknown right now, so the size isn't set: connect or reload Extended, or give a size."
            : needs === undefined
              ? `Your Extended account has $${Math.floor(freeUsd)} free and the wallet has no USDC on Arbitrum to deposit: add USDC on Arbitrum, or give a size.`
              : `Your Extended account has $${Math.floor(freeUsd)} free; this order needs ~$${needs} of margin there and the wallet holds $${Math.floor(arbUsdc)} USDC on Arbitrum to deposit.`,
        ],
    legs: deposit > 0
      ? [{ side: "Deposit", asset: "USDC", protocol: "Extended", chain: "Arbitrum", sizeUsd: deposit, note: "Margin for the order: USDC from Arbitrum to your Extended account (Rhino.fi bridge, a few minutes)." }, perp]
      : [perp],
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
