import { describe, expect, it } from "vitest";
import { parseThesis, planToThreadType } from "@/lib/tradePlan";

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

  it("parses a repay intent", () => {
    const plan = parseThesis("repay 2k USDC debt on Aave");
    expect(plan.intent).toBe("repay");
    expect(plan.legs[0].side).toBe("Repay");
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