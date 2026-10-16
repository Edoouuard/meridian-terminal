import { describe, expect, it } from "vitest";
import { enforceConformance, namedVenues, recomputeEconomics } from "./schema";
import { enforceExplicitOrder, parseExplicitPerpOrder } from "@/lib/explicitOrder";
import type { LLMStrategy } from "@/lib/strategyIntegrity";

const strat = (name: string, legs: LLMStrategy["legs"], extra: Partial<LLMStrategy> & Record<string, unknown> = {}): LLMStrategy =>
  ({ name, risk: "moderate", variantNote: "", summary: "", legs, ...extra }) as LLMStrategy;
const hlEthNeutral = (lev: number) =>
  strat(`Hyperliquid ETH Neutral (${lev}x)`, [
    { side: "Buy", asset: "UETH", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 30 },
    { side: "Short", asset: "ETH PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 30, leverage: lev },
  ]);
const pair = strat("ETH pair Extended / Hyperliquid", [
  { side: "Long", asset: "ETH PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 30, leverage: 1 },
  { side: "Short", asset: "ETH-USD PERP", protocol: "Extended", chain: "Arbitrum", sizeUsd: 30, leverage: 1 },
]);

// Reference cases of STRATEGIST.md section 9.
describe("planner contract — reference cases", () => {
  it("volume between Extended and Hyperliquid, Extended empty: the pair is requested and blocked; Hyperliquid-only plans are alternatives", () => {
    const thesis = "ouvre du beta neutral pour optimiser le volume entre Extended et Hyperliquid";
    expect(namedVenues(thesis)).toEqual(["Hyperliquid", "Extended"]);
    const out = enforceConformance([hlEthNeutral(1), hlEthNeutral(2), pair], "farming", {
      order: null,
      namedVenues: namedVenues(thesis),
      extended: { connected: true, network: "mainnet", availableUsd: 0 },
    });
    expect(out.strategies.map((s) => [s.name, s.kind, s.status])).toEqual([
      ["ETH pair Extended / Hyperliquid", "requested", "blocked"],
      ["Hyperliquid ETH Neutral (1x)", "alternative", "executable"],
      ["Hyperliquid ETH Neutral (2x)", "alternative", "executable"],
    ]);
    expect(out.strategies[0].blockers?.[0]).toMatch(/Extended has \$0 free/);
    expect(out.strategies[1].changes).toEqual(["venue: Extended not used (you named it)"]);
    expect(out.strategies[0].pair).toEqual({ legs: [0, 1], sizing: "equal_base_quantity" });
    // Never an alternative.
    expect(out.recommended).toBe(0);
  });

  it("only Hyperliquid plans for a two-venue request: no recommendation", () => {
    const out = enforceConformance([hlEthNeutral(1)], "farming", { order: null, namedVenues: ["Hyperliquid", "Extended"], extended: { connected: false } });
    expect(out.strategies[0].kind).toBe("alternative");
    expect(out.recommended).toBeUndefined();
  });

  it("short AMD on Extended, not funded: requested plan blocked first, the Hyperliquid short as a labeled alternative, nothing else", () => {
    const thesis = "open short amd sur extended";
    const order = parseExplicitPerpOrder(thesis);
    const llm = [
      strat("Short AMD on Hyperliquid", [{ side: "Short", asset: "xyz:AMD PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 66, leverage: 5 }]),
    ];
    const withOrder = enforceExplicitOrder(llm, order, [], 0);
    const out = enforceConformance(withOrder, "explicit_order", { order, namedVenues: namedVenues(thesis), extended: { connected: true, network: "mainnet", availableUsd: 0 } });
    expect(out.strategies.map((s) => [s.kind, s.status, s.legs[0].protocol])).toEqual([
      ["requested", "blocked", "Extended"],
      ["alternative", "executable", "Hyperliquid"],
    ]);
    expect(out.strategies[1].changes).toContain("venue: Extended → Hyperliquid");
    expect(out.recommended).toBe(0);
  });

  it("short ETH 2x SL 20%: a leverage variant is an alternative, never a requested plan", () => {
    const order = parseExplicitPerpOrder("short ETH levier 2, SL 20%");
    const exact = strat("Short ETH 2x", [{ side: "Short", asset: "ETH PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 100, leverage: 2, stopLossPct: 20 }]);
    const variant = strat("Short ETH 3x", [{ side: "Short", asset: "ETH PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 100, leverage: 3, stopLossPct: 20 }]);
    const out = enforceConformance([variant, exact], "explicit_order", { order, namedVenues: [], extended: undefined });
    expect(out.strategies[0]).toMatchObject({ name: "Short ETH 2x", kind: "requested", status: "executable" });
    expect(out.strategies[1]).toMatchObject({ name: "Short ETH 3x", kind: "alternative", changes: ["leverage: 2x → 3x"] });
    expect(out.recommended).toBe(0);
  });

  it("an Extended balance that couldn't be read blocks Extended legs (unknown is not zero, and not usable)", () => {
    const out = enforceConformance([pair], "farming", { order: null, namedVenues: [], extended: { connected: true, network: "mainnet" } });
    expect(out.strategies[0].status).toBe("blocked");
    expect(out.strategies[0].blockers?.[0]).toMatch(/balance unknown/);
  });
});

describe("planner contract — economics and ranking", () => {
  it("recomputes the return on committed capital with one formula (negative carry stays negative)", () => {
    // Long pays +11.4%, short earns +11.0% on $30 per leg: −$0.12 a year before fees.
    const e = recomputeEconomics(
      { capitalCommittedUsd: 61.8, notionalPerLegUsd: 30, volumeUsd: 120, annualizedGrossCarryUsd: (0.11 - 0.114) * 30, entryExitCostUsd: 0.057, holdingDays: 7, annualizedReturnOnCapitalPct: 99 },
      30,
    )!;
    expect(e.annualizedReturnOnCapitalPct).toBeCloseTo(((-0.12 - 0.057 * (365 / 7)) / 61.8) * 100, 1);
    expect(e.annualizedReturnOnCapitalPct).toBeLessThan(0);
    expect(recomputeEconomics({ capitalCommittedUsd: 0 }, 30)).toBeUndefined();
    expect(recomputeEconomics({ capitalCommittedUsd: 50, annualizedGrossCarryUsd: 5 }, 30)?.holdingDays).toBe(30);
  });

  it("farming ranks requested plans by cost per dollar of volume", () => {
    const a = strat("A", pair.legs, { economics: { capitalCommittedUsd: 60, volumeUsd: 120, entryExitCostUsd: 0.12, holdingDays: 7 } });
    const b = strat("B", pair.legs, { economics: { capitalCommittedUsd: 60, volumeUsd: 120, entryExitCostUsd: 0.06, holdingDays: 7 } });
    const out = enforceConformance([a, b], "farming", { order: null, namedVenues: [], extended: { connected: true, network: "mainnet", availableUsd: 100 } });
    expect(out.strategies.map((s) => s.name)).toEqual(["B", "A"]);
  });

  it("returns at most three plans, requested before alternatives", () => {
    const out = enforceConformance([hlEthNeutral(1), hlEthNeutral(2), hlEthNeutral(3), pair], "farming", {
      order: null,
      namedVenues: ["Hyperliquid", "Extended"],
      extended: { connected: true, network: "mainnet", availableUsd: 100 },
    });
    expect(out.strategies).toHaveLength(3);
    expect(out.strategies[0].name).toBe("ETH pair Extended / Hyperliquid");
    expect(out.strategies[0].status).toBe("executable");
  });
});
