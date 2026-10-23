import { NextResponse, type NextRequest } from "next/server";
import { safeEqual, seatCookie, readSeat } from "@/lib/betaGate";
import { kvConfigured } from "@/lib/server/kv";
import { freeAllSeats, freeSeat, listSeats, seatLimit, setSeatLimit } from "@/lib/server/betaSeats";

/**
 * /api/beta-admin — the owner's controls for early access: how many seats,
 * who holds one, free one or all. Guarded by BETA_ADMIN_PASSWORD (its own
 * cookie, never the testers' password).
 * GET → { limit, used, seats } · POST { action: login | logout | limit | free | freeAll }
 */
export const dynamic = "force-dynamic";

const ADMIN_COOKIE = "meridian_admin";
const ADMIN_ID = "owner-admin";
const adminPassword = () => {
  const pw = process.env.BETA_ADMIN_PASSWORD;
  return pw && pw.trim() ? pw : null;
};

async function isAdmin(req: NextRequest): Promise<boolean> {
  const pw = adminPassword();
  return !!pw && (await readSeat(req.cookies.get(ADMIN_COOKIE)?.value, `admin:${pw}`)) === ADMIN_ID;
}

const state = async () => {
  const seats = await listSeats();
  return { configured: true, storage: kvConfigured(), limit: await seatLimit(), used: seats.length, seats };
};

export async function GET(req: NextRequest) {
  if (!adminPassword()) return NextResponse.json({ configured: false });
  if (!(await isAdmin(req))) return NextResponse.json({ configured: true, signedIn: false }, { status: 401 });
  return NextResponse.json({ signedIn: true, ...(await state()) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const pw = adminPassword();
  if (!pw) return NextResponse.json({ error: "Admin isn't set up." }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { action?: string; password?: string; value?: number; id?: string };

  if (body.action === "login") {
    if (!body.password || !safeEqual(body.password, pw)) return NextResponse.json({ error: "Wrong admin password." }, { status: 401 });
    const res = NextResponse.json({ signedIn: true, ...(await state()) });
    res.cookies.set(ADMIN_COOKIE, await seatCookie(ADMIN_ID, `admin:${pw}`), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: 60 * 60 * 12 });
    return res;
  }
  if (!(await isAdmin(req))) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (body.action === "logout") {
    const res = NextResponse.json({ signedIn: false });
    res.cookies.delete(ADMIN_COOKIE);
    return res;
  }
  if (!kvConfigured()) return NextResponse.json({ error: "Seats need Upstash Redis on the server." }, { status: 400 });
  if (body.action === "limit") {
    const n = Number(body.value);
    if (!Number.isInteger(n) || n < 0 || n > 100_000) return NextResponse.json({ error: "Pick a whole number of seats." }, { status: 400 });
    await setSeatLimit(n);
  } else if (body.action === "free" && body.id) {
    await freeSeat(body.id);
  } else if (body.action === "freeAll") {
    await freeAllSeats();
  } else {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
  return NextResponse.json({ signedIn: true, ...(await state()) });
}
