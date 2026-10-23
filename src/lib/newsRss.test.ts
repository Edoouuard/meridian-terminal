import { describe, expect, it } from "vitest";
import { coinTags, mergeNews, parseRss } from "@/lib/newsRss";

const RSS = `<?xml version="1.0"?><rss><channel><title>Feed</title>
<item><title><![CDATA[Bitcoin tops $120K as ETH &amp; SOL follow]]></title><link>https://example.com/a</link><pubDate>Fri, 23 Oct 2026 08:10:00 GMT</pubDate><description><![CDATA[<p>Markets rallied.</p>]]></description></item>
<item><title>Older story</title><link>https://example.com/b</link><pubDate>Thu, 22 Oct 2026 08:10:00 GMT</pubDate></item>
<item><title>No link</title></item>
</channel></rss>`;

const ATOM = `<feed><entry><title>Hyperliquid volume hits record</title><link href="https://example.com/c"/><published>2026-10-23T09:00:00Z</published></entry></feed>`;

describe("RSS headlines", () => {
  it("parses items newest first, decoding entities and CDATA", () => {
    const items = parseRss(RSS, "CoinDesk");
    expect(items.map((i) => i.title)).toEqual(["Bitcoin tops $120K as ETH & SOL follow", "Older story"]);
    expect(items[0]).toMatchObject({ source: "CoinDesk", link: "https://example.com/a", publishedAt: "2026-10-23T08:10:00.000Z", description: "Markets rallied.", coins: ["BTC", "ETH", "SOL"] });
  });

  it("reads Atom too", () => {
    expect(parseRss(ATOM, "Blockworks")[0]).toMatchObject({ title: "Hyperliquid volume hits record", link: "https://example.com/c", coins: ["HYPE"] });
  });

  it("tags tickers only in capitals, names in any case", () => {
    expect(coinTags("Chainlink and $LINK rally while near-term risk grows")).toEqual(["LINK"]);
    expect(coinTags("Is now the time to link up?")).toEqual([]);
  });

  it("merges sources: one per title, newest first", () => {
    const a = parseRss(RSS, "CoinDesk");
    const b = [{ ...a[0], source: "Decrypt", id: "x" }, ...parseRss(ATOM, "Blockworks")];
    expect(mergeNews([a, b]).map((i) => `${i.source}:${i.title}`)).toEqual(["Blockworks:Hyperliquid volume hits record", "CoinDesk:Bitcoin tops $120K as ETH & SOL follow", "CoinDesk:Older story"]);
  });
});
