import { describe, expect, it } from "vitest";
import { plannerFallbackNotice } from "@/lib/intentEngine";

describe("intentEngine — why the answer is the basic plan", () => {
  it("says what to do for each cause", () => {
    expect(plannerFallbackNotice(Object.assign(new Error("Too many requests"), { status: 429 }))).toMatch(/Wait a minute/);
    expect(plannerFallbackNotice(Object.assign(new Error("Beta access required."), { status: 401 }))).toMatch(/Reload the page/);
    expect(plannerFallbackNotice(new TypeError("Failed to fetch"))).toMatch(/offline/);
    expect(plannerFallbackNotice(Object.assign(new Error("API error 500"), { status: 500 }))).toMatch(/unavailable right now\. Ask/);
    expect(plannerFallbackNotice(Object.assign(new Error("No strategies in response"), { status: 500 }))).toMatch(/unavailable right now \(No strategies in response\)\./);
  });

  it("always says the plan below has no live rates", () => {
    expect(plannerFallbackNotice(new Error("No strategies returned"))).toMatch(/without live rates/);
  });
});
