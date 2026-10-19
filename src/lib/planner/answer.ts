/**
 * answer.ts — questions that ask for a view, not a trade ("what do you think
 * about the crypto market?", "explain funding rates", "market overview, no
 * plan"). The planner answers them in words, from the live data, instead of
 * forcing a plan out of them: a short read of the market, the figures that
 * back it, and prompts the user can send next to act on it.
 */

import type { NewsItem } from "@/lib/news";
import { cleanChart, type MarketChart } from "@/lib/planner/marketCharts";

export interface PlannerAnswer {
  /** One line: the answer itself. */
  headline: string;
  /** 2-6 short points, each with the figure that backs it. */
  points: string[];
  /** What it means for the user, in one or two sentences. */
  takeaway?: string;
  /** Requests Meridian can run next, written as the user would type them. */
  followUps: string[];
  /** Charts drawn under the points (DeFi TVL, stablecoins, price moves…), attached by the server. */
  charts?: MarketChart[];
}

/** The user explicitly wants no plan. */
const NO_PLAN = /\b(no (plan|trade|strategy|position)s?|without (a )?(plan|trade)|overview only|just (tell|explain|an? overview)|sans (plan|trade|position)|pas de (plan|trade|position))\b/i;

/** A request for a view, an explanation or news. */
const ASKS_VIEW = new RegExp(
  [
    "\\bwhat\\b[^.?]{0,20}\\b(think|make of)\\b",
    "\\bthink\\b[^.?]{0,40}\\b(markets?|crypto|btc|eth|bitcoin|ethereum|sentiment)\\b",
    "\\bwhat'?s your (view|take|opinion|read)\\b",
    "\\byour (view|take|opinion|read) on\\b",
    "\\b(market|crypto) (overview|outlook|sentiment|analysis|update|recap|summary|conditions?|view)\\b",
    "\\b(overview|outlook|sentiment|state) of the (crypto )?market\\b",
    "\\bhow('?s| is| are) (the )?(crypto |market|markets|btc|eth|bitcoin|ethereum)\\b",
    "\\bwhat'?s (happening|going on|new)\\b",
    "\\b(any|latest|today'?s) news\\b",
    "\\bwhy (is|are|did|does) (the )?(market|crypto|btc|eth|bitcoin|ethereum|price)\\w*\\b",
    "\\b(que|qu'en) pens\\w*\\b",
    "(analyse|état|etat|tendance|actu\\w*) (du|des) march\\w*",
    "\\b(macro|tvl|total value locked|stablecoin (supply|market ?cap|flows?)|dex volumes?|defi (overview|trends?|state|activity|growth))\\b",
    "\\b(dominance|liquidity|inflows?|outflows?) (of|in|on|across) (the )?(market|crypto|defi|chains?)\\b",
  ].join("|"),
  "i",
);

/** Words that make it a trade request even inside a question ("why not long ETH at 5x?"). */
const TRADE_WORDS = /\b(long|short|buy|sell|swap|supply|deposit|stake|restake|borrow|bridge|send|transfer|hedge|farm\w*|lock|leverage|levier|\d+\s*x)\b/i;

/**
 * Is this a question to answer in words? Yes when the user rules out a plan,
 * or asks for a market view or news without naming a trade. Other questions
 * ("explain funding rates") reach the model, which can still answer in words.
 */
export function wantsAnswer(text: string): boolean {
  if (NO_PLAN.test(text)) return true;
  return ASKS_VIEW.test(text) && !TRADE_WORDS.test(text);
}

const cleanStr = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const cleanStrs = (v: unknown, max: number, count: number): string[] =>
  Array.isArray(v) ? v.map((x) => cleanStr(x, max)).filter((x): x is string => !!x).slice(0, count) : [];

/** The model's answer, kept to its shape; null when it has no headline or points. */
export function cleanAnswer(v: unknown): PlannerAnswer | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const headline = cleanStr(o.headline, 200);
  const points = cleanStrs(o.points, 280, 6);
  if (!headline || points.length === 0) return null;
  const charts = Array.isArray(o.charts) ? o.charts.map(cleanChart).filter((c): c is MarketChart => c !== null).slice(0, 3) : [];
  return { headline, points, takeaway: cleanStr(o.takeaway, 400), followUps: cleanStrs(o.followUps, 120, 3), ...(charts.length ? { charts } : {}) };
}

export interface PriceRow {
  symbol: string;
  price: number;
  change24h: number;
}

const STABLES = new Set(["USDT", "USDC", "DAI", "USDS", "USDE", "SUSDE", "GHO"]);
/** Shown first, then the biggest movers of the rest. */
const MAJORS = ["BTC", "ETH", "SOL", "HYPE", "BNB", "XRP"];

/** Live prices and headlines, as the model reads them for a market answer. */
export function marketSection(prices: PriceRow[], news: NewsItem[], now = new Date()): string {
  const lines = [`## LIVE MARKET — fetched ${now.toISOString()}`];
  const rows = prices.filter((p) => !STABLES.has(p.symbol) && Number.isFinite(p.price) && Number.isFinite(p.change24h));
  if (rows.length) {
    const fmt = (p: PriceRow) => `${p.symbol} $${p.price >= 100 ? Math.round(p.price).toLocaleString("en-US") : p.price.toPrecision(4)} (${p.change24h >= 0 ? "+" : ""}${p.change24h.toFixed(1)}% 24h)`;
    const majors = MAJORS.map((s) => rows.find((p) => p.symbol === s)).filter((p): p is PriceRow => !!p);
    const rest = rows.filter((p) => !MAJORS.includes(p.symbol)).sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h)).slice(0, 6);
    lines.push("### Prices (CoinGecko)", majors.map(fmt).join(" · "));
    if (rest.length) lines.push(`Biggest movers: ${rest.map(fmt).join(" · ")}`);
    const up = rows.filter((p) => p.change24h > 0).length;
    lines.push(`Breadth: ${up} of ${rows.length} tracked coins up over 24h.`);
  } else {
    lines.push("### Prices: unavailable right now — quote no price.");
  }
  if (news.length) {
    lines.push("### Latest headlines (NewsData)");
    for (const n of news.slice(0, 8)) lines.push(`- ${n.title}${n.source ? ` (${n.source})` : ""}${n.coins.length ? ` [${n.coins.slice(0, 3).join(", ")}]` : ""}`);
  } else {
    lines.push("### Headlines: unavailable right now — don't cite news.");
  }
  return lines.join("\n");
}

export const ANSWER_SYSTEM = `You are Meridian's market analyst. The user asked a question to be answered in words, not a plan or a trade.

Answer from the LIVE data you are given (prices, 24h moves, breadth, headlines, DeFi TVL, stablecoin supply, DEX volume, TVL by chain, funding rates, yields, the user's portfolio if any). Rules:
- Write in English only, whatever language the user writes in.
- Every point carries a figure from the data (a price, a % move, a funding rate, a yield). Never invent a number, a date or a headline; if a source is unavailable, say so instead.
- Give a clear read (risk-on, risk-off, mixed) and why, then what stands out: majors, movers, funding (positive funding = longs pay shorts, crowded longs), the best yields Meridian can execute.
- Funding and yields are observed now and can change; a view is not a forecast. No promises, no "guaranteed".
- If the user holds positions, say in one point what the market means for them.
- Macro and DeFi questions: use the DefiLlama figures (TVL trend, stablecoin supply as fresh liquidity, DEX volume as activity, TVL by chain as where capital sits).
- "charts": 1 to 3 chart ids from the "DeFi data" section and "price_moves", the ones that best show your answer (e.g. a macro question: "defi_tvl", "stablecoins"; a "how is the market" question: "price_moves", "defi_tvl"). Only ids listed as available.
- Never propose orders or sizes. "followUps" are 2-3 requests Meridian can run next, phrased as the user would type them (e.g. "Best yield for my USDC, no lock-up", "Short ETH 2x on Hyperliquid, stop-loss 20%").

Return ONLY valid JSON:
{
  "understanding": "The question, restated in one short sentence.",
  "answer": {
    "headline": "One line that answers the question.",
    "points": ["3 to 5 short points, each with its figure"],
    "takeaway": "One or two sentences: what it means for the user.",
    "followUps": ["Request 1", "Request 2"],
    "charts": ["price_moves", "defi_tvl"]
  }
}`;
