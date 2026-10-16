import { NextResponse } from "next/server";
import { normalizeNews, type NewsItem } from "@/lib/news";

/**
 * GET /api/news — latest crypto headlines from NewsData.io. The key never
 * leaves the server. Cached 15 minutes (~96 upstream calls a day at most,
 * under the free plan's 200). Always answers 200 with { items, status } so
 * the panel can say "not configured" or "unavailable" instead of failing.
 */
// Dynamic: a build-time prerender would freeze "not configured" or an outage for the whole cache window.
// The upstream call itself is cached by fetch (next.revalidate below).
export const dynamic = "force-dynamic";

const NEWSDATA_URL = "https://newsdata.io/api/1/crypto";

let lastGood: { items: NewsItem[]; fetchedAt: number } | null = null;
const MAX_STALE_MS = 2 * 60 * 60_000;

export async function GET() {
  const key = process.env.NEWSDATA_API_KEY;
  if (!key) return NextResponse.json({ status: "not_configured", items: [] });
  try {
    const url = `${NEWSDATA_URL}?apikey=${encodeURIComponent(key)}&language=en&removeduplicate=1`;
    const res = await fetch(url, { next: { revalidate: 900 }, signal: AbortSignal.timeout(8000) });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.status !== "success") {
      // Never echo the request URL: it carries the key.
      console.error("[news] NewsData error:", res.status, typeof body?.results?.message === "string" ? body.results.message : "");
      throw new Error(`NewsData ${res.status}`);
    }
    const items = normalizeNews(body);
    if (items.length) lastGood = { items, fetchedAt: Date.now() };
    return NextResponse.json({ status: "ok", items, fetchedAt: new Date().toISOString() });
  } catch {
    if (lastGood && Date.now() - lastGood.fetchedAt < MAX_STALE_MS) {
      return NextResponse.json({ status: "stale", items: lastGood.items, fetchedAt: new Date(lastGood.fetchedAt).toISOString() });
    }
    return NextResponse.json({ status: "unavailable", items: [] });
  }
}
