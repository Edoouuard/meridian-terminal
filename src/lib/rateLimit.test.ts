import { describe, expect, it } from "vitest";
import { createRateLimiter, ruleForPath } from "@/lib/rateLimit";

describe("rateLimit", () => {
  it("allows up to the limit in a window, then blocks with Retry-After", () => {
    let t = 0;
    const check = createRateLimiter(() => t);
    const rule = { limit: 2, windowMs: 60_000 };
    expect(check("ip", rule).ok).toBe(true);
    expect(check("ip", rule)).toMatchObject({ ok: true, remaining: 0 });
    t = 15_000;
    expect(check("ip", rule)).toMatchObject({ ok: false, retryAfter: 45 });
  });

  it("resets after the window and keeps keys independent", () => {
    let t = 0;
    const check = createRateLimiter(() => t);
    const rule = { limit: 1, windowMs: 1000 };
    expect(check("a", rule).ok).toBe(true);
    expect(check("a", rule).ok).toBe(false);
    expect(check("b", rule).ok).toBe(true);
    t = 1000;
    expect(check("a", rule).ok).toBe(true);
  });

  it("picks the route-specific rule by prefix, default otherwise", () => {
    expect(ruleForPath("/api/parse-intent").rule.limit).toBe(10);
    expect(ruleForPath("/api/bridge").bucket).toBe("/api/bridge");
    expect(ruleForPath("/api/bridgex").bucket).toBe("/api");
    expect(ruleForPath("/api/prices").rule.limit).toBe(120);
  });
});
