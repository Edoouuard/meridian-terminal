/**
 * pair.ts — the flagship request "beta neutral on X between Hyperliquid and
 * Extended", built by the server instead of the model: two perp positions
 * on the same asset, one on each venue, at the same base quantity. The long
 * goes on the venue whose funding costs a long the least, the short on the
 * one that pays a short the most (positive funding: longs pay shorts).
 * Sizes are set later from the free margin (lib/planner/sizing.ts).
 */

import type { LLMStrategy } from "@/lib/strategyIntegrity";
import { marketBase } from "@/lib/perpVenues";
import type { MarketQuote, MarketSnapshot } from "@/lib/planner/markets";
import type { PlannerClarify } from "@/lib/planner/clarify";

type Venue = "Hyperliquid" | "Extended";

/** Names people write for an asset → the ticker the venues list. */
const NAMED: Record<string, string> = {
  ether: "ETH", ethereum: "ETH", bitcoin: "BTC", solana: "SOL", tesla: "TSLA", nvidia: "NVDA", apple: "AAPL",
  microsoft: "MSFT", google: "GOOGL", amazon: "AMZN", gold: "GOLD", silver: "SILVER",
  spacex: "SPCX", "s&p500": "SP500", sp500: "SP500", nasdaq: "XYZ100",
};

/** Words that are never an asset here, even when a venue lists a ticker spelled the same. */
const NOT_ASSETS = new Set(
  (
    "hyperliquid hl extended x10 perp perps perpetual long short neutral neutre beta delta hedge pair paire volume farm farming " +
    "leverage levier lev the and with for between entre sur avec pour les des une mon mes ton tes son why not open what how much " +
    "all tout toute capital available disponible free margin marge funding position positions trade trades strategy strategie " +
    "stratégie maximize maximiser focus use using then also same instead plutot plutôt make faire fais ouvre open close ferme my your " +
    "est que qui pas non oui yes yeah okay can could would should please merci thanks this that these those it its de du en et la le " +
    "on in at to of by or an is be do go up so no me we you"
  ).split(/\s+/),
);

/** Assets the text names that some venue lists (perp bases), in the order written. */
export function mentionedBases(text: string, markets: MarketSnapshot | undefined): string[] {
  if (!markets) return [];
  const bases = new Set(markets.quotes.filter((q) => q.kind === "perp").map((q) => q.base.toUpperCase()));
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z&][A-Za-z0-9&]{1,11}(?::[A-Za-z0-9]+)?(?:-USD)?/g)) {
    const raw = m[0];
    const lower = raw.toLowerCase();
    if (NOT_ASSETS.has(lower)) continue;
    const named = NAMED[lower];
    // A lowercase word must be 3+ letters to count as a ticker ("eth" yes, "on" no); uppercase is intentional.
    if (!named && raw !== raw.toUpperCase() && raw.length < 3) continue;
    const base = named ?? marketBase(raw);
    if (bases.has(base) && !out.includes(base)) out.push(base);
  }
  return out;
}

const quotesFor = (base: string, venue: Venue, markets: MarketSnapshot) =>
  markets.quotes.filter((q) => q.kind === "perp" && q.venue === venue && q.base.toUpperCase() === base).sort((a, b) => b.dayVolumeUsd - a.dayVolumeUsd);

/** Assets listed as perps on both venues. */
export function sharedBases(markets: MarketSnapshot | undefined): string[] {
  if (!markets) return [];
  const on = (v: Venue) => new Set(markets.quotes.filter((q) => q.kind === "perp" && q.venue === v).map((q) => q.base.toUpperCase()));
  const hl = on("Hyperliquid");
  return [...on("Extended")].filter((b) => hl.has(b));
}

export interface PairRequest {
  /** Undefined when the request names no asset listed on both venues. */
  base?: string;
  leverage?: number;
}

/**
 * A two-venue neutral position: a neutral / pair / volume goal (or a long
 * and a short in the same sentence) with both venues named — or with no
 * venue named, on an asset both list, when the Extended account is
 * connected. Null for anything else, which the model plans (a single
 * venue named keeps the request on that venue).
 */
export function parsePairRequest(text: string, markets: MarketSnapshot | undefined, opts: { extendedConnected?: boolean } = {}): PairRequest | null {
  const hl = /\b(hyperliquid|hl)\b/i.test(text);
  const ext = /\b(extended|x10)\b/i.test(text);
  const goal = /\b(neutral|neutre|beta|delta|pair|paire|volume|farm\w*|carry|spread|arb\w*)\b/i.test(text) || (/\blong\b/i.test(text) && /\bshort\b/i.test(text));
  if (!goal) return null;
  const shared = new Set(sharedBases(markets));
  const base = mentionedBases(text, markets).find((b) => shared.has(b));
  if (!(hl && ext) && !(!hl && !ext && base && opts.extendedConnected)) return null;
  const lev = text.match(/(?:levier|leverage|lev)\s*(?:de|of|x|à|:)?\s*x?\s*(\d+(?:[.,]\d+)?)/i) ?? text.match(/\b(\d+(?:[.,]\d+)?)\s*x\b/i) ?? text.match(/\bx\s*(\d+(?:[.,]\d+)?)\b/i);
  const leverage = lev ? Number(lev[1].replace(",", ".")) : undefined;
  return { base, leverage: leverage && leverage >= 1 ? Math.floor(leverage) : undefined };
}

const pct = (hourly: number) => `${hourly >= 0 ? "+" : ""}${(hourly * 8760 * 100).toFixed(1)}%/yr`;

/** The two legs: long where funding is lowest, short where it is highest; leverage capped to both markets. */
export function buildPairStrategy(req: Required<Pick<PairRequest, "base">> & PairRequest, markets: MarketSnapshot): LLMStrategy | null {
  const hl = quotesFor(req.base, "Hyperliquid", markets)[0];
  const ext = quotesFor(req.base, "Extended", markets)[0];
  if (!hl || !ext) return null;
  const [long, short]: [MarketQuote, MarketQuote] = hl.fundingHourly <= ext.fundingHourly ? [hl, ext] : [ext, hl];
  const lev = Math.max(1, Math.min(req.leverage ?? 1, hl.maxLeverage || 1, ext.maxLeverage || 1));
  const capped = req.leverage && lev < req.leverage ? ` (${req.leverage}x asked; ${lev}x is the most both markets allow)` : "";
  const leg = (q: MarketQuote, side: "Long" | "Short") => ({
    side,
    asset: `${q.market} PERP`,
    protocol: q.venue,
    chain: "Arbitrum",
    leverage: lev,
    note: `${side} ${req.base} on ${q.venue} (${q.market}) at ${lev}x; funding ${pct(q.fundingHourly)}, ${side === "Long" ? "paid by a long when positive" : "earned by a short when positive"}.`,
  });
  return {
    name: `${req.base} beta-neutral: long ${long.venue}, short ${short.venue}`,
    risk: lev >= 5 ? "aggressive" : "moderate",
    variantNote: `Neutral only once both legs fill at the same quantity; at ${lev}x a ${(100 / lev).toFixed(0)}% move against one leg nears its liquidation.`,
    summary: `Long ${req.base} on ${long.venue} (funding ${pct(long.fundingHourly)}) and short the same quantity on ${short.venue} (${pct(short.fundingHourly)}), ${lev}x${capped}: the short side pays more funding than the long side costs, and the price moves cancel out.`,
    exit: "Close both legs at market (one signature per order)",
    risks: ["One leg can be liquidated before the other if the price moves fast", "Funding rates change and can flip", "The two markets can drift apart (basis)"],
    legs: [leg(long, "Long"), leg(short, "Short")],
  };
}

/** Before building a two-venue neutral position with no asset: which one, among those both venues list (widest funding spread first). */
export function pairAssetQuestion(markets: MarketSnapshot | undefined): PlannerClarify | null {
  if (!markets) return null;
  const ranked = sharedBases(markets)
    .map((b) => {
      const hl = quotesFor(b, "Hyperliquid", markets)[0];
      const ext = quotesFor(b, "Extended", markets)[0];
      return { b, spread: Math.abs(hl.fundingHourly - ext.fundingHourly) * 8760 * 100, volume: Math.min(hl.dayVolumeUsd, ext.dayVolumeUsd) };
    })
    .filter((x) => x.volume >= 100_000)
    .sort((a, c) => c.spread - a.spread)
    .slice(0, 4);
  if (ranked.length < 2) return null;
  return { question: "Which asset should the neutral position use?", why: "Ranked by today's funding gap between Hyperliquid and Extended (listed on both).", options: ranked.map((x) => `${x.b} (gap ${x.spread.toFixed(1)}%/yr)`) };
}
