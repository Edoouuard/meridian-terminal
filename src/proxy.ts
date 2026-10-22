import { NextResponse, type NextRequest } from "next/server";
import { createRateLimiter, ruleForPath } from "@/lib/rateLimit";
import { BETA_COOKIE, betaPassword, betaToken, safeEqual } from "@/lib/betaGate";

const checkRateLimit = createRateLimiter();

/** Paths reachable without the beta cookie. */
const PUBLIC_PATHS = new Set(["/beta", "/api/beta-login", "/api/bot/tick"]);
/** Server-to-server routes with their own check (a token in the path, a signature): no cookie, no per-IP limit. */
const SERVER_PREFIXES = ["/api/extended-srv/"];

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");

  if (SERVER_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();

  // 1. Rate limit API routes (per IP, per route family).
  if (isApi) {
    const { bucket, rule } = ruleForPath(pathname);
    const rl = checkRateLimit(`${clientIp(req)}:${bucket}`, rule);
    if (!rl.ok) {
      return NextResponse.json(
        { error: "Too many requests — slow down and retry shortly." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
      );
    }
  }

  // 2. Beta gate (only when a password is configured).
  const password = betaPassword();
  if (!password || PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  const cookie = req.cookies.get(BETA_COOKIE)?.value;
  if (cookie && safeEqual(cookie, await betaToken(password))) return NextResponse.next();

  if (isApi) return NextResponse.json({ error: "Beta access required." }, { status: 401 });

  const url = req.nextUrl.clone();
  url.pathname = "/beta";
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next internals and static files (anything with an extension).
  matcher: ["/((?!_next/static|_next/image|.*\\.[a-zA-Z0-9]+$).*)"],
};
