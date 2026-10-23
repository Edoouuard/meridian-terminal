import { describe, expect, it } from "vitest";
import { effectiveRequest, isFundsStatement, normalizeChainMentions } from "./conversation";
import { mentionedBases, parsePairRequest } from "./pair";
import { extendedQuote, hlQuote, type MarketSnapshot } from "./markets";

const markets: MarketSnapshot = {
  fetchedAt: new Date().toISOString(),
  quotes: [
    hlQuote({ market: "ARB", base: "ARB", markUsd: 0.1793, fundingHourly: 0.11 / 8760, szDecimals: 0, maxLeverage: 10, dayVolumeUsd: 2e7 }),
    extendedQuote({ market: "ARB-USD", base: "ARB", markUsd: 0.1794, fundingHourly: 0.026 / 8760, sizeStep: 1, minQty: 10, maxLeverage: 10, dayVolumeUsd: 1e6 }),
    hlQuote({ market: "ETH", base: "ETH", markUsd: 3000, fundingHourly: 0.0000125, szDecimals: 4, maxLeverage: 25, dayVolumeUsd: 1e9 }),
    extendedQuote({ market: "ETH-USD", base: "ETH", markUsd: 3001, fundingHourly: 0.00001, sizeStep: 0.001, minQty: 0.01, maxLeverage: 50, dayVolumeUsd: 5e8 }),
  ],
};

describe("the owner's Extended deposit conversation (2026-10-23)", () => {
  const first = "depose 35$ sur extended";
  const followUp = "i got stabelcoin on ARB";

  it("reads 'on ARB' as the Arbitrum chain, and keeps ARB the token in a trade", () => {
    expect(normalizeChainMentions(followUp)).toBe("i got stabelcoin on Arbitrum");
    expect(normalizeChainMentions("j'ai des stables sur ARB")).toBe("j'ai des stables sur Arbitrum");
    expect(normalizeChainMentions("bridge to arb chain")).toBe("bridge to Arbitrum");
    expect(normalizeChainMentions("long on ARB")).toBe("long on ARB");
    expect(normalizeChainMentions("short ARB on Extended")).toBe("short ARB on Extended");
    expect(normalizeChainMentions("long ARB-USD on Extended, short on Hyperliquid")).toBe("long ARB-USD on Extended, short on Hyperliquid");
  });

  it("never turns a statement about funds into an ARB neutral pair", () => {
    // The raw message: "ARB" no longer reads as "arbitrage".
    expect(parsePairRequest(followUp, markets, { extendedConnected: true })).toBeNull();
    expect(parsePairRequest(normalizeChainMentions(followUp), markets, { extendedConnected: true })).toBeNull();
    expect(mentionedBases("USDC on Ethereum and stables on Arbitrum", markets)).toEqual([]);
    // A real arbitrage request still counts.
    expect(parsePairRequest("arbitrage ETH between hyperliquid and extended", markets)).toMatchObject({ base: "ETH" });
  });

  it("applies a statement about funds to the request before it", () => {
    const msg = normalizeChainMentions(followUp);
    expect(isFundsStatement(msg)).toBe(true);
    expect(effectiveRequest(msg, [{ request: first }], markets)).toBe(`${first} — ${msg}`);
  });

  it("still treats a request as a request", () => {
    expect(isFundsStatement("mes stables sur Arbitrum, meilleur rendement")).toBe(false);
    expect(isFundsStatement("I have USDC, where should I put it?")).toBe(false);
    expect(isFundsStatement("deposit my USDC on Extended")).toBe(false);
    expect(effectiveRequest("long ETH 3x", [{ request: first }], markets)).toBe("long ETH 3x");
  });
});
