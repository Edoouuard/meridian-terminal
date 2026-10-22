import { describe, expect, it } from "vitest";
import { dayEstimate, feesPer10kUsd, INTENSITY, intensityOf, maxPerSideUsd } from "@/lib/neutralBot/guide";

describe("intensityOf", () => {
  it("names the preset a schedule matches", () => {
    expect(intensityOf(INTENSITY.calm)).toBe("calm");
    expect(intensityOf(INTENSITY.intense)).toBe("intense");
  });
  it("returns null for a hand-tuned schedule", () => {
    expect(intensityOf({ ...INTENSITY.normal, holdMaxMinutes: 121 })).toBeNull();
  });
});

describe("dayEstimate", () => {
  // Normal: 82.5 min held + 11 min apart on average = 93.5 min a cycle.
  const cfg = { ...INTENSITY.normal, notionalUsd: 100, maxFeesUsd: 0, maxCycles: 0 };
  it("counts four legs of volume per cycle and both venues' taker fees", () => {
    const d = dayEstimate(cfg, [0.00045, 0.00025]);
    expect(d.cyclesPerDay).toBeCloseTo(1440 / 93.5, 6);
    expect(d.volumeUsd).toBeCloseTo((1440 / 93.5) * 400, 6);
    expect(d.feesUsd).toBeCloseTo((1440 / 93.5) * 2 * 100 * 0.0007, 6);
    expect(d.stopsAfterHours).toBeNull();
  });
  it("stops at the fee budget when it comes within the day", () => {
    // $0.14 a cycle: $1 of budget lasts 7.14 cycles.
    const d = dayEstimate({ ...cfg, maxFeesUsd: 1 }, [0.00045, 0.00025]);
    expect(d.feesUsd).toBeCloseTo(1, 6);
    expect(d.stopsAfterHours).toBeCloseTo(((1 / 0.14) * 93.5) / 60, 6);
  });
  it("stops at the cycle cap", () => {
    const d = dayEstimate({ ...cfg, maxCycles: 3 }, [0.00045, 0.00025]);
    expect(d.volumeUsd).toBe(1200);
    expect(d.stopsAfterHours).toBeCloseTo((3 * 93.5) / 60, 6);
  });
});

describe("maxPerSideUsd", () => {
  it("is the thinner venue's margin times leverage, less 2%", () => {
    expect(maxPerSideUsd(30, 12, 3)).toBe(35);
    expect(maxPerSideUsd(0, 50, 5)).toBe(0);
  });
});

describe("feesPer10kUsd", () => {
  it("spreads a round trip over the four legs of a cycle", () => {
    expect(feesPer10kUsd(0.14)).toBeCloseTo(3.5, 9);
  });
});
