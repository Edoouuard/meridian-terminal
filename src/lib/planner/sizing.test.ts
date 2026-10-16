import { describe, expect, it } from "vitest";
import { capitalShare, sizePerpLegs, sizeQuestion } from "./sizing";
import type { LLMStrategy } from "@/lib/strategyIntegrity";

describe("capital share", () => {
  it("reads the share the user chose, in English or French", () => {
    expect(capitalShare("beta neutral SPCX — 100% of my available capital")).toBe(1);
    expect(capitalShare("beta neutral en SPCX leverage 10 — 50 % de mon capital disponible")).toBe(0.5);
    expect(capitalShare("use all my free margin")).toBe(1);
    expect(capitalShare("tout mon capital")).toBe(1);
    expect(capitalShare("la moitié de mon solde")).toBe(0.5);
  });

  it("doesn't mistake a stop-loss or a rate for a share", () => {
    expect(capitalShare("short ETH 2x, SL 20%")).toBeUndefined();
    expect(capitalShare("vault at 12% APY")).toBeUndefined();
  });
});

describe("size question", () => {
  const base = { clarified: false, hyperliquidFreeUsd: 21.79, extendedFreeUsd: 21 };
  it("asks how much capital to use for a perp request with no size, in the user's language", () => {
    const q = sizeQuestion({ ...base, thesis: "beta neutral en SPCX leverage 10" });
    expect(q?.clarify.question).toMatch(/capital disponible/);
    expect(q?.clarify.options[0]).toBe("100 % de mon capital disponible");
    expect(q?.clarify.why).toMatch(/Hyperliquid \$21\.79, Extended \$21\.00/);
    expect(sizeQuestion({ ...base, thesis: "focus on SPCX, leverage 10 to maximize volume" })?.clarify.options[0]).toBe("100% of my available capital");
  });

  it("doesn't ask when the size is given, after an answer, or for a non-perp request", () => {
    expect(sizeQuestion({ ...base, thesis: "long ETH 5x with $50" })).toBeNull();
    expect(sizeQuestion({ ...base, thesis: "beta neutral SPCX — 25% of my available capital" })).toBeNull();
    expect(sizeQuestion({ ...base, thesis: "beta neutral SPCX", clarified: true })).toBeNull();
    expect(sizeQuestion({ ...base, thesis: "best stablecoin yield on Base" })).toBeNull();
    expect(sizeQuestion({ clarified: false, thesis: "long ETH 3x", hyperliquidFreeUsd: null, extendedFreeUsd: null })).toBeNull();
  });
});

describe("perp legs sized from the free margin", () => {
  const pair: LLMStrategy = {
    name: "SPCX pair",
    risk: "moderate",
    variantNote: "",
    summary: "",
    legs: [
      { side: "Short", asset: "SPCX-USD PERP", protocol: "Extended", chain: "Arbitrum", sizeUsd: 10, leverage: 10 },
      { side: "Long", asset: "xyz:SPCX PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 10, leverage: 10 },
    ],
  };
  const balances = { hyperliquidFreeUsd: 21.79, extendedFreeUsd: 21, walletDeployableUsd: 10 };

  it("puts the share of the smaller venue's free margin, at the leverage, on both legs", () => {
    // (21 − $1 reserve) ÷ 1.03 × 10 = 194.17 on both.
    expect(sizePerpLegs(pair, [1, 0], balances, 1).legs.map((l) => l.sizeUsd)).toEqual([194.17, 194.17]);
    expect(sizePerpLegs(pair, [1, 0], balances, 0.5).legs.map((l) => l.sizeUsd)).toEqual([97.08, 97.08]);
  });

  it("keeps the model's sizes when a balance is unknown", () => {
    expect(sizePerpLegs(pair, [1, 0], { ...balances, extendedFreeUsd: null }, 1)).toBe(pair);
  });
});
