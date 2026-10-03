import { describe, expect, it } from "vitest";
import type { ThreadType } from "@/lib/data";
import { EXAMPLE_THESIS_FOR_TYPE, routeThesis } from "@/lib/routeThesis";

describe("routeThesis — EXAMPLE_THESIS_FOR_TYPE round-trips", () => {
  it("every example sentence parses back to its own key via routeThesis", () => {
    for (const [key, text] of Object.entries(EXAMPLE_THESIS_FOR_TYPE) as [Exclude<ThreadType, "custom">, string][]) {
      const routed = routeThesis(text);
      expect(routed.type, `"${text}" should route to "${key}"`).toBe(key);
      expect(routed.plan).toBeDefined();
    }
  });

  it("the pendle example resolves to the Pendle protocol, not a coincidentally-matched one", () => {
    const routed = routeThesis(EXAMPLE_THESIS_FOR_TYPE.pendle);
    expect(routed.plan!.legs[0].protocol).toBe("Pendle");
  });

  it("the swap example resolves to Uniswap, not a coincidentally-matched one", () => {
    const routed = routeThesis(EXAMPLE_THESIS_FOR_TYPE.swap);
    expect(routed.plan!.legs[0].protocol).toBe("Uniswap");
  });

  it("the betaneutral example routes one leg to Hyperliquid (live) and one to Extended (not live)", () => {
    const routed = routeThesis(EXAMPLE_THESIS_FOR_TYPE.betaneutral);
    const protocols = routed.plan!.legs.map((l) => l.protocol);
    expect(protocols).toEqual(["Hyperliquid", "Extended"]);
  });

  it("the perp and hedge examples resolve to Hyperliquid", () => {
    expect(routeThesis(EXAMPLE_THESIS_FOR_TYPE.perp).plan!.legs[0].protocol).toBe("Hyperliquid");
    expect(routeThesis(EXAMPLE_THESIS_FOR_TYPE.hedge).plan!.legs[0].protocol).toBe("Hyperliquid");
  });
});

describe("routeThesis — variant alternatives surface without changing the default plan", () => {
  it("the betaneutral example carries all 3 venue variants, defaulting to the one it already resolved to", () => {
    const routed = routeThesis(EXAMPLE_THESIS_FOR_TYPE.betaneutral);
    expect(routed.variants).toHaveLength(3);
    expect(routed.plan).toBe(routed.variants![0]); // Extended, same as the single-plan default above.
  });

  it("the perp example carries 3 leverage-tier variants, defaulting to Balanced (the old fixed 4x default)", () => {
    const routed = routeThesis(EXAMPLE_THESIS_FOR_TYPE.perp);
    expect(routed.variants).toHaveLength(3);
    expect(routed.plan!.variantLabel).toBe("Balanced · 4x");
    expect(routed.plan!.leverage).toBe(4);
  });

  it("an intent with no honest alternative carries no variants", () => {
    expect(routeThesis(EXAMPLE_THESIS_FOR_TYPE.pendle).variants).toBeUndefined();
  });
});
