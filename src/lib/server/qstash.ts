/**
 * qstash.ts — the minute-by-minute trigger of the server bot: Upstash QStash
 * calls POST /api/bot/tick every minute (a schedule this module creates,
 * idempotently, the first time a bot is started on the server), and every
 * call is checked against QStash's signing keys before anything runs.
 * Server only.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const QSTASH_SCHEDULE_ID = "meridian-neutral-bot";
export const qstashConfigured = () => !!process.env.QSTASH_TOKEN && !!process.env.QSTASH_CURRENT_SIGNING_KEY;

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * True when `jwt` (the Upstash-Signature header) is QStash's, for this body,
 * still valid, signed with the current or the next signing key.
 */
export function verifyQstash(jwt: string | null, rawBody: string, keys = [process.env.QSTASH_CURRENT_SIGNING_KEY, process.env.QSTASH_NEXT_SIGNING_KEY], now = Date.now()): boolean {
  if (!jwt) return false;
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  const [h, p, sig] = parts;
  const signed = keys.some((k) => {
    if (!k) return false;
    const expected = Buffer.from(b64url(createHmac("sha256", k).update(`${h}.${p}`).digest()));
    const got = Buffer.from(sig.replace(/=+$/, ""));
    return expected.length === got.length && timingSafeEqual(expected, got);
  });
  if (!signed) return false;
  let claims: { iss?: string; exp?: number; nbf?: number; body?: string; sub?: string };
  try {
    claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  const t = Math.floor(now / 1000);
  if (claims.iss !== "Upstash") return false;
  if (typeof claims.exp === "number" && t > claims.exp + 60) return false;
  if (typeof claims.nbf === "number" && t < claims.nbf - 60) return false;
  if (!claims.sub?.endsWith("/api/bot/tick")) return false;
  const bodyHash = b64url(createHash("sha256").update(rawBody).digest());
  return (claims.body ?? "").replace(/=+$/, "") === bodyHash;
}

/** Creates (or updates) the every-minute schedule that calls `destination`. */
export async function ensureTickSchedule(destination: string): Promise<{ ok: boolean; error?: string }> {
  if (!process.env.QSTASH_TOKEN) return { ok: false, error: "QSTASH_TOKEN isn't set on the server." };
  const base = process.env.QSTASH_URL ?? "https://qstash.upstash.io";
  const res = await fetch(`${base}/v2/schedules/${destination}`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.QSTASH_TOKEN}`, "Upstash-Cron": "* * * * *", "Upstash-Schedule-Id": QSTASH_SCHEDULE_ID, "Upstash-Method": "POST", "content-type": "application/json" },
    body: "{}",
  }).catch((e: unknown) => ({ ok: false, status: 0, text: async () => String(e) }) as const);
  return res.ok ? { ok: true } : { ok: false, error: `QStash: ${res.status} ${(await res.text()).slice(0, 200)}` };
}
