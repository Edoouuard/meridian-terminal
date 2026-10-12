import { describe, expect, it } from "vitest";
import { guardrailFromSimulation } from "@/lib/safety";

describe("safety — guardrailFromSimulation", () => {
  it("ignores actions that don't lower the health factor", () => {
    const g = guardrailFromSimulation("supply", { healthFactorBefore: 2, healthFactorAfter: 2.5 });
    expect(g.lowersHealthFactor).toBe(false);
    expect(g.refused).toBe(false);
  });

  it("falls back to an explicit extra confirmation when there is no simulation", () => {
    const g = guardrailFromSimulation("borrow", null);
    expect(g).toMatchObject({ lowersHealthFactor: true, computable: false, needsExplicitConfirmation: true, refused: false });
  });

  it("allows a borrow whose simulated health factor stays above the floor", () => {
    const g = guardrailFromSimulation("borrow", { healthFactorBefore: 2.4, healthFactorAfter: 1.6 });
    expect(g).toMatchObject({ computable: true, estimatedHf: 1.6, refused: false, needsExplicitConfirmation: false });
    expect(g.reason).toContain("2.40 → 1.60");
  });

  it("refuses when the simulated health factor drops below 1.10", () => {
    const g = guardrailFromSimulation("withdraw", { healthFactorBefore: 1.3, healthFactorAfter: 1.05 });
    expect(g).toMatchObject({ computable: true, estimatedHf: 1.05, refused: true });
  });

  it("treats Aave's effectively-infinite / null health factor as 'no debt'", () => {
    const huge = 1.157920892373162e59;
    const g = guardrailFromSimulation("withdraw", { healthFactorBefore: huge, healthFactorAfter: huge });
    expect(g).toMatchObject({ computable: true, estimatedHf: null, refused: false });
    expect(guardrailFromSimulation("withdraw", { healthFactorBefore: null, healthFactorAfter: null }).refused).toBe(false);
  });

  it("shows ∞ for a first borrow from a debt-free position", () => {
    const g = guardrailFromSimulation("borrow", { healthFactorBefore: 1.157920892373162e59, healthFactorAfter: 3.2 });
    expect(g.reason).toContain("∞ → 3.20");
  });
});
