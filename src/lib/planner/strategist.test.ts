import { describe, expect, it } from "vitest";
import { strategistDoctrine } from "./strategist";

describe("strategist doctrine", () => {
  it("loads, with the rules the planner depends on", () => {
    const md = strategistDoctrine();
    expect(md).toMatch(/^# Meridian Strategist/);
    for (const rule of ["Read the data first", "When to ask a question", "Funding sign", "Two named venues means both", "Cross-venue delta-neutral pair", "Self-check"]) {
      expect(md).toContain(rule);
    }
  });
});
