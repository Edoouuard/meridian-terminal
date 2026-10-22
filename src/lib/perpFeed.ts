/**
 * perpFeed.ts — the perp markets of the three venues Meridian trades
 * (Hyperliquid, Extended, TxFlow), read from their public APIs on the server:
 * funding, mark, size rules, 24h volume. /api/yield-context folds them into
 * the planner's data; /api/perp-markets serves them alone to the neutral bot
 * and the opportunity scanner (lib/neutralBot). Every fetch is null-safe: a
 * venue that doesn't answer is an empty list, never zeros.
 */

import { parseExtendedMarketRows, marketBase, type ExtendedMarketRow } from "@/lib/perpVenues";
import { fetchTxflowMarketRows, type TxflowMarketRow } from "@/lib/integrations/txflow-live";
import { EXTENDED_HOSTS } from "@/lib/integrations/extendedProxy";
import { extendedQuote, hlQuote, txflowQuote, type MarketSnapshot } from "@/lib/planner/markets";

const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";
const TIMEOUT = 8000;

export interface FundingRow {
  coin: string;
  hourlyRate: number;
  annualizedPct: number;
  markUsd: number;
  szDecimals: number;
  maxLeverage: number;
  dayVolumeUsd: number;
}

/* ---------- Hyperliquid perps ---------- */

export async function fetchFundingRates(): Promise<FundingRow[]> {
  try {
    const res = await fetch(HYPERLIQUID_INFO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      signal: AbortSignal.timeout(TIMEOUT),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const raw = await res.json();
    const universe = raw?.[0]?.universe ?? [];
    const ctxs = raw?.[1] ?? [];
    const rates: FundingRow[] = [];
    for (let i = 0; i < universe.length; i++) {
      const name = universe[i]?.name;
      const funding = parseFloat(ctxs[i]?.funding ?? "");
      if (!name || !Number.isFinite(funding)) continue;
      rates.push({
        coin: name,
        hourlyRate: funding,
        annualizedPct: funding * 24 * 365 * 100,
        markUsd: Number(ctxs[i]?.markPx ?? 0),
        szDecimals: Number(universe[i]?.szDecimals ?? 0),
        maxLeverage: Number(universe[i]?.maxLeverage ?? 1),
        dayVolumeUsd: Number(ctxs[i]?.dayNtlVlm ?? 0),
      });
    }
    // Return ALL coins sorted by absolute annualized rate
    return rates.sort((a, b) => Math.abs(b.annualizedPct) - Math.abs(a.annualizedPct));
  } catch {
    return [];
  }
}

/* ---------- Extended: markets and funding ---------- */

export async function fetchExtendedMarkets(): Promise<ExtendedMarketRow[]> {
  try {
    const res = await fetch(`${EXTENDED_HOSTS.mainnet}/api/v1/info/markets`, {
      headers: { "user-agent": "meridian-terminal" },
      signal: AbortSignal.timeout(TIMEOUT),
      cache: "no-store",
    });
    if (!res.ok) return [];
    return parseExtendedMarketRows(((await res.json()) as { data?: Parameters<typeof parseExtendedMarketRows>[0] }).data);
  } catch {
    return [];
  }
}

/* ---------- TxFlow: markets and funding ---------- */

export async function fetchTxflowMarkets(): Promise<TxflowMarketRow[]> {
  try {
    return await Promise.race([fetchTxflowMarketRows(), new Promise<TxflowMarketRow[]>((resolve) => setTimeout(() => resolve([]), TIMEOUT))]);
  } catch {
    return [];
  }
}

/* ---------- Snapshot ---------- */

/** Perp quotes of the three venues, in the planner's shape (main Hyperliquid dex; HIP-3 and spot aren't paired by the bot). */
export async function fetchPerpSnapshot(): Promise<MarketSnapshot> {
  const [funding, extended, txflow] = await Promise.all([fetchFundingRates(), fetchExtendedMarkets(), fetchTxflowMarkets()]);
  return {
    fetchedAt: new Date().toISOString(),
    quotes: [
      ...funding
        .filter((f) => f.markUsd > 0)
        .map((f) => hlQuote({ market: f.coin, base: marketBase(f.coin), markUsd: f.markUsd, fundingHourly: f.hourlyRate, szDecimals: f.szDecimals, maxLeverage: f.maxLeverage, dayVolumeUsd: f.dayVolumeUsd })),
      ...extended
        .filter((m) => m.sizeStep > 0)
        .map((m) => extendedQuote({ market: m.name, base: m.base, markUsd: m.mark, fundingHourly: m.fundingHourly, sizeStep: m.sizeStep, minQty: m.minQty, maxLeverage: m.maxLeverage, dayVolumeUsd: m.dayVolumeUsd })),
      ...txflow.map((m) => txflowQuote({ market: m.name, base: m.base, markUsd: m.mark, fundingHourly: m.fundingHourly, szDecimals: m.szDecimals, maxLeverage: m.maxLeverage, dayVolumeUsd: m.dayVolumeUsd })),
    ],
  };
}

export type { ExtendedMarketRow, TxflowMarketRow };
