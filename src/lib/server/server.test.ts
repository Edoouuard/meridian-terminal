import { describe, expect, it } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { boxProblem, open, seal } from "@/lib/server/secretBox";
import { verifyQstash } from "@/lib/server/qstash";
import { botActionMessage, verifyBotAction } from "@/lib/neutralBot/serverBot";

const KEY = "k".repeat(40);
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function qstashJwt(body: string, signingKey: string, claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const p = b64url(Buffer.from(JSON.stringify({ iss: "Upstash", sub: "https://meridian.app/api/bot/tick", exp: now + 300, nbf: now, body: b64url(createHash("sha256").update(body).digest()), ...claims })));
  const s = b64url(createHmac("sha256", signingKey).update(`${h}.${p}`).digest());
  return `${h}.${p}.${s}`;
}

describe("sealed keys", () => {
  it("round-trips, and fails on another key or a tampered box", () => {
    const box = seal('{"hlAgentKey":"0xabc"}', KEY);
    expect(box).not.toContain("0xabc");
    expect(open(box, KEY)).toBe('{"hlAgentKey":"0xabc"}');
    expect(() => open(box, "x".repeat(40))).toThrow();
    const parts = box.split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => open(parts.join(":"), KEY)).toThrow();
    expect(() => seal("x", "short")).toThrow(/BOT_ENCRYPTION_KEY/);
  });
});

describe("QStash signature", () => {
  it("accepts QStash's call for this body, with the current or next key", () => {
    expect(verifyQstash(qstashJwt("{}", "cur"), "{}", ["cur", "next"])).toBe(true);
    expect(verifyQstash(qstashJwt("{}", "next"), "{}", ["cur", "next"])).toBe(true);
  });
  it("refuses another key, another body, an expired call, another destination, or none", () => {
    expect(verifyQstash(qstashJwt("{}", "evil"), "{}", ["cur", "next"])).toBe(false);
    expect(verifyQstash(qstashJwt("{}", "cur"), '{"x":1}', ["cur"])).toBe(false);
    expect(verifyQstash(qstashJwt("{}", "cur", { exp: 1 }), "{}", ["cur"])).toBe(false);
    expect(verifyQstash(qstashJwt("{}", "cur", { sub: "https://evil.app/other" }), "{}", ["cur"])).toBe(false);
    expect(verifyQstash(null, "{}", ["cur"])).toBe(false);
  });
});

describe("bot actions signed by the wallet", () => {
  const acct = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  it("verifies the owner's signature for that action, within five minutes", async () => {
    const ts = Date.now();
    const sig = await acct.signMessage({ message: botActionMessage("start", acct.address, ts) });
    expect(await verifyBotAction("start", acct.address, ts, sig)).toBe(true);
    // Another action, another wallet, or a stale signature: refused.
    expect(await verifyBotAction("close", acct.address, ts, sig)).toBe(false);
    expect(await verifyBotAction("start", "0x0000000000000000000000000000000000000001", ts, sig)).toBe(false);
    expect(await verifyBotAction("start", acct.address, ts, sig, ts + 6 * 60_000)).toBe(false);
  });
});

describe("BOT_ENCRYPTION_KEY setup message", () => {
  it("says whether the key is missing or too short, never its value", () => {
    const prev = process.env.BOT_ENCRYPTION_KEY;
    try {
      delete process.env.BOT_ENCRYPTION_KEY;
      expect(boxProblem()).toMatch(/isn't set/);
      process.env.BOT_ENCRYPTION_KEY = "openssl rand -base64 48";
      const msg = boxProblem() ?? "";
      expect(msg).toMatch(/only 23 characters/);
      expect(msg).not.toContain("openssl");
      process.env.BOT_ENCRYPTION_KEY = "x".repeat(40);
      expect(boxProblem()).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.BOT_ENCRYPTION_KEY;
      else process.env.BOT_ENCRYPTION_KEY = prev;
    }
  });
});
