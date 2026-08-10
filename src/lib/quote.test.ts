import { describe, expect, it } from "vitest";
import {
  formatBaseUnits,
  resolvePriceFromList,
  usdToTokenAmount,
  type PriceEntry,
} from "@/lib/quote";

describe("quote — usdToTokenAmount (hard-fail pricing)", () => {
  it("returns null when there is no live price (hard-fail, never approximates)", () => {
    expect(usdToTokenAmount("ETH", 1000, null)).toBeNull();
    expect(usdToTokenAmount("ETH", 1000, undefined as unknown as number)).toBeNull();
    expect(usdToTokenAmount("ETH", 1000, 0)).toBeNull();
    expect(usdToTokenAmount("ETH", 1000, -5)).toBeNull();
    expect(usdToTokenAmount("ETH", 1000, NaN)).toBeNull();
    expect(usdToTokenAmount("ETH", 1000, Infinity)).toBeNull();
  });

  it("returns null for a dust amount that collapses to zero base units", () => {
    // $1 at a $100,000 price with 0 decimals → round(0.00001) = 0 base units → refuse.
    expect(usdToTokenAmount("VERYEXPENSIVE", 1, 100_000, 0)).toBeNull();
  });

  it("quotes a 1:1 stablecoin to exact whole units (USDC, 6 decimals)", () => {
    const q = usdToTokenAmount("USDC", 1000, 1, 6);
    expect(q).not.toBeNull();
    expect(q!.symbol).toBe("USDC");
    expect(q!.decimals).toBe(6);
    expect(q!.amount).toBe("1000");
    expect(q!.amountBase).toBe(1_000_000_000n);
    expect(q!.livePriced).toBe(true);
    expect(q!.priceUsd).toBe(1);
  });

  it("quotes an ETH-like asset by dividing notional by the live price", () => {
    const q = usdToTokenAmount("ETH", 1000, 4000);
    expect(q).not.toBeNull();
    expect(q!.amountBase).toBe(BigInt(Math.round((1000 / 4000) * 10 ** 18)));
    expect(q!.amount).toBe("0.25");
    expect(q!.sizeUsd).toBe(1000);
  });

  it("defaults to 18 decimals and the $100 default notional when omitted/invalid", () => {
    const q = usdToTokenAmount("ETH", 0, 2000);
    // sizeUsd 0 is not > 0 so it falls back to DEFAULT_SIZE_USD = 100.
    expect(q!.sizeUsd).toBe(100);
    expect(q!.decimals).toBe(18);
  });
});

describe("quote — resolvePriceFromList", () => {
  const prices: PriceEntry[] = [
    { symbol: "ETH", price: 4000 },
    { symbol: "usdc", price: 1 },
    { symbol: "BTC-PERP", price: 60000 },
  ];

  it("finds a price case-insensitively", () => {
    expect(resolvePriceFromList(prices, "eth")).toBe(4000);
    expect(resolvePriceFromList(prices, "ETH")).toBe(4000);
    expect(resolvePriceFromList(prices, "USDC")).toBe(1);
  });

  it("strips -PERP suffixes when matching", () => {
    expect(resolvePriceFromList(prices, "BTC")).toBe(60000);
  });

  it("returns null when absent, invalid, or no list given", () => {
    expect(resolvePriceFromList(prices, "SOL")).toBeNull();
    expect(resolvePriceFromList(undefined, "ETH")).toBeNull();
    expect(resolvePriceFromList(prices, undefined)).toBeNull();
    expect(resolvePriceFromList([{ symbol: "ETH", price: 0 }], "ETH")).toBeNull();
  });
});

describe("quote — formatBaseUnits", () => {
  it("formats exact decimals with trailing zeros trimmed", () => {
    expect(formatBaseUnits(1_000_000_000n, 6)).toBe("1000");
    expect(formatBaseUnits(239_234_449_760_765_550n, 18)).toBe("0.23923444976076555");
    expect(formatBaseUnits(0n, 6)).toBe("0");
  });
  it("handles integer and negative amounts", () => {
    expect(formatBaseUnits(5n, 0)).toBe("5");
    expect(formatBaseUnits(-5_000_000_000n, 6)).toBe("-5000");
  });
});