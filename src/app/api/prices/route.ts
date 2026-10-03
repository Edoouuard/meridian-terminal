import { NextResponse } from "next/server";

export const revalidate = 30;

/** CoinGecko coin ids for each ticker symbol shown in the app. */
const COINGECKO_IDS: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  USDT: "tether",
  XRP: "ripple",
  BNB: "binancecoin",
  SOL: "solana",
  USDC: "usd-coin",
  DOGE: "dogecoin",
  TRX: "tron",
  ADA: "cardano",
  HYPE: "hyperliquid",
  LINK: "chainlink",
  AVAX: "avalanche-2",
  SUI: "sui",
  XLM: "stellar",
  TON: "the-open-network",
  SHIB: "shiba-inu",
  LTC: "litecoin",
  DOT: "polkadot",
  BCH: "bitcoin-cash",
  HBAR: "hedera-hashgraph",
  UNI: "uniswap",
  PEPE: "pepe",
  NEAR: "near",
  APT: "aptos",
  // Not shown in the top-25 ticker — used to price wallet asset balances instead.
  DAI: "dai",
  WBTC: "wrapped-bitcoin",
  WSTETH: "wrapped-steth",
  // Native gas token on Polygon — covers both the pre- and post-rebrand symbol,
  // since which one a wallet balance reports depends on the viem chain version.
  MATIC: "matic-network",
  POL: "polygon-ecosystem-token",
};

export interface LivePrice {
  symbol: string;
  price: number;
  change24h: number;
}

/**
 * Last successful snapshot, kept in module scope. A warm serverless instance
 * reuses this across requests, so one CoinGecko rate-limit/outage doesn't
 * blank every price-dependent surface at once (the ticker, portfolio
 * valuation, every perp venue's order sizing) — it serves slightly-stale
 * real data instead of an empty list. Resets on a cold start, same as any
 * in-memory state; that's an acceptable gap, not a correctness problem,
 * since the first successful fetch repopulates it.
 */
let lastGood: { prices: LivePrice[]; fetchedAt: number } | null = null;

/**
 * How stale `lastGood` may be before we refuse to serve it. This price feeds
 * real order sizing across every perp venue — matching the app's existing
 * "HARD-FAIL pricing, never approximate" rule elsewhere (see quote.ts),
 * serving a multi-minute-old price to size a live order is its own safety
 * problem, not just a UX one. 3 minutes is generous for a feed that
 * revalidates every 30s under normal conditions.
 */
const MAX_STALE_MS = 3 * 60_000;

async function fetchFromCoinGecko(ids: string): Promise<LivePrice[]> {
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`,
    { next: { revalidate: 30 }, signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) throw new Error(`CoinGecko responded ${res.status}`);

  const data: Record<string, { usd?: number; usd_24h_change?: number }> = await res.json();

  return Object.entries(COINGECKO_IDS)
    .map(([symbol, id]) => {
      const entry = data[id];
      if (!entry || typeof entry.usd !== "number") return null;
      return { symbol, price: entry.usd, change24h: entry.usd_24h_change ?? 0 };
    })
    .filter((v): v is LivePrice => v !== null);
}

export async function GET() {
  const ids = Object.values(COINGECKO_IDS).join(",");

  try {
    const prices = await fetchFromCoinGecko(ids);
    if (prices.length === 0) throw new Error("CoinGecko returned no usable prices");
    lastGood = { prices, fetchedAt: Date.now() };
    return NextResponse.json(prices);
  } catch {
    // Keyless CoinGecko access can rate-limit or hit a transient error (this is
    // common for anonymous requests from datacenter/serverless IP ranges). Serve
    // the last real snapshot this instance fetched rather than an empty list —
    // every caller (ticker, portfolio valuation, every venue's order sizing)
    // would otherwise go blank/hard-fail on a single upstream hiccup. Past
    // MAX_STALE_MS we'd rather hard-fail than size a real order off an old
    // price, so we fall back to empty — which callers already treat as "no
    // live price yet" — same as when this instance has never fetched at all.
    const usable = lastGood && Date.now() - lastGood.fetchedAt <= MAX_STALE_MS;
    return NextResponse.json<LivePrice[]>(usable ? lastGood!.prices : [], { status: usable ? 200 : 502 });
  }
}
