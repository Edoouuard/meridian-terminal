import { describe, expect, it } from "vitest";
import { newsPrompt, normalizeNews, parseNewsDate } from "./news";

const article = (over: Record<string, unknown> = {}) => ({
  article_id: "a1",
  title: "Ethereum ETF inflows rise",
  link: "https://example.com/eth",
  source_name: "Example",
  pubDate: "2026-10-16 17:42:10",
  pubDateTZ: "UTC",
  description: "Inflows rose.",
  coin: ["eth"],
  duplicate: false,
  ...over,
});

describe("news feed", () => {
  it("reads NewsData dates as UTC", () => {
    expect(parseNewsDate("2026-10-16 17:42:10", "UTC")).toBe("2026-10-16T17:42:10.000Z");
    expect(parseNewsDate("", "UTC")).toBeUndefined();
  });

  it("keeps valid articles, newest first, coins upper case", () => {
    const items = normalizeNews({
      status: "success",
      results: [article(), article({ article_id: "a2", title: "Bitcoin hits a high", link: "https://example.com/btc", pubDate: "2026-10-16 18:00:00", coin: ["btc"] })],
    });
    expect(items.map((i) => i.id)).toEqual(["a2", "a1"]);
    expect(items[1].coins).toEqual(["ETH"]);
    expect(items[1].publishedAt).toBe("2026-10-16T17:42:10.000Z");
  });

  it("drops duplicates, missing titles and non-http links", () => {
    const items = normalizeNews({
      results: [article(), article({ article_id: "dup", duplicate: true, title: "Other" }), article({ article_id: "same" }), article({ title: "" }), article({ title: "Bad link", link: "javascript:alert(1)" })],
    });
    expect(items.map((i) => i.id)).toEqual(["a1"]);
  });

  it("survives an unexpected payload", () => {
    expect(normalizeNews(null)).toEqual([]);
    expect(normalizeNews({ results: "nope" })).toEqual([]);
  });

  it("asks about the user's positions from live data", () => {
    const [item] = normalizeNews({ results: [article()] });
    expect(newsPrompt(item)).toMatch(/^News \(ETH\): "Ethereum ETF inflows rise" \(Example\)\. What could this mean for my positions/);
  });
});
