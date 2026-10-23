/**
 * secretBox.ts — authenticated encryption (AES-256-GCM) for the trading keys
 * the server bot holds, under BOT_ENCRYPTION_KEY (any long random string;
 * hashed to 32 bytes). The key never leaves the server's environment; Redis
 * only ever sees ciphertext. Server only.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const secret = () => process.env.BOT_ENCRYPTION_KEY ?? "";
export const boxConfigured = () => secret().length >= 32;

const keyOf = (s: string) => createHash("sha256").update(s).digest();

export function seal(plain: string, s = secret()): string {
  if (s.length < 32) throw new Error("BOT_ENCRYPTION_KEY isn't set on the server (32+ characters).");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyOf(s), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export function open(box: string, s = secret()): string {
  const [v, iv, tag, data] = box.split(":");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Unreadable sealed value.");
  const d = createDecipheriv("aes-256-gcm", keyOf(s), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}
