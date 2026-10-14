import { describe, expect, it } from "vitest";
import { TOUR_STEPS, placeTooltip } from "@/components/ProductTour";

const vp = { width: 1440, height: 900 };
const card = { width: 340, height: 190 };

describe("product tour", () => {
  it("opens with a welcome and ends on the replay hint", () => {
    expect(TOUR_STEPS[0].target).toBeUndefined();
    expect(TOUR_STEPS.at(-1)?.body).toMatch(/Tour/);
  });

  it("places the card below the target when it fits, else above, always inside the viewport", () => {
    expect(placeTooltip({ top: 100, left: 20, width: 260, height: 120 }, vp, card)).toEqual({ top: 232, left: 12 });
    const near = placeTooltip({ top: 780, left: 600, width: 500, height: 60 }, vp, card);
    expect(near.top).toBe(780 - 12 - 190);
    const right = placeTooltip({ top: 10, left: 1400, width: 40, height: 20 }, vp, card);
    expect(right.left).toBe(1440 - 340 - 12);
  });

  it("centres the card when there is nothing to highlight", () => {
    expect(placeTooltip(null, vp, card)).toEqual({ top: 355, left: 550 });
  });
});
