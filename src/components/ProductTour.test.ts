import { describe, expect, it } from "vitest";
import { TOUR_DONE_KEY, TOUR_PROMPTS, TOUR_STEPS, WELCOME_DISCONNECTED, placeTooltip, tourSeen, tourSteps } from "@/components/ProductTour";

const vp = { width: 1440, height: 900 };
const card = { width: 340, height: 190 };

describe("product tour", () => {
  it("opens with a welcome and ends on strategies to try now, with the replay hint", () => {
    expect(TOUR_STEPS[0].target).toBeUndefined();
    const last = TOUR_STEPS.at(-1)!;
    expect(last.title).toBe("Try a strategy now");
    expect(last.prompts?.length).toBeGreaterThan(0);
    expect(last.body).toMatch(/Tour/);
    expect(TOUR_STEPS.filter((s) => s.prompts)).toHaveLength(1);
  });

  it("with perps: shows Extended (opening Perps → Accounts) and every use-case prompt", () => {
    const steps = tourSteps(true);
    const ext = steps.find((s) => s.target === "extended");
    expect(ext?.tab).toBe("perps-accounts");
    expect(ext?.body).toMatch(/three signatures/);
    // The prerequisites the owner hit: an account opened on extended.exchange with the same wallet, and a balance.
    expect(ext?.body).toMatch(/extended\.exchange with this same wallet/);
    expect(ext?.body).toMatch(/fund it with USDC/);
    expect(steps.at(-1)?.prompts).toEqual(TOUR_PROMPTS);
    expect(TOUR_PROMPTS.map((p) => p.prompt)).toContain("Short AMD on Extended");
  });

  it("without perps: no Extended step and only spot prompts", () => {
    const steps = tourSteps(false);
    expect(steps.some((s) => s.target === "extended")).toBe(false);
    const prompts = steps.find((s) => s.prompts)?.prompts ?? [];
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.every((p) => !p.perps)).toBe(true);
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
  it("keeps a card taller than the screen (the last step) fully on screen, its buttons included", () => {
    const small = { width: 1280, height: 640 };
    const tall = { width: 420, height: 900 };
    expect(placeTooltip(null, small, tall).top).toBe(12);
    // Anchored low on the page: it still starts at the top margin rather than running off the bottom.
    expect(placeTooltip({ top: 560, left: 200, width: 400, height: 50 }, small, tall).top).toBe(12);
  });

  it("welcomes a visitor without a wallet without claiming one is connected", () => {
    expect(TOUR_STEPS[0].body).toMatch(/wallet is connected/);
    expect(WELCOME_DISCONNECTED).not.toMatch(/is connected/);
    expect(WELCOME_DISCONNECTED).toMatch(/Connect a wallet/);
  });
});

describe("when the tour starts on its own", () => {
  const store = (items: Record<string, string>) => ({ getItem: (k: string) => items[k] ?? null });

  it("without a wallet: once per browser", () => {
    expect(tourSeen(store({}), undefined)).toBe(false);
    expect(tourSeen(store({ [TOUR_DONE_KEY]: "1" }), undefined)).toBe(true);
  });

  it("a wallet connecting for the first time gets it, even after the tour was skipped without a wallet", () => {
    const s = store({ [TOUR_DONE_KEY]: "1", "meridian:tourWallets:v1": JSON.stringify(["0xabc"]) });
    expect(tourSeen(s, "0xDEF")).toBe(false);
    expect(tourSeen(s, "0xABC")).toBe(true);
  });
});
