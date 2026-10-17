import { describe, expect, it, vi } from "vitest";
import type { Extended, Signer } from "@blackcube/extended-sdk";
import {
  executeExtendedPerp,
  formatDecimal,
  parseExtendedMarket,
  roundPriceToTick,
  roundQtyToStep,
  toExtendedMarket,
  worstCasePrice,
} from "@/lib/integrations/extended-live";

describe("extended-live — toExtendedMarket", () => {
  it("hyphenates a bare symbol against USD", () => {
    expect(toExtendedMarket("SOL")).toBe("SOL-USD");
  });

  it("strips a PERP suffix before hyphenating", () => {
    expect(toExtendedMarket("ETH-PERP")).toBe("ETH-USD");
  });

  it("is idempotent on an already-hyphenated market", () => {
    expect(toExtendedMarket("BTC-USD")).toBe("BTC-USD");
  });

  it("uppercases a lowercase symbol", () => {
    expect(toExtendedMarket("hype")).toBe("HYPE-USD");
  });
});

describe("extended-live — formatDecimal", () => {
  it("formats a plain fractional quantity without scientific notation", () => {
    expect(formatDecimal(0.00001234)).toBe("0.00001234");
  });

  it("trims trailing zeros", () => {
    expect(formatDecimal(1.5)).toBe("1.5");
  });

  it("trims a whole number down to no decimal point", () => {
    expect(formatDecimal(10)).toBe("10");
  });

  it("refuses a non-positive quantity", () => {
    expect(formatDecimal(0)).toBe("0");
    expect(formatDecimal(-5)).toBe("0");
    expect(formatDecimal(NaN)).toBe("0");
  });
});

describe("extended-live — worstCasePrice", () => {
  it("shifts a buy's worst price up", () => {
    expect(worstCasePrice(100, true, 100)).toBeCloseTo(101, 6);
  });

  it("shifts a sell's worst price down", () => {
    expect(worstCasePrice(100, false, 100)).toBeCloseTo(99, 6);
  });

  it("defaults to a 1% (100bps) buffer", () => {
    expect(worstCasePrice(2000, true)).toBeCloseTo(2020, 6);
  });
});


// Shape of GET /api/v1/info/markets?market=ETH-USD on mainnet (2026-10-16).
const ETH_MARKET = {
  name: "ETH-USD",
  active: true,
  status: "ACTIVE",
  marketStats: { markPrice: "2470.282764024999", fundingRate: "0.000013" },
  tradingConfig: { minOrderSize: "0.01", minOrderSizeChange: "0.001", minPriceChange: "0.1", maxLeverage: "50.00" },
};

describe("extended-live — market rules", () => {
  it("parses mark, step, tick, minimum and hourly funding", () => {
    expect(parseExtendedMarket(ETH_MARKET)).toEqual({
      name: "ETH-USD",
      mark: 2470.282764024999,
      step: 0.001,
      tick: 0.1,
      minQty: 0.01,
      maxLeverage: 50,
      fundingHourly: 0.000013,
      active: true,
    });
    expect(parseExtendedMarket({ name: "X-USD" })).toBeNull();
  });

  it("rounds quantity down to the step and the price away from the mark", () => {
    expect(roundQtyToStep(0.0543219, 0.001)).toBe("0.054");
    expect(roundQtyToStep(10, 1)).toBe("10");
    expect(roundPriceToTick(2494.98, 0.1, true)).toBe("2495.0");
    expect(roundPriceToTick(2445.58, 0.1, false)).toBe("2445.5");
    expect(roundPriceToTick(0.123456, 0.0001, true)).toBe("0.1235");
  });
});

describe("extended-live — executeExtendedPerp", () => {
  const signer: Signer = { apiKey: "k", l2PrivateKey: "0x1", l2PublicKey: "0x2", vaultId: "7", network: "mainnet" };
  const setup = (orderState: Record<string, string>) => {
    const placed: unknown[] = [];
    const leverage: unknown[] = [];
    const client = {
      perp: () => ({
        place: async (o: unknown) => {
          placed.push(o);
          return { id: "123" };
        },
        updateLeverage: async (l: unknown) => {
          leverage.push(l);
        },
      }),
    } as unknown as Extended;
    const fetchImpl = (async (url: string) => {
      if (url.includes("/info/markets")) return new Response(JSON.stringify({ status: "OK", data: [ETH_MARKET] }));
      if (url.endsWith("/user/orders/123")) return new Response(JSON.stringify({ status: "OK", data: orderState }));
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    return { placed, leverage, deps: { client, fetchImpl, sleep: async () => {} } };
  };

  it("sizes on Extended's mark, sets leverage, and reports the fill", async () => {
    const { placed, leverage, deps } = setup({ status: "FILLED", filledQty: "0.054", averagePrice: "2471.1" });
    const out = await executeExtendedPerp({ signer, symbol: "ETH", isBuy: false, sizeUsd: 134, leverage: 2 }, deps);
    expect(out.ok).toBe(true);
    expect(out.filledQty).toBe("0.054");
    expect(leverage).toEqual([{ name: "ETH-USD", leverage: 2 }]);
    expect(placed[0]).toMatchObject({ name: "ETH-USD", side: "sell", size: "0.054", price: "2445.5", tif: "ioc", reduceOnly: false });
  });

  it("reports a cancelled IOC as a failure with the reason", async () => {
    const { deps } = setup({ status: "CANCELLED", statusReason: "NO_LIQUIDITY", filledQty: "0" });
    const out = await executeExtendedPerp({ signer, symbol: "ETH", isBuy: true, sizeUsd: 100 }, deps);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/nothing to fill within 1%/);
  });

  it("refuses an order under the market minimum without signing", async () => {
    const { placed, deps } = setup({ status: "FILLED" });
    const out = await executeExtendedPerp({ signer, symbol: "ETH", isBuy: true, sizeUsd: 10 }, deps);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/minimum order on ETH-USD is 0.01 ETH/);
    expect(placed).toHaveLength(0);
  });

  it("closes an exact quantity without touching leverage", async () => {
    const { placed, leverage, deps } = setup({ status: "FILLED", filledQty: "0.054" });
    const out = await executeExtendedPerp({ signer, symbol: "ETH", isBuy: true, sizeUsd: 0, qtyOverride: 0.054, reduceOnly: true, leverage: 2 }, deps);
    expect(out.ok).toBe(true);
    expect(leverage).toHaveLength(0);
    expect(placed[0]).toMatchObject({ size: "0.054", reduceOnly: true });
  });
});

describe("Extended errors in English", () => {
  it("translates the SDK's French messages and explains a bare HTTP status", async () => {
    const { englishExtendedError } = await import("./extended-live");
    expect(englishExtendedError("Réponse vide")).toBe("Extended sent an empty answer");
    expect(englishExtendedError("Requête échouée")).toBe("Extended refused the request");
    expect(englishExtendedError("HTTP 400")).toBe("Extended refused the request (HTTP 400, no reason given)");
    expect(englishExtendedError("Market not found")).toBe("Market not found");
  });
});

describe("Extended position id (owner's account, 2026-10-17: vault stored as 0x2c8f…)", () => {
  const base = { apiKey: "k", l2PrivateKey: "0x1" as const, l2PublicKey: "0x3e8" as const, network: "mainnet" as const };
  const info = (data: unknown) => vi.fn(async () => new Response(JSON.stringify({ status: "OK", data })));

  it("keeps a decimal vault id without calling Extended", async () => {
    const { withExtendedVault } = await import("./extended-live");
    const f = vi.fn();
    expect(await withExtendedVault({ ...base, vaultId: "419856" }, f as never)).toEqual({ signer: { ...base, vaultId: "419856" } });
    expect(f).not.toHaveBeenCalled();
  });

  it("replaces a 0x… vault with the account's l2Vault, read with the API key", async () => {
    const { withExtendedVault } = await import("./extended-live");
    const f = info({ l2Vault: 419856, l2Key: "0x3e8" });
    const out = await withExtendedVault({ ...base, vaultId: "0x2c8fdac708346e21cf88d4f08462ad0b726992632811e79fbf02ba84fb4af5" }, f as never);
    expect(out).toEqual({ signer: { ...base, vaultId: "419856" }, repaired: "419856" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/v1\/user\/account\/info$/);
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k");
  });

  it("refuses when the account's key isn't the stored trading key", async () => {
    const { withExtendedVault } = await import("./extended-live");
    const out = await withExtendedVault({ ...base, vaultId: "0xabc" }, info({ l2Vault: "419856", l2Key: "0x999" }) as never);
    expect(out).toEqual({ error: expect.stringMatching(/isn't this Extended account's key/) });
  });

  it("tells a decimal id from a key", async () => {
    const { isVaultId } = await import("./extended-live");
    expect(isVaultId("419856")).toBe(true);
    expect(isVaultId(419856)).toBe(true);
    expect(isVaultId("0x2c8f")).toBe(false);
    expect(isVaultId("")).toBe(false);
  });
});
