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
};

export interface LivePrice {
  symbol: string;
  price: number;
  change24h: number;
}

export async function GET() {
  const ids = Object.values(COINGECKO_IDS).join(",");

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`,
      { next: { revalidate: 30 } },
    );
    if (!res.ok) throw new Error(`CoinGecko responded ${res.status}`);

    const data: Record<string, { usd?: number; usd_24h_change?: number }> = await res.json();

    const prices: LivePrice[] = Object.entries(COINGECKO_IDS)
      .map(([symbol, id]) => {
        const entry = data[id];
        if (!entry || typeof entry.usd !== "number") return null;
        return { symbol, price: entry.usd, change24h: entry.usd_24h_change ?? 0 };
      })
      .filter((v): v is LivePrice => v !== null);

    return NextResponse.json(prices);
  } catch {
    // Keyless CoinGecko access can rate-limit or hit a transient error — callers fall
    // back to the static illustrative ticker data when this returns an empty list.
    return NextResponse.json<LivePrice[]>([], { status: 502 });
  }
}
