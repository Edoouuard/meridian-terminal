/**
 * kv.ts — the few Redis commands the server bot needs, over Upstash's REST
 * API (no client library): the Vercel Marketplace's Upstash Redis sets
 * KV_REST_API_URL / KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL / _TOKEN).
 * Server only.
 */

const url = () => process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? "";
const token = () => process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? "";

export const kvConfigured = () => !!url() && !!token();

export async function kv<T = unknown>(...command: (string | number)[]): Promise<T> {
  if (!kvConfigured()) throw new Error("Redis isn't configured on the server (KV_REST_API_URL / KV_REST_API_TOKEN).");
  const res = await fetch(url(), { method: "POST", headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" }, body: JSON.stringify(command), cache: "no-store" });
  const body = (await res.json().catch(() => null)) as { result?: T; error?: string } | null;
  if (!res.ok || body?.error) throw new Error(`Redis: ${body?.error ?? `HTTP ${res.status}`}`);
  return body?.result as T;
}

export async function kvGetJson<T>(key: string): Promise<T | null> {
  const raw = await kv<string | null>("GET", key);
  return raw ? (JSON.parse(raw) as T) : null;
}

export const kvSetJson = (key: string, value: unknown) => kv("SET", key, JSON.stringify(value));

/** A lock held `seconds` at most; true when this caller took it. */
export async function kvLock(key: string, seconds: number): Promise<boolean> {
  return (await kv<string | null>("SET", key, "1", "NX", "EX", seconds)) === "OK";
}
