import { describe, expect, it } from "vitest";
import { selectBestRoute, type RouteQuote } from "@/lib/mcp/router";

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
