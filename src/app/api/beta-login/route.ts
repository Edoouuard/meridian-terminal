import { NextResponse, type NextRequest } from "next/server";
import { BETA_COOKIE, BETA_COOKIE_MAX_AGE, betaPassword, betaToken, landingUrl, readSeat, safeEqual, safeNextPath, seatCookie } from "@/lib/betaGate";
import { claimSeat } from "@/lib/server/betaSeats";

/**
 * POST /api/beta-login — the beta password, from the terminal's /beta page or
 * from the landing page's early-access form (`from=landing`). A right
 * password takes a seat (or keeps this browser's) and opens the terminal; a
 * wrong one, or no seat left, goes back where it came from with the reason.
 */
export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const submitted = String(form?.get("password") ?? "");
  const next = safeNextPath(String(form?.get("next") ?? "/"));
  const fromLanding = String(form?.get("from") ?? "") === "landing";
  const password = betaPassword();

  if (!password) return NextResponse.redirect(new URL(next, req.url), 303);

  const refuse = (reason: "wrong" | "full") => {
    if (fromLanding) return NextResponse.redirect(`${landingUrl()}/?access=${reason}#early-access`, 303);
    const back = new URL("/beta", req.url);
    back.searchParams.set("next", next);
    back.searchParams.set("error", reason);
    return NextResponse.redirect(back, 303);
  };

  const ok = submitted.length > 0 && safeEqual(await betaToken(submitted), await betaToken(password));
  if (!ok) return refuse("wrong");

  const seat = await claimSeat(await readSeat(req.cookies.get(BETA_COOKIE)?.value, password)).catch((err) => {
    console.error("[beta-login] seat check failed:", err instanceof Error ? err.message : err);
    return { id: crypto.randomUUID() };
  });
  if ("full" in seat) return refuse("full");

  const res = NextResponse.redirect(new URL(next, req.url), 303);
  res.cookies.set(BETA_COOKIE, await seatCookie(seat.id, password), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: BETA_COOKIE_MAX_AGE,
  });
  return res;
}
