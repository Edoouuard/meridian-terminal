import { describe, expect, it } from "vitest";
import { strategistDoctrine } from "./strategist";

describe("strategist doctrine", () => {
  it("loads, with the rules the planner depends on", () => {
    const md = strategistDoctrine();
    expect(md).toMatch(/^# Meridian Strategist/);
    for (const rule of [
      "Pipeline (who does what)",
      "Hard constraints and alternatives",
      "There is no fourth branch",
      "never fabricate a size",
      "counted once",
      "**100 ×**",
      "Plan status is not execution state",
      "Stop-loss and take-profit",
      "Ranking is the server's",
      "Never treat the user's acceptance of that change as implicit",
      "Decision tree",
      "Never ask again a question the user already resolved",
      "No number without provenance",
      "Funding sign",
      "annualizedReturnOnCapitalPct",
      "Equal base quantity",
      "partially filled",
      "1 to 3 plans",
      "Never recommend an alternative",
      "Reference cases",
    ]) {
      expect(md).toContain(rule);
    }
  });
});
