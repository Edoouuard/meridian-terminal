import { afterEach, describe, expect, it, vi } from "vitest";
import { readSeat, seatCookie } from "@/lib/betaGate";

describe("beta seat cookie", () => {
  it("reads back the seat it was issued for, under the same password only", async () => {
    const c = await seatCookie("3f2a9c1e-0000-4000-8000-000000000001", "Meridian2026!");
    expect(await readSeat(c, "Meridian2026!")).toBe("3f2a9c1e-0000-4000-8000-000000000001");
    expect(await readSeat(c, "another password")).toBeNull();
    expect(await readSeat(c.replace(/.$/, (ch) => (ch === "0" ? "1" : "0")), "Meridian2026!")).toBeNull();
    expect(await readSeat(undefined, "Meridian2026!")).toBeNull();
    // The old cookie (a bare hash of the password) is no longer a seat.
    expect(await readSeat("a".repeat(64), "Meridian2026!")).toBeNull();
  });
});

describe("beta seats", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/server/kv");
  });

  async function withRedis() {
    const hash = new Map<string, string>();
    let limit: string | null = null;
    vi.doMock("@/lib/server/kv", () => ({
      kvConfigured: () => true,
      kv: async (cmd: string, key: string, field?: string, value?: string) => {
        if (cmd === "GET") return limit;
        if (cmd === "SET") return (limit = field ?? null), "OK";
        if (cmd === "HLEN") return hash.size;
        if (cmd === "HEXISTS") return hash.has(field!) ? 1 : 0;
        if (cmd === "HGET") return hash.get(field!) ?? null;
        if (cmd === "HSET") return hash.set(field!, value!), 1;
        if (cmd === "HDEL") return hash.delete(field!) ? 1 : 0;
        if (cmd === "HGETALL") return [...hash].flat();
        if (cmd === "DEL") return hash.clear(), 1;
        throw new Error(`unexpected ${cmd} ${key}`);
      },
    }));
    return import("@/lib/server/betaSeats");
  }

  it("lets people in until the limit, keeps a returning browser's seat, refuses the next one", async () => {
    const seats = await withRedis();
    await seats.setSeatLimit(2);
    const a = await seats.claimSeat(null);
    const b = await seats.claimSeat(null);
    expect("id" in a && "id" in b).toBe(true);
    expect(await seats.claimSeat(null)).toEqual({ full: true, limit: 2 });
    // Someone already in comes back: same seat, not a new one.
    expect(await seats.claimSeat("id" in a ? a.id : null)).toEqual(a);
    expect(await seats.seatCount()).toBe(2);
  });

  it("frees a seat: that browser is out, and the place goes to the next person", async () => {
    const seats = await withRedis();
    await seats.setSeatLimit(1);
    const a = await seats.claimSeat(null);
    const id = "id" in a ? a.id : "";
    expect(await seats.seatActive(id)).toBe(true);
    await seats.freeSeat(id);
    expect(await seats.seatActive(id, Date.now() + 61_000)).toBe(false);
    expect("id" in (await seats.claimSeat(null))).toBe(true);
  });

  it("defaults to 50 seats, or BETA_MAX_SEATS", async () => {
    const seats = await withRedis();
    expect(await seats.seatLimit()).toBe(50);
    vi.stubEnv("BETA_MAX_SEATS", "30");
    expect(await seats.seatLimit()).toBe(30);
    vi.unstubAllEnvs();
  });
});
