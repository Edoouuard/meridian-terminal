import { describe, expect, it } from "vitest";
import { parseThesis, parseThesisVariants, planToThreadType } from "@/lib/tradePlan";

describe("tradePlan — parseThesis directional", () => {
  it("parses 'long HYPE 6k leverage 6' into a directional HYPE plan at 6x", () => {
    const plan = parseThesis("long HYPE 6k leverage 6");
    expect(plan.intent).toBe("directional");
    expect(plan.direction).toBe("long");
    expect(plan.asset).toBe("HYPE");
    expect(plan.sizeUsd).toBe(6000);
    expect(plan.leverage).toBe(6);
    expect(plan.legs).toHaveLength(1);
    expect(plan.legs[0]).toMatchObject({
      side: "Long",
      asset: "HYPE PERP",
      protocol: "Hyperliquid",
      sizeUsd: 6000,
      leverage: 6,
    });
    expect(plan.summary).toContain("$6,000");
    expect(plan.summary).toContain("6x");
  });

  it("parses multi-asset 'ETH and HYPE undervalued' into two long legs", () => {
    const plan = parseThesis("ETH and HYPE undervalued");
    expect(plan.intent).toBe("directional");
    expect(plan.direction).toBe("long");
    expect(plan.asset).toBe("ETH");
    expect(plan.sizeUsd).toBe(8000); // DEFAULT_SIZES.directional
    // No "leverage N" in the thesis, so the top-level leverage stays unset while
    // each leg gets the directional default.
    expect(plan.leverage).toBeUndefined();
    expect(plan.legs[0].leverage).toBe(4);
    expect(plan.legs).toHaveLength(2);
    expect(plan.legs.map((l) => l.asset)).toEqual(["ETH PERP", "HYPE PERP"]);
    expect(plan.summary).toContain("2 legs");
  });

  it("handles a short thesis", () => {
    const plan = parseThesis("short SOL on Hyperliquid, size 5000");
    expect(plan.intent).toBe("directional");
    expect(plan.direction).toBe("short");
    expect(plan.asset).toBe("SOL");
    expect(plan.legs[0].side).toBe("Short");
  });
});

describe("tradePlan — beta-neutral short-venue selection", () => {
  it("defaults the short leg to Extended when no other venue is named", () => {
    const plan = parseThesis("Farm HYPE points without directional risk");
    expect(plan.intent).toBe("betaNeutral");
    expect(plan.legs.map((l) => l.protocol)).toEqual(["Hyperliquid", "Extended"]);
  });

  it("still defaults to Extended when the thesis names Hyperliquid itself", () => {
    const plan = parseThesis("Farm Hyperliquid points on ETH without directional risk");
    expect(plan.legs.map((l) => l.protocol)).toEqual(["Hyperliquid", "Extended"]);
  });

  it("routes the short leg to Lighter when the thesis names it", () => {
    const plan = parseThesis("Farm points on Lighter without directional risk");
    expect(plan.legs.map((l) => l.protocol)).toEqual(["Hyperliquid", "Lighter"]);
  });

  it("routes the short leg to Ondo when the thesis names it", () => {
    const plan = parseThesis("Delta neutral TSLA points farm on Ondo");
    expect(plan.legs.map((l) => l.protocol)).toEqual(["Hyperliquid", "Ondo"]);
  });
});

describe("tradePlan — borrowing / supply / repay intents", () => {
  it("parses 'borrow 10k USDC on Aave'", () => {
    const plan = parseThesis("borrow 10k USDC on Aave");
    expect(plan.intent).toBe("borrow");
    expect(plan.protocol).toBe("Aave");
    expect(plan.asset).toBe("USDC");
    expect(plan.sizeUsd).toBe(10000);
    expect(plan.legs[0].side).toBe("Borrow");
  });

  it("parses a supply intent", () => {
    const plan = parseThesis("supply 5k ETH to Aave");
    expect(plan.intent).toBe("supply");
    expect(plan.sizeUsd).toBe(5000);
    expect(plan.legs[0].side).toBe("Supply");
  });

  it("parses 'park my USDT at the best yield' as a supply intent", () => {
    const plan = parseThesis("park my USDT at the best yield");
    expect(plan.intent).toBe("supply");
    expect(plan.asset).toBe("USDT");
    expect(plan.legs[0]).toMatchObject({ side: "Supply", protocol: "Aave" });
  });

  it("parses 'where i can put my usdc for the best yield?' as a supply intent (no explicit verb, generic 'best yield' phrasing)", () => {
    const plan = parseThesis("where i can put my usdc for the best yield?");
    expect(plan.intent).toBe("supply");
    expect(plan.asset).toBe("USDC");
    expect(plan.legs[0]).toMatchObject({ side: "Supply", protocol: "Aave" });
  });

  it("still prefers an explicit 'stake' verb over the generic best-yield fallback", () => {
    const plan = parseThesis("stake my ETH for the best yield");
    expect(plan.intent).toBe("stake");
  });

  it("parses a repay intent", () => {
    const plan = parseThesis("repay 2k USDC debt on Aave");
    expect(plan.intent).toBe("repay");
    expect(plan.legs[0].side).toBe("Repay");
  });

  it("parses a withdraw intent, defaulting to Aave", () => {
    const plan = parseThesis("withdraw 3k USDC");
    expect(plan.intent).toBe("withdraw");
    expect(plan.legs[0]).toMatchObject({ side: "Withdraw", protocol: "Aave", sizeUsd: 3000 });
  });

  it("routes a withdraw intent to Lido when named", () => {
    const plan = parseThesis("unstake my ETH from Lido");
    expect(plan.intent).toBe("withdraw");
    expect(plan.legs[0].protocol).toBe("Lido");
  });

  it("routes a withdraw intent to Morpho when named ('redeem')", () => {
    const plan = parseThesis("redeem my USDC from Morpho");
    expect(plan.intent).toBe("withdraw");
    expect(plan.legs[0].protocol).toBe("Morpho");
  });

  it("does not confuse 'unstake' with the unrelated 'stake' intent", () => {
    // \bstake\b must not match inside "unstake".
    expect(parseThesis("unstake my ETH from Lido").intent).toBe("withdraw");
  });
});

describe("tradePlan — parseThesisVariants (risk-tiered alternatives)", () => {
  it("offers all 3 perp venues for a beta-neutral farm, naming the mentioned one first", () => {
    const variants = parseThesisVariants("Farm points on Lighter without directional risk");
    expect(variants).toHaveLength(3);
    expect(variants.map((v) => v.variantLabel)).toEqual(["Lighter", "Extended", "Ondo"]);
    // Every variant is still a full, independently executable plan.
    for (const v of variants) {
      expect(v.legs.map((l) => l.protocol)).toEqual(["Hyperliquid", v.variantLabel]);
      expect(v.variantNote).toBeTruthy();
    }
  });

  it("defaults the beta-neutral venue order to Extended first when none is named", () => {
    const variants = parseThesisVariants("Farm HYPE points without directional risk");
    expect(variants.map((v) => v.variantLabel)).toEqual(["Extended", "Lighter", "Ondo"]);
  });

  it("offers 3 leverage tiers for a directional perp with no explicit leverage", () => {
    const variants = parseThesisVariants("I think SOL outperforms this month");
    expect(variants).toHaveLength(3);
    expect(variants.map((v) => v.variantLabel)).toEqual(["Conservative · 2x", "Balanced · 4x", "Aggressive · 8x"]);
    for (const v of variants) {
      expect(v.legs[0].side).toBe("Long");
      expect(v.legs[0].protocol).toBe("Hyperliquid");
    }
  });

  it("does not offer leverage variants when the thesis already pins an exact leverage", () => {
    const variants = parseThesisVariants("long HYPE 6k leverage 6");
    expect(variants).toHaveLength(1);
    expect(variants[0].variantLabel).toBeUndefined();
    expect(variants[0].leverage).toBe(6);
  });

  it("offers Aave vs Morpho vs Compound for a generic USDC supply thesis, with the live Philidor score deferred to LegRiskBadge rather than an invented number", () => {
    const variants = parseThesisVariants("supply 5k USDC for yield");
    expect(variants).toHaveLength(3);
    expect(variants.map((v) => v.variantLabel)).toEqual(["Aave", "Morpho", "Compound"]);
    for (const v of variants) {
      expect(v.legs[0]).toMatchObject({ side: "Supply", protocol: v.variantLabel });
      expect(v.variantNote).toBeTruthy();
    }
  });

  it("excludes Compound from the supply picker for a non-USDC asset -- it only has a USDC market wired", () => {
    const variants = parseThesisVariants("supply 5k ETH for yield");
    expect(variants.map((v) => v.variantLabel)).toEqual(["Aave", "Morpho"]);
  });

  it("names Morpho first when the thesis asked for it, still offering Aave and Compound as alternatives", () => {
    const variants = parseThesisVariants("supply 5k USDC to Morpho");
    expect(variants.map((v) => v.variantLabel)).toEqual(["Morpho", "Aave", "Compound"]);
  });

  it("names Compound first when the thesis asked for it, for a USDC supply", () => {
    const variants = parseThesisVariants("supply 5k USDC to Compound");
    expect(variants.map((v) => v.variantLabel)).toEqual(["Compound", "Aave", "Morpho"]);
    expect(variants[0].legs[0].protocol).toBe("Compound");
  });

  it("does not offer the supply picker when the thesis named a protocol with no real alternative here", () => {
    const variants = parseThesisVariants("supply 5k USDC to Curve");
    expect(variants).toHaveLength(1);
    expect(variants[0].variantLabel).toBeUndefined();
    expect(variants[0].legs[0].protocol).toBe("Curve");
  });

  it("does not offer Compound as a supply alternative for a non-USDC asset even when named explicitly for a different asset", () => {
    // Compound is only a real option for USDC -- naming it for ETH must route there untouched, not get swapped for Aave/Morpho.
    const variants = parseThesisVariants("supply 5k ETH to Compound");
    expect(variants).toHaveLength(1);
    expect(variants[0].variantLabel).toBeUndefined();
    expect(variants[0].legs[0].protocol).toBe("Compound");
  });

  it("offers Aave vs Compound for a USDC borrow thesis", () => {
    const variants = parseThesisVariants("borrow 10k USDC on Aave");
    expect(variants).toHaveLength(2);
    expect(variants.map((v) => v.variantLabel)).toEqual(["Aave", "Compound"]);
    for (const v of variants) {
      expect(v.legs[0]).toMatchObject({ side: "Borrow", protocol: v.variantLabel });
    }
  });

  it("does not offer a borrow picker for a non-USDC asset -- Compound has no other market wired", () => {
    const variants = parseThesisVariants("borrow 10k ETH on Aave");
    expect(variants).toHaveLength(1);
    expect(variants[0].variantLabel).toBeUndefined();
  });

  it("returns a single, unlabeled variant for intents with no honest alternative to offer", () => {
    const variants = parseThesisVariants("repay 2k USDC debt on Aave");
    expect(variants).toHaveLength(1);
    expect(variants[0]).toEqual(parseThesis("repay 2k USDC debt on Aave"));
  });
});

describe("tradePlan — other intents + robustness", () => {
  it("parses a staking thesis", () => {
    const plan = parseThesis("stake 2 ETH for Lido yield");
    expect(plan.intent).toBe("stake");
    expect(plan.protocol).toBe("Lido");
    expect(plan.asset).toBe("ETH");
  });

  it("never throws and degrades garbage to unknown with actionable summary", () => {
    const plan = parseThesis("");
    expect(plan).toBeDefined();
    expect(plan.intent).toBe("unknown");
    expect(plan.summary).toContain("could not confidently parse");
  });

  it("maps intents back to legacy thread types", () => {
    expect(planToThreadType(parseThesis("long HYPE 6k leverage 6"))).toBe("perp");
    expect(planToThreadType(parseThesis("borrow 10k USDC on Aave"))).toBe("custom");
    expect(planToThreadType(parseThesis("stake 2 ETH"))).toBe("pendle");
  });
});

describe("tradePlan — transfer intent (send X to an address)", () => {
  const ADDR = "0x1234567890123456789012345678901234567890";

  it("parses 'send 0.5 ETH to 0x...' with the EXACT literal amount, not a USD default", () => {
    const plan = parseThesis(`send 0.5 ETH to ${ADDR}`);
    expect(plan.intent).toBe("transfer");
    expect(plan.legs).toHaveLength(1);
    expect(plan.legs[0]).toMatchObject({ side: "Transfer", asset: "ETH", to: ADDR, sizeToken: "0.5" });
    expect(plan.legs[0].sizeUsd).toBeUndefined();
    expect(plan.summary).toContain("0.5 ETH");
    expect(plan.summary).toContain(ADDR);
  });

  it("also recognizes 'transfer' as the verb", () => {
    const plan = parseThesis(`transfer 1000 to ${ADDR}`);
    expect(plan.intent).toBe("transfer");
    expect(plan.legs[0].to).toBe(ADDR);
  });

  it("falls back to a USD default (not a wrong literal amount) when no unit quantity is given", () => {
    const plan = parseThesis(`send ETH to ${ADDR}`);
    expect(plan.intent).toBe("transfer");
    expect(plan.legs[0].sizeToken).toBeUndefined();
    expect(plan.legs[0].sizeUsd).toBe(1000); // DEFAULT_SIZES.transfer
  });

  it("does not misfire without an address present", () => {
    // "send" alone (no 0x address) must not be mistaken for a transfer.
    const plan = parseThesis("I will send more capital into DeFi this month");
    expect(plan.intent).not.toBe("transfer");
  });

  it("maps to the 'custom' legacy thread type", () => {
    expect(planToThreadType(parseThesis(`send 1 ETH to ${ADDR}`))).toBe("custom");
  });
});