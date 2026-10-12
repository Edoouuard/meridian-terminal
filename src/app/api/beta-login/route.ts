import { NextResponse, type NextRequest } from "next/server";
import { BETA_COOKIE, BETA_COOKIE_MAX_AGE, betaPassword, betaToken, safeEqual, safeNextPath } from "@/lib/betaGate";

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const submitted = String(form?.get("password") ?? "");
  const next = safeNextPath(String(form?.get("next") ?? "/"));
  const password = betaPassword();

  if (!password) return NextResponse.redirect(new URL(next, req.url), 303);

  const ok = submitted.length > 0 && safeEqual(await betaToken(submitted), await betaToken(password));
  if (!ok) {
    const back = new URL("/beta", req.url);
    back.searchParams.set("next", next);
    back.searchParams.set("error", "1");
    return NextResponse.redirect(back, 303);
  }

  const res = NextResponse.redirect(new URL(next, req.url), 303);
  res.cookies.set(BETA_COOKIE, await betaToken(password), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: BETA_COOKIE_MAX_AGE,
  });
  return res;
}
