import { createHash } from "crypto";
import { NextResponse } from "next/server";
import { put } from "@vercel/blob";

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const ref = typeof body?.ref === "string" && /^[0-9a-f]{6,20}$/i.test(body.ref) ? body.ref.toLowerCase() : undefined;

  if (!isValidEmail(email) || email.length > 254) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  const hash = createHash("sha256").update(email).digest("hex");

  await put(`waitlist/${hash}.json`, JSON.stringify({ email, joinedAt: new Date().toISOString(), ref }), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });

  return NextResponse.json({ ok: true, ref });
}
