/**
 * news.ts — crypto headlines from NewsData.io (`/api/1/crypto`), normalized
 * for the feed. The API key stays on the server (NEWSDATA_API_KEY); the
 * route caches the result so the free quota (200 requests a day) is never
 * the limit.
 */

export interface NewsItem {
  id: string;
  title: string;
  link: string;
  source: string;
  /** ISO time the article was published, when NewsData gives one. */
  publishedAt?: string;
  description?: string;
  /** Coins NewsData tagged the article with, upper case ("BTC", "ETH"). */
  coins: string[];
}

interface RawArticle {
  article_id?: unknown;
  title?: unknown;
  link?: unknown;
  source_name?: unknown;
  source_id?: unknown;
  pubDate?: unknown;
  pubDateTZ?: unknown;
  description?: unknown;
  coin?: unknown;
  duplicate?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** NewsData dates read "2026-10-16 17:42:10" in UTC unless pubDateTZ says otherwise. */
export function parseNewsDate(pubDate: unknown, tz: unknown): string | undefined {
  const d = str(pubDate);
  if (!d) return undefined;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(d) && (str(tz) ?? "UTC") === "UTC" ? `${d.replace(" ", "T")}Z` : d;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/** Keep articles with a title and an http(s) link, drop duplicates (NewsData's flag, then same title), newest first. */
export function normalizeNews(payload: unknown, max = 20): NewsItem[] {
  const results = (payload as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const r of results as RawArticle[]) {
    const title = str(r?.title);
    const link = str(r?.link);
    if (!title || !link || !/^https?:\/\//i.test(link) || r.duplicate === true) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const description = str(r.description);
    out.push({
      id: str(r.article_id) ?? link,
      title,
      link,
      source: str(r.source_name) ?? str(r.source_id) ?? new URL(link).hostname.replace(/^www\./, ""),
      publishedAt: parseNewsDate(r.pubDate, r.pubDateTZ),
      description: description && description.length > 220 ? `${description.slice(0, 217).trimEnd()}…` : description,
      coins: Array.isArray(r.coin) ? r.coin.filter((c): c is string => typeof c === "string" && c.trim() !== "").map((c) => c.trim().toUpperCase()) : [],
    });
  }
  return out.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "")).slice(0, max);
}

/** The prompt an article's "Ask Meridian" sends: what it means for the user's positions, from live data. */
export function newsPrompt(item: NewsItem): string {
  const coins = item.coins.length ? ` (${item.coins.join(", ")})` : "";
  return `News${coins}: "${item.title}" (${item.source}). What could this mean for my positions, and is there a strategy worth considering with Meridian? Use live data only.`;
}
