import { NextResponse } from "next/server";
import { normalizeNews, type NewsItem } from "@/lib/news";
import { RSS_FEEDS, mergeNews, parseRss } from "@/lib/newsRss";

/**
 * GET /api/news — the latest crypto headlines: the newsrooms' RSS feeds
 * (CoinDesk, Cointelegraph, Decrypt, The Block, Blockworks), real time,
 * cached 5 minutes; plus NewsData.io when NEWSDATA_API_KEY is set (its free
 * plan runs 12 hours behind, so it only fills in). Newest first, one item
 * per title. Always answers 200 with { items, status } so the panel can say
 * "unavailable" instead of failing.
 */
// Dynamic: a build-time prerender would freeze an outage for the whole cache window.
// The upstream calls themselves are cached by fetch (next.revalidate below).
export const dynamic = "force-dynamic";

const NEWSDATA_URL = "https://newsdata.io/api/1/crypto";

let lastGood: { items: NewsItem[]; fetchedAt: number } | null = null;
const MAX_STALE_MS = 2 * 60 * 60_000;

async function rss(): Promise<NewsItem[][]> {
  return Promise.all(
    RSS_FEEDS.map(async (f) => {
      try {
        const res = await fetch(f.url, { next: { revalidate: 300 }, signal: AbortSignal.timeout(6000), headers: { "user-agent": "Meridian/1.0 (+news)", accept: "application/rss+xml, application/xml, text/xml" } });
        return res.ok ? parseRss(await res.text(), f.source) : [];
      } catch {
        return [];
      }
    }),
  );
}

async function newsData(): Promise<NewsItem[]> {
  const key = process.env.NEWSDATA_API_KEY;
  if (!key) return [];
  try {
    const url = `${NEWSDATA_URL}?apikey=${encodeURIComponent(key)}&language=en&removeduplicate=1`;
    const res = await fetch(url, { next: { revalidate: 900 }, signal: AbortSignal.timeout(8000) });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.status !== "success") {
      // Never echo the request URL: it carries the key.
      console.error("[news] NewsData error:", res.status, typeof body?.results?.message === "string" ? body.results.message : "");
      return [];
    }
    return normalizeNews(body);
  } catch {
    return [];
  }
}

export async function GET() {
  const [feeds, nd] = await Promise.all([rss(), newsData()]);
  const items = mergeNews([...feeds, nd]);
  if (items.length) {
    lastGood = { items, fetchedAt: Date.now() };
    return NextResponse.json({ status: "ok", items, fetchedAt: new Date().toISOString() });
  }
  if (lastGood && Date.now() - lastGood.fetchedAt < MAX_STALE_MS) {
    return NextResponse.json({ status: "stale", items: lastGood.items, fetchedAt: new Date(lastGood.fetchedAt).toISOString() });
  }
  return NextResponse.json({ status: "unavailable", items: [] });
}
