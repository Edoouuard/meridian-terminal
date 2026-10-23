/**
 * relayToken.ts — the path token of the server's own Extended relay
 * (/api/extended-srv/<token>/…), derived from BOT_ENCRYPTION_KEY so there is
 * no extra secret to set. Server only.
 */
import { createHash } from "node:crypto";

export function serverRelayToken(): string | null {
  const k = process.env.BOT_ENCRYPTION_KEY ?? "";
  return k.length >= 32 ? createHash("sha256").update(`meridian-extended-relay:${k}`).digest("hex").slice(0, 40) : null;
}
