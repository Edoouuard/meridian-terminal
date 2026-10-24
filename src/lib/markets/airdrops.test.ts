import { describe, expect, it } from "vitest";
import { hasEnded, nextDrop, POINTS_PROGRAMS, upcomingPrograms, type PointsProgram } from "./airdrops";

const p = (dropDay: number | null, extra: Partial<PointsProgram> = {}): PointsProgram => ({ venue: "X", program: "X", weeklyPool: "1", dropDay, earns: ["volume"], ...extra });

describe("points calendar", () => {
  const sat = new Date("2026-10-24T12:00:00Z"); // a Saturday

  it("next drop: the coming weekday, at the program's UTC hour", () => {
    expect(nextDrop(p(1, { dropHourUtc: 3 }), sat)!.toISOString()).toBe("2026-10-26T03:00:00.000Z");
    expect(nextDrop(p(6), sat)!.toISOString()).toBe("2026-10-31T00:00:00.000Z"); // today's 00:00 has passed
    expect(nextDrop(p(6, { dropHourUtc: 18 }), sat)!.toISOString()).toBe("2026-10-24T18:00:00.000Z");
    expect(nextDrop(p(null), sat)).toBeNull();
  });

  it("ended seasons drop out; soonest first, no fixed day last", () => {
    expect(hasEnded(p(1, { endsOn: "2026-10-23" }), sat)).toBe(true);
    const list = upcomingPrograms(sat, [p(null, { venue: "A" }), p(5, { venue: "B" }), p(1, { venue: "C" }), p(2, { venue: "D", endsOn: "2026-01-01" })]);
    expect(list.map((x) => x.program.venue)).toEqual(["C", "B", "A"]);
  });

  it("the curated list: unique venues, weekdays 0-6, Meridian's venues flagged", () => {
    const venues = POINTS_PROGRAMS.map((x) => x.venue);
    expect(new Set(venues).size).toBe(venues.length);
    expect(POINTS_PROGRAMS.every((x) => x.dropDay === null || (x.dropDay >= 0 && x.dropDay <= 6))).toBe(true);
    expect(POINTS_PROGRAMS.filter((x) => x.meridian).map((x) => x.venue).sort()).toEqual(["Extended", "TxFlow"]);
  });
});
