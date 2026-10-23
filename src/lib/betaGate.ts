/**
 * Beta access gate. Active only when BETA_PASSWORD is set (server-only: a
 * NEXT_PUBLIC_ variable would be inlined into browser bundles). Each browser
 * that enters the password takes one seat (lib/server/betaSeats.ts): its
 * cookie is "<seat id>.<HMAC of the id under the password>", so the proxy
 * checks it without storing the password anywhere. Web Crypto, so it runs in
 * the proxy.
 */

export const BETA_COOKIE = "meridian_beta";
export const BETA_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export function betaPassword(): string | null {
  const pw = process.env.BETA_PASSWORD;
  return pw && pw.trim() ? pw : null;
}

export async function betaToken(password: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`meridian-beta:${password}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Only same-site relative paths are allowed as post-login redirects. */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}

async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(`meridian-beta:${key}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The cookie value for a seat. */
export async function seatCookie(seatId: string, password: string): Promise<string> {
  return `${seatId}.${await hmacHex(password, seatId)}`;
}

/** The seat a cookie holds, or null when it wasn't issued under this password. */
export async function readSeat(cookie: string | undefined, password: string): Promise<string | null> {
  const dot = cookie?.lastIndexOf(".") ?? -1;
  if (!cookie || dot <= 0) return null;
  const id = cookie.slice(0, dot);
  return /^[A-Za-z0-9-]{8,64}$/.test(id) && safeEqual(cookie.slice(dot + 1), await hmacHex(password, id)) ? id : null;
}

/** Where the owner's landing page lives: its early-access form posts here, and a refusal goes back there. */
export function landingUrl(): string {
  return (process.env.LANDING_URL || "https://meridian-gate-seven.vercel.app").replace(/\/+$/, "");
}
