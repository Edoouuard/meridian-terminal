/**
 * Fixed-window rate limiter (in-memory).
 *
 * Runs in the proxy, so the counters live per server instance: this is a
 * best-effort brake against bursts and runaway clients, not a global quota.
 * For strict limits use Vercel WAF rate-limit rules or a shared store.
 */

export interface RateLimitRule {
  /** Max requests per window. */
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  /** Seconds until the current window resets. */
  retryAfter: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const MAX_BUCKETS = 10_000;

export function createRateLimiter(now: () => number = Date.now) {
  const buckets = new Map<string, Bucket>();

  function sweep(t: number) {
    for (const [key, b] of buckets) if (b.resetAt <= t) buckets.delete(key);
  }

  return function check(key: string, rule: RateLimitRule): RateLimitResult {
    const t = now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= t) {
      if (buckets.size >= MAX_BUCKETS) sweep(t);
      b = { count: 0, resetAt: t + rule.windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    const retryAfter = Math.max(1, Math.ceil((b.resetAt - t) / 1000));
    return { ok: b.count <= rule.limit, remaining: Math.max(0, rule.limit - b.count), retryAfter };
  };
}

const MINUTE = 60_000;

/** Per-route limits for /api/*, most specific prefix first. */
export const API_RATE_LIMITS: Array<[prefix: string, rule: RateLimitRule]> = [
  ["/api/parse-intent", { limit: 10, windowMs: MINUTE }], // LLM call (paid)
  ["/api/beta-login", { limit: 10, windowMs: MINUTE }], // password guessing
  ["/api/bridge", { limit: 30, windowMs: MINUTE }],
  ["/api/route-quote", { limit: 30, windowMs: MINUTE }],
  ["/api/pendle", { limit: 30, windowMs: MINUTE }],
  ["/api/exec-log", { limit: 30, windowMs: MINUTE }], // execution journal (one call per outcome)
  ["/api/preview-action", { limit: 30, windowMs: MINUTE }],
  ["/api/feedback", { limit: 5, windowMs: MINUTE }], // bug reports
];

export const DEFAULT_API_RATE_LIMIT: RateLimitRule = { limit: 120, windowMs: MINUTE };

export function ruleForPath(pathname: string): { bucket: string; rule: RateLimitRule } {
  for (const [prefix, rule] of API_RATE_LIMITS) {
    if (pathname === prefix || pathname.startsWith(prefix + "/")) return { bucket: prefix, rule };
  }
  return { bucket: "/api", rule: DEFAULT_API_RATE_LIMIT };
}
