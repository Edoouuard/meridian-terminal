import { describe, expect, it } from "vitest";
import { nativeFeeOf, selectBestRoute, type RouteQuote } from "@/lib/mcp/router";

function quote(provider: "debridge" | "lifi", toAmountEstimate?: string): RouteQuote {
  return {
    provider,
    tx: { to: "0x0000000000000000000000000000000000000001", data: "0x", chainId: 1 },
    toAmountEstimate,
  };
}

describe("mcp/router — selectBestRoute", () => {
  it("returns null/empty for no quotes", () => {
    expect(selectBestRoute([])).toEqual({ best: null, alternatives: [] });
  });

  it("picks the single quote when there is only one", () => {
    const q = quote("debridge", "1000000");
    const { best, alternatives } = selectBestRoute([q]);
    expect(best).toBe(q);
    expect(alternatives).toEqual([]);
  });

  it("picks the higher destination-amount estimate when both report one", () => {
    const low = quote("debridge", "900000");
    const high = quote("lifi", "950000");
    const { best, alternatives } = selectBestRoute([low, high]);
    expect(best).toBe(high);
    expect(alternatives).toEqual([low]);
  });

  it("keeps fetch order when estimates are not comparable (one or both missing)", () => {
    const first = quote("debridge", undefined);
    const second = quote("lifi", "950000");
    const { best, alternatives } = selectBestRoute([first, second]);
    expect(best).toBe(first);
    expect(alternatives).toEqual([second]);
  });

  it("treats an unparseable amount the same as missing (never throws)", () => {
    const first = quote("debridge", "not-a-number");
    const second = quote("lifi", "950000");
    const { best } = selectBestRoute([first, second]);
    expect(best).toBe(first);
  });

  it("breaks an exact tie by keeping fetch order", () => {
    const a = quote("debridge", "1000000");
    const b = quote("lifi", "1000000");
    const { best, alternatives } = selectBestRoute([a, b]);
    expect(best).toBe(a);
    expect(alternatives).toEqual([b]);
  });
});

describe("mcp/router — net USD selection", () => {
  const withNet = (provider: "debridge" | "lifi", toAmountEstimate: string, netUsdEstimate?: number): RouteQuote => ({
    ...quote(provider, toAmountEstimate),
    netUsdEstimate,
  });

  it("prefers the higher net USD value over the higher raw amount (fee-aware)", () => {
    // deBridge delivers more tokens but charges a native fee on top.
    const debridge = withNet("debridge", "49900000", 47.4);
    const lifi = withNet("lifi", "49800000", 49.8);
    const { best, alternatives } = selectBestRoute([debridge, lifi]);
    expect(best).toBe(lifi);
    expect(alternatives).toEqual([debridge]);
  });

  it("falls back to raw amounts when any quote lacks a net USD estimate", () => {
    const debridge = withNet("debridge", "49900000", undefined);
    const lifi = withNet("lifi", "49800000", 49.8);
    expect(selectBestRoute([debridge, lifi]).best).toBe(debridge);
  });
});

describe("mcp/router — nativeFeeOf", () => {
  const tx = (value?: string) => ({ to: "0x0000000000000000000000000000000000000001", data: "0x", value, chainId: 1 });
  const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
  const NATIVE = "0x0000000000000000000000000000000000000000";

  it("is the whole tx value for an ERC-20 input", () => {
    expect(nativeFeeOf(tx("1000000000000000"), USDC, "50000000")).toBe(1000000000000000n);
  });

  it("excludes the swapped amount for a native input", () => {
    expect(nativeFeeOf(tx("11000000000000000"), NATIVE, "10000000000000000")).toBe(1000000000000000n);
  });

  it("is zero when the tx carries no extra value", () => {
    expect(nativeFeeOf(tx("0x0"), USDC, "50000000")).toBe(0n);
    expect(nativeFeeOf(tx(undefined), USDC, "50000000")).toBe(0n);
    expect(nativeFeeOf(tx("10000000000000000"), NATIVE, "10000000000000000")).toBe(0n);
  });
});
