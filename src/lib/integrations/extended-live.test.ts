import { describe, expect, it } from "vitest";
import { formatDecimal, toExtendedMarket, worstCasePrice } from "@/lib/integrations/extended-live";

describe("extended-live — toExtendedMarket", () => {
  it("hyphenates a bare symbol against USD", () => {
    expect(toExtendedMarket("SOL")).toBe("SOL-USD");
  });

  it("strips a PERP suffix before hyphenating", () => {
    expect(toExtendedMarket("ETH-PERP")).toBe("ETH-USD");
  });

  it("is idempotent on an already-hyphenated market", () => {
    expect(toExtendedMarket("BTC-USD")).toBe("BTC-USD");
  });

  it("uppercases a lowercase symbol", () => {
    expect(toExtendedMarket("hype")).toBe("HYPE-USD");
  });
});

describe("extended-live — formatDecimal", () => {
  it("formats a plain fractional quantity without scientific notation", () => {
    expect(formatDecimal(0.00001234)).toBe("0.00001234");
  });

  it("trims trailing zeros", () => {
    expect(formatDecimal(1.5)).toBe("1.5");
  });

  it("trims a whole number down to no decimal point", () => {
    expect(formatDecimal(10)).toBe("10");
  });

  it("refuses a non-positive quantity", () => {
    expect(formatDecimal(0)).toBe("0");
    expect(formatDecimal(-5)).toBe("0");
    expect(formatDecimal(NaN)).toBe("0");
  });
});

describe("extended-live — worstCasePrice", () => {
  it("shifts a buy's worst price up", () => {
    expect(worstCasePrice(100, true, 100)).toBeCloseTo(101, 6);
  });

  it("shifts a sell's worst price down", () => {
    expect(worstCasePrice(100, false, 100)).toBeCloseTo(99, 6);
  });

  it("defaults to a 1% (100bps) buffer", () => {
    expect(worstCasePrice(2000, true)).toBeCloseTo(2020, 6);
  });
});
