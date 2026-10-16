import { describe, expect, it } from "vitest";
import { mergeExplanations, numberIsGrounded, statedNumbers, templateSummary } from "./explain";
import { commonStep, roundDownTo } from "./economics";
import type { PlannerStrategy } from "./schema";

const plan: PlannerStrategy = {
  name: "ETH pair",
  risk: "moderate",
  variantNote: "",
  summary: "model draft",
  kind: "requested",
  status: "executable",
  legs: [{ side: "Short", asset: "ETH-USD", protocol: "Extended", chain: "Arbitrum", sizeUsd: 60, leverage: 1 }],
  economics: {
    capitalCommittedUsd: 117.44,
    annualizedGrossCarryUsd: -1.25,
    entryExitCostUsd: 0.1083,
    holdingDays: 7,
    annualizedReturnOnCapitalPct: -5.87,
    legs: [
      { legIndex: 0, venue: "Extended", market: "ETH-USD", side: "short", baseQuantity: 0.019, referencePriceUsd: 3001, notionalUsd: 57.019, marketFundingAnnualPct: 8.76, legCarryAnnualPct: 8.76, annualizedCarryUsd: 4.99, capitalUsd: 58.73, takerFee: 0.0005 },
    ],
  },
};

describe("explain pass — numbers stay the server's", () => {
  it("reads stated numbers, ignoring small counts", () => {
    expect(statedNumbers("2 legs, $117.44 committed, 1,250 volume")).toEqual([117.44, 1250]);
  });

  it("accepts a known number shown rounded, rejects a new one", () => {
    expect(numberIsGrounded(117.4, [117.44])).toBe(true);
    expect(numberIsGrounded(5.9, [-5.87])).toBe(true);
    expect(numberIsGrounded(12, [117.44])).toBe(false);
  });

  it("keeps grounded text", () => {
    const { plans, rejected } = mergeExplanations([plan], [{ index: 0, summary: "Short 0.019 ETH on Extended earns 8.76%/yr; net -5.87% per year at today's rates on $117.44." }], "volume");
    expect(rejected).toEqual([]);
    expect(plans[0].summary).toMatch(/0\.019 ETH/);
  });

  it("replaces text with an invented number by the deterministic template", () => {
    const { plans, rejected } = mergeExplanations([plan], [{ index: 0, summary: "Earns about 14% a year." }], "volume");
    expect(rejected).toEqual([0]);
    expect(plans[0].summary).toBe(templateSummary(plan));
    expect(plans[0].summary).toMatch(/-5\.87% per year/);
  });

  it("falls back to the template when the explainer didn't answer", () => {
    const { plans, rejected } = mergeExplanations([plan], undefined, "volume");
    expect(rejected).toEqual([]);
    expect(plans[0].summary).toBe(templateSummary(plan));
  });

  it("a blocked plan's template says what blocks it", () => {
    const blocked: PlannerStrategy = { ...plan, status: "blocked", blockers: ["Extended has $0 free (observed)."], economics: undefined };
    expect(templateSummary(blocked)).toMatch(/^Blocked for now: Extended has \$0 free/);
  });
});

describe("quantity steps", () => {
  it("common step is the least common multiple", () => {
    expect(commonStep([0.0001, 0.001])).toBe(0.001);
    expect(commonStep([0.01, 0.025])).toBe(0.05);
    expect(commonStep([1, 0.1])).toBe(1);
  });

  it("rounds down to the step without float noise", () => {
    expect(roundDownTo(0.0199933, 0.001)).toBe(0.019);
    expect(roundDownTo(0.3, 0.1)).toBe(0.3);
  });
});
