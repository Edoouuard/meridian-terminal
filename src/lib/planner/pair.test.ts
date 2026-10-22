import { describe, expect, it } from "vitest";
import { buildPairStrategy, mentionedBases, pairAssetQuestion, parsePairRequest } from "./pair";
import { effectiveRequest } from "./conversation";
import { enforceConformance } from "./schema";
import { capitalShare, sizeQuestion } from "./sizing";
import { extendedQuote, hlQuote, txflowQuote, type MarketSnapshot } from "./markets";
import { parseExplicitPerpOrder } from "@/lib/explicitOrder";
import { validateAndFixStrategy } from "@/lib/strategyIntegrity";

const NOW = Date.parse("2026-10-16T20:30:00Z");
// Live values from the owner's test (2026-10-16): SPCX funding +9.6%/yr on Hyperliquid, +14.9%/yr on Extended.
const markets: MarketSnapshot = {
  fetchedAt: new Date(NOW - 20_000).toISOString(),
  quotes: [
    hlQuote({ market: "xyz:SPCX", base: "SPCX", markUsd: 145.965, fundingHourly: 0.096 / 8760, szDecimals: 2, maxLeverage: 20, dayVolumeUsd: 3e7 }),
    extendedQuote({ market: "SPCX-USD", base: "SPCX", markUsd: 145.965, fundingHourly: 0.149 / 8760, sizeStep: 0.01, minQty: 0.1, maxLeverage: 20, dayVolumeUsd: 1e6 }),
    hlQuote({ market: "ETH", base: "ETH", markUsd: 3000, fundingHourly: 0.0000125, szDecimals: 4, maxLeverage: 25, dayVolumeUsd: 1e9 }),
    extendedQuote({ market: "ETH-USD", base: "ETH", markUsd: 3001, fundingHourly: 0.00001, sizeStep: 0.001, minQty: 0.01, maxLeverage: 50, dayVolumeUsd: 5e8 }),
    hlQuote({ market: "HYPE", base: "HYPE", markUsd: 40, fundingHourly: 0.00001, szDecimals: 2, maxLeverage: 10, dayVolumeUsd: 2e8 }),
  ],
};

describe("the owner's SPCX conversation (2026-10-16)", () => {
  const first = "beta neutral en SPCX leverage 10";
  const followUp = "Why not open a long on Hyperliquid and a short on Extended?";

  it("never reads a venue as the asset of an order", () => {
    expect(parseExplicitPerpOrder(followUp)).toBeNull();
    expect(parseExplicitPerpOrder("open a long on Hyperliquid")).toBeNull();
    expect(parseExplicitPerpOrder("long SPCX on Hyperliquid 10x")?.asset).toBe("SPCX");
    expect(mentionedBases(followUp, markets)).toEqual([]);
  });

  it("applies the follow-up to the SPCX request, also once the capital question is answered", () => {
    const history = [{ request: first, answer: "Proposed: Short SPCX-USD PERP on Extended 10x; Long xyz:SPCX PERP on Hyperliquid 10x" }];
    expect(effectiveRequest(followUp, history, markets)).toBe(`${first} — ${followUp}`);
    const answered = `${followUp} — 100% of my available capital`;
    const request = effectiveRequest(answered, history, markets);
    expect(request).toBe(`${first} — ${answered}`);
    expect(capitalShare(request)).toBe(1);
    expect(parsePairRequest(request, markets)).toEqual({ base: "SPCX", leverage: 10 });
  });

  it("keeps a new request on its own", () => {
    expect(effectiveRequest("best stablecoin yield on Base", [{ request: first }], markets)).toBe("best stablecoin yield on Base");
    expect(effectiveRequest("short ETH 2x", [{ request: first }], markets)).toBe("short ETH 2x");
  });

  it("builds the first request itself (no venue named, Extended connected) and asks the capital share first", () => {
    expect(parsePairRequest(first, markets, { extendedConnected: true })).toEqual({ base: "SPCX", leverage: 10 });
    expect(parsePairRequest(first, markets, { extendedConnected: false })).toBeNull();
    expect(sizeQuestion({ thesis: first, hyperliquidFreeUsd: 21.79, extendedFreeUsd: 21.35 })?.clarify.question).toMatch(/available capital/);
  });

  it("two legs: long SPCX on Hyperliquid (lower funding), short on Extended (higher), 10x, ~$197 each at 100%", () => {
    const pair = buildPairStrategy({ base: "SPCX", leverage: 10 }, markets)!;
    expect(pair.legs.map((l) => `${l.side} ${l.asset} ${l.protocol} ${l.leverage}x`)).toEqual(["Long xyz:SPCX PERP Hyperliquid 10x", "Short SPCX-USD PERP Extended 10x"]);
    const fixed = validateAndFixStrategy(pair, { assets: [{ symbol: "USDC", venue: "Wallet", chain: "Base", usd: 10 }] });
    expect(fixed.legs).toHaveLength(2);
    const out = enforceConformance([fixed], "farming", {
      order: null,
      namedVenues: ["Hyperliquid", "Extended"],
      extended: { connected: true, network: "mainnet", availableUsd: 21.35 },
      markets,
      balances: { hyperliquidFreeUsd: 21.79, extendedFreeUsd: 21.35, walletDeployableUsd: 10 },
      sizeShare: 1,
      now: NOW,
    }).strategies[0];
    expect(out.kind).toBe("requested");
    expect(out.status).toBe("executable");
    expect(out.legs).toHaveLength(2);
    expect(out.economics?.legs?.map((l) => l.baseQuantity)).toEqual([1.35, 1.35]);
    expect(out.economics?.annualizedGrossCarryUsd).toBeGreaterThan(0);
  });

  it("caps the leverage to what both markets allow", () => {
    const pair = buildPairStrategy({ base: "SPCX", leverage: 40 }, markets)!;
    expect(pair.legs.every((l) => l.leverage === 20)).toBe(true);
    expect(pair.summary).toMatch(/40x asked; 20x/);
  });

  it("asks which asset when a two-venue neutral request names none, among assets listed on both", () => {
    const req = parsePairRequest("beta neutral entre Hyperliquid et Extended", markets);
    expect(req).toEqual({ base: undefined, leverage: undefined });
    const q = pairAssetQuestion(markets)!;
    expect(q.question).toMatch(/Which asset/);
    expect(q.options.map((o) => o.split(" ")[0])).toEqual(["SPCX", "ETH"]);
  });
});

describe("pairs with TxFlow", () => {
  const withTx: MarketSnapshot = {
    ...markets,
    quotes: [...markets.quotes, txflowQuote({ market: "ETH-USDC", base: "ETH", markUsd: 3000.5, fundingHourly: 0.00003, szDecimals: 3, maxLeverage: 25, dayVolumeUsd: 4e7 })],
  };

  it("pairs TxFlow with the other venue named, short where funding is higher", () => {
    const req = parsePairRequest("delta neutral ETH entre TxFlow et Hyperliquid 3x", withTx)!;
    expect(req).toEqual({ base: "ETH", leverage: 3, venues: ["Hyperliquid", "TxFlow"] });
    const pair = buildPairStrategy({ ...req, base: "ETH" }, withTx)!;
    expect(pair.legs.map((l) => [l.side, l.protocol, l.asset])).toEqual([
      ["Long", "Hyperliquid", "ETH PERP"],
      ["Short", "TxFlow", "ETH-USDC PERP"],
    ]);
    // All three venues named: the model plans it.
    expect(parsePairRequest("neutral ETH on TxFlow, Hyperliquid and Extended", withTx)).toBeNull();
  });

  it("asks which asset among those both venues list", () => {
    const q = pairAssetQuestion(withTx, ["Hyperliquid", "TxFlow"]);
    // One shared asset only: no choice to offer.
    expect(q).toBeNull();
    expect(parsePairRequest("neutral pair between txflow and extended", withTx)).toEqual({ base: undefined, leverage: undefined, venues: ["Extended", "TxFlow"] });
  });

  it("prices and sizes a TxFlow pair from both accounts, blocked while the TxFlow balance is unknown", () => {
    const pair = validateAndFixStrategy(buildPairStrategy({ base: "ETH", leverage: 1, venues: ["Hyperliquid", "TxFlow"] }, withTx)!, { assets: [] });
    const ctx = {
      order: null,
      namedVenues: ["Hyperliquid", "TxFlow"] as ("Hyperliquid" | "TxFlow")[],
      markets: withTx,
      sizeShare: 1,
      now: NOW,
    };
    const sized = enforceConformance([pair], "neutral_carry", { ...ctx, balances: { hyperliquidFreeUsd: 500, extendedFreeUsd: 0, txflowFreeUsd: 400, walletDeployableUsd: 0 } }).strategies[0];
    expect(sized.status).toBe("executable");
    // The thinner market (TxFlow here) is sent first.
    expect(sized.legs[0].protocol).toBe("TxFlow");
    const hl = sized.economics!.legs!.find((l) => l.venue === "Hyperliquid")!;
    const tx = sized.economics!.legs!.find((l) => l.venue === "TxFlow")!;
    expect(hl.baseQuantity).toBe(tx.baseQuantity);
    expect(tx).toMatchObject({ venue: "TxFlow", market: "ETH-USDC", side: "short" });
    expect(sized.economics!.annualizedGrossCarryUsd).toBeGreaterThan(0);

    const unknown = enforceConformance([pair], "neutral_carry", { ...ctx, balances: { hyperliquidFreeUsd: 500, extendedFreeUsd: 0, txflowFreeUsd: null, walletDeployableUsd: 0 } }).strategies[0];
    expect(unknown.status).toBe("blocked");
    expect(unknown.blockers?.join(" ")).toMatch(/TxFlow/);
  });
});

describe("pairs the server suggests when no asset is named", () => {
  it("picks the cheapest volume for farming, one asset per plan, at the farming leverage", async () => {
    const { suggestPairStrategies } = await import("./pair");
    const { extendedQuote, hlQuote } = await import("./markets");
    const h = (apr: number) => apr / 100 / 8760;
    const markets = {
      fetchedAt: "",
      quotes: [
        hlQuote({ market: "ETH", base: "ETH", markUsd: 2400, fundingHourly: h(11), szDecimals: 4, maxLeverage: 25, dayVolumeUsd: 9e8 }),
        extendedQuote({ market: "ETH-USD", base: "ETH", markUsd: 2400, fundingHourly: h(-2), sizeStep: 0.001, minQty: 0.01, maxLeverage: 50, dayVolumeUsd: 8e7 }),
        hlQuote({ market: "BTC", base: "BTC", markUsd: 90000, fundingHourly: h(8), szDecimals: 5, maxLeverage: 40, dayVolumeUsd: 2e9 }),
        extendedQuote({ market: "BTC-USD", base: "BTC", markUsd: 90000, fundingHourly: h(7), sizeStep: 0.0001, minQty: 0.0001, maxLeverage: 50, dayVolumeUsd: 3e8 }),
      ],
    };
    const out = suggestPairStrategies(markets, ["Hyperliquid", "Extended"], "farming", 3);
    expect(out.map((s) => s.name)).toEqual(["ETH beta-neutral: long Extended, short Hyperliquid", "BTC beta-neutral: long Extended, short Hyperliquid"]);
    expect(out[0].legs?.every((l) => l.leverage === 3)).toBe(true);
    expect(out[0].summary).toMatch(/neutral bot/);
  });
});
