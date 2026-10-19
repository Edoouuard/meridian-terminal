/**
 * marketCharts.ts — the charts a market answer can show, DefiLlama-style:
 * total DeFi TVL and stablecoin supply over 90 days, TVL by chain, daily DEX
 * volume, and today's price moves. The server reads the series (DefiLlama,
 * CoinGecko), gives the model a short text summary of each so its points
 * cite the same numbers, and attaches the ones the model picked (or a
 * default pair) to the answer. The client draws them (components/MarketChart).
 */

import type { PriceRow } from "@/lib/planner/answer";

export type ChartId = "defi_tvl" | "stablecoins" | "chain_tvl" | "dex_volume" | "price_moves";
export const CHART_IDS: ChartId[] = ["defi_tvl", "stablecoins", "chain_tvl", "dex_volume", "price_moves"];

export interface ChartPoint {
  label: string;
  value: number;
}

export interface MarketChart {
  id: ChartId;
  title: string;
  /** line: a series over time; bars: magnitudes by category; diverging: signed changes around zero. */
  kind: "line" | "bars" | "diverging";
  unit: "usd" | "pct";
  points: ChartPoint[];
  /** One line under the title: the latest value and its change. */
  caption?: string;
  source: string;
}

const DAY = 86_400;
const STABLES = new Set(["USDT", "USDC", "DAI", "USDS", "USDE", "SUSDE", "GHO"]);

export function fmtUsdShort(v: number): string {
  const a = Math.abs(v);
  const s = a >= 1e12 ? `${(a / 1e12).toFixed(2)}T` : a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}K` : a.toFixed(0);
  return `${v < 0 ? "-" : ""}$${s}`;
}

const pct = (from: number, to: number) => (from > 0 ? ((to - from) / from) * 100 : 0);
const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
const dayLabel = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

/** The last `days` daily points of a [unix seconds, value] series, oldest first. */
function lastDays(series: [number, number][], days: number, nowUnix: number): ChartPoint[] {
  return series
    .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v) && t >= nowUnix - days * DAY)
    .sort((a, b) => a[0] - b[0])
    .map(([t, v]) => ({ label: dayLabel(t), value: v }));
}

/** Caption for a time series: latest value, 7-day and whole-window change. */
function seriesCaption(points: ChartPoint[], window: string): string | undefined {
  if (points.length < 2) return undefined;
  const last = points[points.length - 1].value;
  const week = points[Math.max(0, points.length - 8)].value;
  return `${fmtUsdShort(last)} · ${signed(pct(week, last))} 7d · ${signed(pct(points[0].value, last))} ${window}`;
}

/* ── Parsers for the DefiLlama responses (defensive: any shape drift yields no chart, never a wrong one) ── */

/** api.llama.fi/v2/historicalChainTvl → [{ date, tvl }] */
export function parseHistoricalTvl(body: unknown, nowUnix: number): MarketChart | null {
  if (!Array.isArray(body)) return null;
  const series = body.map((r) => [Number((r as { date?: unknown }).date), Number((r as { tvl?: unknown }).tvl)] as [number, number]);
  const points = lastDays(series, 90, nowUnix);
  if (points.length < 10) return null;
  return { id: "defi_tvl", title: "Total DeFi TVL · 90 days", kind: "line", unit: "usd", points, caption: seriesCaption(points, "90d"), source: "DefiLlama" };
}

/** stablecoins.llama.fi/stablecoincharts/all → [{ date: "unix", totalCirculatingUSD: { peggedUSD } }] */
export function parseStablecoinSupply(body: unknown, nowUnix: number): MarketChart | null {
  if (!Array.isArray(body)) return null;
  const series = body.map((r) => {
    const o = r as { date?: unknown; totalCirculatingUSD?: Record<string, unknown> };
    const total = o.totalCirculatingUSD && typeof o.totalCirculatingUSD === "object" ? Object.values(o.totalCirculatingUSD).reduce<number>((a, v) => a + (Number(v) || 0), 0) : NaN;
    return [Number(o.date), total] as [number, number];
  });
  const points = lastDays(series, 90, nowUnix);
  if (points.length < 10) return null;
  return { id: "stablecoins", title: "Stablecoin supply · 90 days", kind: "line", unit: "usd", points, caption: seriesCaption(points, "90d"), source: "DefiLlama" };
}

/** api.llama.fi/v2/chains → [{ name, tvl }] */
export function parseChainTvl(body: unknown): MarketChart | null {
  if (!Array.isArray(body)) return null;
  const rows = body
    .map((r) => ({ label: String((r as { name?: unknown }).name ?? ""), value: Number((r as { tvl?: unknown }).tvl) }))
    .filter((r) => r.label && Number.isFinite(r.value) && r.value > 0)
    .sort((a, b) => b.value - a.value);
  if (rows.length < 3) return null;
  const total = rows.reduce((a, r) => a + r.value, 0);
  const top = rows.slice(0, 8);
  const share = (top[0].value / total) * 100;
  return { id: "chain_tvl", title: "TVL by chain · today", kind: "bars", unit: "usd", points: top, caption: `${top[0].label} holds ${share.toFixed(0)}% of ${fmtUsdShort(total)}`, source: "DefiLlama" };
}

/** api.llama.fi/overview/dexs → { totalDataChart: [[unix, volume]] } */
export function parseDexVolume(body: unknown, nowUnix: number): MarketChart | null {
  const chart = (body as { totalDataChart?: unknown } | null)?.totalDataChart;
  if (!Array.isArray(chart)) return null;
  const series = chart.filter(Array.isArray).map((r) => [Number(r[0]), Number(r[1])] as [number, number]);
  const points = lastDays(series, 30, nowUnix);
  if (points.length < 7) return null;
  const last = points[points.length - 1].value;
  const avg = points.slice(0, -1).reduce((a, p) => a + p.value, 0) / (points.length - 1);
  return { id: "dex_volume", title: "DEX volume per day · 30 days", kind: "line", unit: "usd", points, caption: `${fmtUsdShort(last)} last day · ${signed(pct(avg, last))} vs the 30-day average`, source: "DefiLlama" };
}

/** CoinGecko 24h moves: the majors and the biggest movers, sorted from best to worst. */
export function priceMovesChart(prices: PriceRow[]): MarketChart | null {
  const rows = prices.filter((p) => !STABLES.has(p.symbol) && Number.isFinite(p.change24h));
  if (rows.length < 3) return null;
  const majors = ["BTC", "ETH", "SOL", "HYPE", "BNB", "XRP"];
  const picked = [
    ...rows.filter((p) => majors.includes(p.symbol)),
    ...rows.filter((p) => !majors.includes(p.symbol)).sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h)).slice(0, 4),
  ].sort((a, b) => b.change24h - a.change24h);
  const up = rows.filter((p) => p.change24h > 0).length;
  return {
    id: "price_moves",
    title: "24h price change",
    kind: "diverging",
    unit: "pct",
    points: picked.map((p) => ({ label: p.symbol, value: Math.round(p.change24h * 10) / 10 })),
    caption: `${up} of ${rows.length} tracked coins up`,
    source: "CoinGecko",
  };
}

/** What the model reads about each chart: the same figures the user will see. */
export function chartsSection(charts: MarketChart[]): string {
  if (!charts.length) return "### DeFi charts: unavailable right now — don't cite TVL, stablecoin or DEX figures.";
  const lines = ["### DeFi data (DefiLlama) — chart ids you may attach in \"charts\""];
  for (const c of charts) {
    if (c.kind === "bars") lines.push(`- ${c.id}: ${c.title}: ${c.points.map((p) => `${p.label} ${fmtUsdShort(p.value)}`).join(", ")}${c.caption ? ` (${c.caption})` : ""}`);
    else if (c.kind === "diverging") lines.push(`- ${c.id}: ${c.title}: ${c.points.map((p) => `${p.label} ${signed(p.value)}`).join(", ")}`);
    else lines.push(`- ${c.id}: ${c.title}: ${c.caption ?? ""}`);
  }
  return lines.join("\n");
}

/**
 * The charts to attach: the ids the model picked that exist (up to 3, in its
 * order), else the price moves and the DeFi TVL.
 */
export function pickCharts(picked: unknown, available: MarketChart[]): MarketChart[] {
  const byId = new Map(available.map((c) => [c.id, c]));
  const ids = Array.isArray(picked) ? picked.filter((x): x is ChartId => typeof x === "string" && byId.has(x as ChartId)) : [];
  const chosen = [...new Set(ids)].slice(0, 3);
  const ordered = chosen.length ? chosen : (["price_moves", "defi_tvl"] as ChartId[]).filter((id) => byId.has(id));
  return ordered.map((id) => byId.get(id)!);
}

/** A chart as it arrives at the client: kept to its shape, null when malformed. */
export function cleanChart(v: unknown): MarketChart | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!CHART_IDS.includes(o.id as ChartId) || !["line", "bars", "diverging"].includes(o.kind as string) || !["usd", "pct"].includes(o.unit as string)) return null;
  const points = Array.isArray(o.points)
    ? o.points
        .map((p) => ({ label: String((p as ChartPoint)?.label ?? "").slice(0, 24), value: Number((p as ChartPoint)?.value) }))
        .filter((p) => p.label && Number.isFinite(p.value))
        .slice(0, 120)
    : [];
  if (points.length < 2) return null;
  return {
    id: o.id as ChartId,
    title: String(o.title ?? "").slice(0, 80),
    kind: o.kind as MarketChart["kind"],
    unit: o.unit as MarketChart["unit"],
    points,
    caption: typeof o.caption === "string" ? o.caption.slice(0, 120) : undefined,
    source: String(o.source ?? "").slice(0, 40),
  };
}

const LLAMA = {
  tvl: "https://api.llama.fi/v2/historicalChainTvl",
  chains: "https://api.llama.fi/v2/chains",
  stables: "https://stablecoins.llama.fi/stablecoincharts/all",
  dexs: "https://api.llama.fi/overview/dexs?excludeTotalDataChartBreakdown=true",
};

let cache: { charts: Omit<MarketChart, never>[]; at: number } | null = null;
const CACHE_MS = 15 * 60_000;

/** The DefiLlama charts (cached 15 minutes per instance); a source that fails is left out. */
export async function fetchDefiCharts(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<MarketChart[]> {
  if (cache && now - cache.at < CACHE_MS) return cache.charts;
  const get = async (url: string) => {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };
  const nowUnix = Math.floor(now / 1000);
  const [tvl, chains, stables, dexs] = await Promise.all([get(LLAMA.tvl), get(LLAMA.chains), get(LLAMA.stables), get(LLAMA.dexs)]);
  const charts = [parseHistoricalTvl(tvl, nowUnix), parseChainTvl(chains), parseStablecoinSupply(stables, nowUnix), parseDexVolume(dexs, nowUnix)].filter((c): c is MarketChart => c !== null);
  if (charts.length) cache = { charts, at: now };
  return charts;
}

/** Tests only: forget the cached charts. */
export function resetChartCache(): void {
  cache = null;
}
