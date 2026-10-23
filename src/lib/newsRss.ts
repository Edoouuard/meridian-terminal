/**
 * newsRss.ts — real-time crypto headlines from the newsrooms' own RSS feeds
 * (NewsData's free plan delays every article by 12 hours), parsed into the
 * feed's NewsItem shape and tagged with the coins their title names.
 * Pure: the route fetches, this parses.
 */

import type { NewsItem } from "@/lib/news";

export const RSS_FEEDS: { source: string; url: string }[] = [
  { source: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { source: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { source: "Decrypt", url: "https://decrypt.co/feed" },
  { source: "The Block", url: "https://www.theblock.co/rss.xml" },
  { source: "Blockworks", url: "https://blockworks.co/feed" },
];

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#8217;|&rsquo;/g, "'")
    .replace(/&#8216;|&lsquo;/g, "'")
    .replace(/&#822[01];|&[lr]dquo;/g, '"')
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&#8212;|&mdash;/g, "—")
    .replace(/&#x?[0-9a-f]+;/gi, "")
    .replace(/\s+/g, " ")
    .trim();

const tag = (block: string, name: string): string | undefined => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) || undefined : undefined;
};

/** Coins a headline names, by ticker or by name (the ones Meridian trades or prices). */
const COIN_NAMES: Record<string, string> = {
  bitcoin: "BTC", btc: "BTC", ethereum: "ETH", ether: "ETH", eth: "ETH", solana: "SOL", sol: "SOL", xrp: "XRP", ripple: "XRP",
  bnb: "BNB", dogecoin: "DOGE", doge: "DOGE", cardano: "ADA", ada: "ADA", tron: "TRX", trx: "TRX", hyperliquid: "HYPE", hype: "HYPE",
  chainlink: "LINK", link: "LINK", avalanche: "AVAX", avax: "AVAX", sui: "SUI", toncoin: "TON", ton: "TON", litecoin: "LTC", ltc: "LTC",
  polkadot: "DOT", uniswap: "UNI", aave: "AAVE", arbitrum: "ARB", optimism: "OP", pepe: "PEPE", near: "NEAR", aptos: "APT", monero: "XMR", xmr: "XMR",
  ena: "ENA", ethena: "ENA", usdc: "USDC", tether: "USDT", usdt: "USDT", stablecoin: "USDC", stablecoins: "USDC",
};

export function coinTags(text: string): string[] {
  const out = new Set<string>();
  for (const w of text.split(/[^A-Za-z0-9$]+/)) {
    const k = w.replace(/^\$/, "").toLowerCase();
    // Short tickers only when written in capitals (or $-prefixed): "link" or "near" as words aren't coins.
    const isTicker = /^\$?[A-Z]{2,5}$/.test(w);
    const c = COIN_NAMES[k];
    if (c && (k.length > 4 || isTicker)) out.add(c);
  }
  return [...out].slice(0, 4);
}

/** The items of one RSS (or Atom) feed, newest first. */
export function parseRss(xml: string, source: string, max = 15): NewsItem[] {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  const out: NewsItem[] = [];
  for (const b of blocks) {
    const title = tag(b, "title");
    const link = tag(b, "link") ?? b.match(/<link[^>]*href="([^"]+)"/i)?.[1];
    if (!title || !link || !/^https?:\/\//i.test(link)) continue;
    const date = tag(b, "pubDate") ?? tag(b, "published") ?? tag(b, "updated") ?? tag(b, "dc:date");
    const t = date ? Date.parse(date) : NaN;
    const description = tag(b, "description") ?? tag(b, "summary");
    out.push({
      id: link,
      title,
      link,
      source,
      publishedAt: Number.isFinite(t) ? new Date(t).toISOString() : undefined,
      description: description && description.length > 220 ? `${description.slice(0, 217).trimEnd()}…` : description,
      coins: coinTags(title),
    });
  }
  return out.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "")).slice(0, max);
}

/** Every source's items together: one per title, newest first. */
export function mergeNews(lists: NewsItem[][], max = 30): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const item of lists.flat().sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))) {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.slice(0, max);
}
