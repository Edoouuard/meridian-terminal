/**
 * betaSeats.ts — how many people can use the terminal during the beta. Each
 * browser that enters the beta password takes a seat, until the limit the
 * owner sets on /admin (else BETA_MAX_SEATS, else 50). Seats live in Redis;
 * the owner can free one (that browser is asked for the password again, and
 * counts as new) or all. Without Redis there is no limit, only the password.
 * Server only.
 */

import { kv, kvConfigured } from "@/lib/server/kv";

const SEATS = "beta:seats";
const LIMIT = "beta:limit";
export const DEFAULT_SEAT_LIMIT = 50;

export interface Seat {
  id: string;
  createdAt: number;
  lastSeen: number;
}

export async function seatLimit(): Promise<number> {
  const raw = kvConfigured() ? await kv<string | null>("GET", LIMIT).catch(() => null) : null;
  // No limit saved yet reads as null, which Number() would turn into 0 seats.
  const stored = raw === null || raw === "" ? NaN : Number(raw);
  if (Number.isInteger(stored) && stored >= 0) return stored;
  const env = Number(process.env.BETA_MAX_SEATS);
  return Number.isInteger(env) && env >= 0 ? env : DEFAULT_SEAT_LIMIT;
}

export const setSeatLimit = (n: number) => kv("SET", LIMIT, String(Math.max(0, Math.floor(n))));

export const seatCount = async () => (kvConfigured() ? Number(await kv<number>("HLEN", SEATS)) : 0);

/**
 * A seat for this browser: the one it already holds, else a new one while
 * seats remain. `full` when the limit is reached.
 */
export async function claimSeat(existing: string | null, now = Date.now()): Promise<{ id: string } | { full: true; limit: number }> {
  if (!kvConfigured()) return { id: existing ?? crypto.randomUUID() };
  if (existing && (await kv<number>("HEXISTS", SEATS, existing))) {
    await kv("HSET", SEATS, existing, JSON.stringify({ ...(await readSeatRow(existing)), lastSeen: now }));
    return { id: existing };
  }
  const limit = await seatLimit();
  if ((await seatCount()) >= limit) return { full: true, limit };
  const id = crypto.randomUUID();
  await kv("HSET", SEATS, id, JSON.stringify({ createdAt: now, lastSeen: now }));
  return { id };
}

async function readSeatRow(id: string): Promise<{ createdAt: number; lastSeen: number }> {
  const raw = await kv<string | null>("HGET", SEATS, id);
  try {
    return raw ? JSON.parse(raw) : { createdAt: Date.now(), lastSeen: Date.now() };
  } catch {
    return { createdAt: Date.now(), lastSeen: Date.now() };
  }
}

/** Seats checked in the last minute, per server instance: a page load doesn't ask Redis every time. */
const checked = new Map<string, { ok: boolean; at: number }>();
const CHECK_TTL_MS = 60_000;

/** Is this seat still held (not freed by the owner)? Records when it was last seen. */
export async function seatActive(id: string, now = Date.now()): Promise<boolean> {
  if (!kvConfigured()) return true;
  const hit = checked.get(id);
  if (hit && now - hit.at < CHECK_TTL_MS) return hit.ok;
  let ok = true;
  try {
    ok = !!(await kv<number>("HEXISTS", SEATS, id));
    if (ok) await kv("HSET", SEATS, id, JSON.stringify({ ...(await readSeatRow(id)), lastSeen: now }));
  } catch {
    // Redis unreachable: let the holder of a valid cookie in rather than lock everyone out.
    ok = true;
  }
  checked.set(id, { ok, at: now });
  return ok;
}

export async function listSeats(): Promise<Seat[]> {
  if (!kvConfigured()) return [];
  const flat = (await kv<string[]>("HGETALL", SEATS)) ?? [];
  const out: Seat[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    try {
      const v = JSON.parse(flat[i + 1]) as { createdAt?: number; lastSeen?: number };
      out.push({ id: flat[i], createdAt: v.createdAt ?? 0, lastSeen: v.lastSeen ?? v.createdAt ?? 0 });
    } catch {
      out.push({ id: flat[i], createdAt: 0, lastSeen: 0 });
    }
  }
  return out.sort((a, b) => b.lastSeen - a.lastSeen);
}

export async function freeSeat(id: string): Promise<void> {
  await kv("HDEL", SEATS, id);
  checked.delete(id);
}

export async function freeAllSeats(): Promise<void> {
  await kv("DEL", SEATS);
  checked.clear();
}
