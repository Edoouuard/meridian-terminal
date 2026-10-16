/**
 * perpPositions.ts — one shape for every open perp position, whatever the
 * venue, so the Risk tab can show PnL, funding and liquidation distance at a
 * glance (components/PerpPositionsPanel.tsx).
 */

import type { HlAccount, HlOpenOrder } from "@/lib/integrations/hyperliquid-live";
import type { ExtendedPositionView } from "@/lib/integrations/extended-live";

export type PerpVenue = "Hyperliquid" | "Hyperliquid stocks" | "Extended";

export interface PerpPositionRow {
  key: string;
  venue: PerpVenue;
  /** Display name: "ETH", "TSLA". */
  symbol: string;
  side: "long" | "short";
  /** Base quantity, positive. */
  size: number;
  /** Notional at mark, USD. */
  notional: number;
  entry: number;
  mark: number;
  /** 0 when the venue reports none. */
  liq: number;
  leverage: number;
  unrealizedPnl: number;
  /** Margin backing the position, USD. */
  margin: number;
  /** Funding received (+) or paid (−) since open; null when the venue doesn't report it. */
  funding: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
}

/** "xyz:TSLA" → "TSLA". */
function displayCoin(coin: string): string {
  return coin.includes(":") ? coin.split(":")[1] : coin;
}

/** SL / TP of a position from its trigger orders on Hyperliquid ("Stop Market", "Take Profit Market"…). */
function hlProtection(coin: string, orders: HlOpenOrder[]): { stopLoss: number | null; takeProfit: number | null } {
  let stopLoss: number | null = null;
  let takeProfit: number | null = null;
  for (const o of orders) {
    if (o.coin !== coin || !o.triggerPx) continue;
    const kind = o.orderType.toLowerCase();
    if (kind.startsWith("stop")) stopLoss = o.triggerPx;
    else if (kind.startsWith("take profit")) takeProfit = o.triggerPx;
  }
  return { stopLoss, takeProfit };
}

export function rowsFromHyperliquid(account: HlAccount | null | undefined, orders: HlOpenOrder[], venue: PerpVenue): PerpPositionRow[] {
  return (account?.positions ?? []).map((p) => {
    const side = p.size < 0 ? ("short" as const) : ("long" as const);
    const size = Math.abs(p.size);
    const notional = Math.abs(p.notional);
    const leverage = p.leverage || 1;
    return {
      key: `${venue}:${p.coin}`,
      venue,
      symbol: displayCoin(p.coin),
      side,
      size,
      notional,
      entry: p.entryPx,
      mark: size > 0 ? notional / size : 0,
      liq: p.liquidationPx,
      leverage,
      unrealizedPnl: p.unrealizedPnl,
      margin: p.marginUsed && p.marginUsed > 0 ? p.marginUsed : notional / leverage,
      funding: p.fundingSinceOpen ?? null,
      ...hlProtection(p.coin, orders),
    };
  });
}

export function rowsFromExtended(positions: ExtendedPositionView[] | null | undefined): PerpPositionRow[] {
  return (positions ?? []).map((p) => ({
    key: `Extended:${p.market}`,
    venue: "Extended" as const,
    symbol: p.symbol,
    side: p.side,
    size: p.size,
    notional: p.value,
    entry: p.entry,
    mark: p.mark,
    liq: p.liq,
    leverage: p.leverage,
    unrealizedPnl: p.unrealisedPnl,
    margin: p.value / (p.leverage || 1),
    funding: p.funding,
    stopLoss: p.sl,
    takeProfit: p.tp,
  }));
}

/** How far the mark can move against the position before liquidation, in % of the mark. Null when unknown. */
export function liqDistancePct(row: Pick<PerpPositionRow, "side" | "mark" | "liq">): number | null {
  if (!(row.liq > 0) || !(row.mark > 0)) return null;
  const d = row.side === "long" ? (row.mark - row.liq) / row.mark : (row.liq - row.mark) / row.mark;
  return d * 100;
}

/** PnL as a % of the margin backing the position (what the venue calls ROE). */
export function roePct(row: Pick<PerpPositionRow, "unrealizedPnl" | "margin">): number | null {
  return row.margin > 0 ? (row.unrealizedPnl / row.margin) * 100 : null;
}

export interface PerpSummary {
  count: number;
  unrealizedPnl: number;
  /** Sum of the funding the venues report; positions without a figure are left out. */
  funding: number;
  fundingKnown: boolean;
  margin: number;
  notional: number;
  /** Smallest liquidation distance among the positions, %. */
  closestLiqPct: number | null;
}

export function summarize(rows: PerpPositionRow[]): PerpSummary {
  let closest: number | null = null;
  for (const r of rows) {
    const d = liqDistancePct(r);
    if (d !== null && (closest === null || d < closest)) closest = d;
  }
  const withFunding = rows.filter((r) => r.funding !== null);
  return {
    count: rows.length,
    unrealizedPnl: rows.reduce((a, r) => a + r.unrealizedPnl, 0),
    funding: withFunding.reduce((a, r) => a + (r.funding ?? 0), 0),
    fundingKnown: withFunding.length > 0,
    margin: rows.reduce((a, r) => a + r.margin, 0),
    notional: rows.reduce((a, r) => a + r.notional, 0),
    closestLiqPct: closest,
  };
}
