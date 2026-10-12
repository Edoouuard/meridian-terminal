/**
 * Beta access gate. Active only when BETA_PASSWORD (or the legacy
 * NEXT_PUBLIC_BETA_PASSWORD) is set. The cookie holds a SHA-256 of the
 * password, never the password itself; Web Crypto so it runs in the proxy.
 */

export const BETA_COOKIE = "meridian_beta";
export const BETA_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export function betaPassword(): string | null {
  const pw = process.env.BETA_PASSWORD || process.env.NEXT_PUBLIC_BETA_PASSWORD;
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
