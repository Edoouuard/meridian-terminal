import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { parseOpenOrders } from "@/lib/integrations/hyperliquid-live";
import {
  cancelPerpOrder,
  fetchPerpAccount,
  fetchPerpMarket,
  fitNotionalToMargin,
  hip3AssetId,
  splitDexCoin,
  fundingAprForSide,
  hyperliquidEnv,
  marginNeededUsd,
  perpLimitOrder,
  perpMarketOrder,
  protectionPrices,
  withdrawUsdcToArbitrum,
  withdrawableUsd,
  type WalletSign,
} from "@/lib/integrations/hyperliquidTrade";

const wallet = privateKeyToAccount("0x0123456789012345678901234567890123456789012345678901234567890123");
const walletSign: WalletSign = (td) => wallet.signTypedData(td as never);
const env = hyperliquidEnv(false);

/** Answers Hyperliquid's info calls from `state`, records exchange calls and answers them from `exchange`. */
function mockHyperliquid(state: { withdrawable: string; spotUsdc: string; abstraction: string | null }, exchange: (action: { type: string }) => unknown) {
  const sent: { type: string; amount?: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const json = (v: unknown) => ({ ok: true, status: 200, json: async () => v });
    if (url.endsWith("/exchange")) {
      sent.push(body.action);
      return json(exchange(body.action));
    }
    if (body.type === "clearinghouseState") return json({ withdrawable: state.withdrawable });
    if (body.type === "spotClearinghouseState") return json({ balances: [{ coin: "USDC", total: state.spotUsdc, hold: "0" }] });
    if (body.type === "userAbstraction") return json(state.abstraction);
    return json(null);
  }));
  return sent;
}

afterEach(() => vi.unstubAllGlobals());

describe("withdrawableUsd", () => {
  it("counts one shared balance in a unified account, perps + spot otherwise", () => {
    expect(withdrawableUsd({ perps: 0, spotUsdc: 69, unified: true })).toBe(69);
    expect(withdrawableUsd({ perps: 60, spotUsdc: 69, unified: true })).toBe(69);
    expect(withdrawableUsd({ perps: 10, spotUsdc: 20, unified: false })).toBe(30);
  });
});

describe("withdrawUsdcToArbitrum", () => {
  const user = wallet.address;

  it("withdraws straight from a unified account, with no spot → perps transfer", async () => {
    const sent = mockHyperliquid({ withdrawable: "0", spotUsdc: "69.02", abstraction: "unifiedAccount" }, () => ({ status: "ok", response: { type: "default" } }));
    const out = await withdrawUsdcToArbitrum({ user, env, walletSign, walletChainId: 42161, amount: 69 });
    expect(out).toEqual({ ok: true, amount: 69 });
    expect(sent.map((a) => a.type)).toEqual(["withdraw3"]);
    expect(sent[0].amount).toBe("69.00");
  });

  it("falls back to a direct withdrawal when Hyperliquid refuses the transfer for a unified account", async () => {
    const sent = mockHyperliquid({ withdrawable: "0", spotUsdc: "69", abstraction: null }, (a) =>
      a.type === "usdClassTransfer" ? { status: "err", response: "Action disabled when unified account is active" } : { status: "ok", response: { type: "default" } },
    );
    const out = await withdrawUsdcToArbitrum({ user, env, walletSign, walletChainId: 42161, amount: 69 });
    expect(out).toEqual({ ok: true, amount: 69 });
    expect(sent.map((a) => a.type)).toEqual(["usdClassTransfer", "withdraw3"]);
  });

  it("moves spot USDC to perps first in a classic account", async () => {
    const sent = mockHyperliquid({ withdrawable: "10", spotUsdc: "59", abstraction: "default" }, () => ({ status: "ok", response: { type: "default" } }));
    const out = await withdrawUsdcToArbitrum({ user, env, walletSign, walletChainId: 42161, amount: 69 });
    expect(out.ok).toBe(true);
    expect(sent.map((a) => `${a.type}:${a.amount}`)).toEqual(["usdClassTransfer:59.00", "withdraw3:69.00"]);
  });
});

describe("perps: funding, margin, protection", () => {
  it("signs funding for the side: a short earns positive funding, a long pays it", () => {
    expect(fundingAprForSide(0.0000125, false)).toBeCloseTo(10.95, 2);
    expect(fundingAprForSide(0.0000125, true)).toBeCloseTo(-10.95, 2);
  });

  it("needs notional / leverage of margin, plus 2%", () => {
    expect(marginNeededUsd(300, 3)).toBeCloseTo(102);
    expect(marginNeededUsd(50, undefined)).toBeCloseTo(51);
  });

  it("puts the stop-loss on the losing side and the take-profit on the winning side", () => {
    expect(protectionPrices(2000, true, { stopLossPct: 10, takeProfitPct: 20 })).toEqual({ sl: 1800, tp: 2400 });
    expect(protectionPrices(2000, false, { stopLossPct: 10 })).toEqual({ sl: 2200, tp: undefined });
  });

  it("counts the shared balance as margin in a unified account, and reads the open position", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      const json = (v: unknown) => ({ ok: true, status: 200, json: async () => v });
      if (body.type === "clearinghouseState") return json({ withdrawable: "0", assetPositions: [{ position: { coin: "ETH", szi: "-0.05" } }] });
      if (body.type === "spotClearinghouseState") return json({ balances: [{ coin: "USDC", total: "69", hold: "0" }] });
      if (body.type === "userAbstraction") return json("unifiedAccount");
      return json(null);
    }));
    expect(await fetchPerpAccount(env, wallet.address, "ETH PERP")).toEqual({ freeMargin: 69, spotUsdc: 69, unified: true, position: -0.05 });
  });

  it("opens, then places a reduce-only stop-loss for what filled, priced from the fill", async () => {
    const isEntry = (action: unknown) => {
      const first = (action as { orders?: { t: object }[] }).orders?.[0];
      return !!first && "limit" in first.t;
    };
    const sent = mockHyperliquid({ withdrawable: "100", spotUsdc: "0", abstraction: null }, (action) =>
      isEntry(action)
        ? { status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.05", avgPx: "2000" } }] } } }
        : { status: "ok", response: { type: "order", data: { statuses: ["waitingForTrigger"] } } },
    );
    const realFetch = globalThis.fetch as unknown as (u: string, i: { body: string }) => Promise<unknown>;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      const json = (v: unknown) => ({ ok: true, status: 200, json: async () => v });
      if (body.type === "meta") return json({ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "ETH", szDecimals: 4, maxLeverage: 25 }] });
      if (body.type === "allMids") return json({ ETH: "2000" });
      return realFetch(url, init);
    }));
    const out = await perpMarketOrder(env, "0x0123456789012345678901234567890123456789012345678901234567890123", {
      coin: "ETH",
      isBuy: true,
      sizeUsd: 100,
      stopLossPct: 10,
    });
    expect(out.ok).toBe(true);
    expect(out.protection).toMatchObject({ ok: true, sl: 1800 });
    const trigger = sent.at(-1) as unknown as { orders: { a: number; b: boolean; r: boolean; s: string; t: unknown }[] };
    expect(trigger.orders[0]).toMatchObject({ a: 1, b: false, r: true, s: "0.05", t: { trigger: { isMarket: true, triggerPx: "1800", tpsl: "sl" } } });
  });
});

describe("perps: limit orders, cancel, open orders", () => {
  const meta = { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "ETH", szDecimals: 4, maxLeverage: 25 }] };
  const key = "0x0123456789012345678901234567890123456789012345678901234567890123" as const;

  function mockExchange(reply: unknown) {
    const sent: { type: string; orders?: { p: string; s: string; t: unknown }[]; cancels?: unknown[] }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      const json = (v: unknown) => ({ ok: true, status: 200, json: async () => v });
      if (url.endsWith("/exchange")) {
        sent.push(body.action);
        return json(reply);
      }
      if (body.type === "meta") return json(meta);
      return json(null);
    }));
    return sent;
  }

  it("places a GTC limit (or post-only ALO) at the rounded price and reads the resting id", async () => {
    const sent = mockExchange({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 42 } }] } } });
    const out = await perpLimitOrder(env, key, { coin: "ETH", isBuy: true, px: 1950.123, sizeUsd: 100, postOnly: true });
    expect(out).toMatchObject({ ok: true, resting: { oid: 42 } });
    expect(sent[0].orders?.[0]).toMatchObject({ p: "1950.1", s: "0.0513", t: { limit: { tif: "Alo" } } });
  });

  it("refuses an order under Hyperliquid's $10 minimum before signing", async () => {
    const sent = mockExchange({ status: "ok" });
    expect(await perpLimitOrder(env, key, { coin: "ETH", isBuy: true, px: 2000, sizeUsd: 5 })).toMatchObject({ ok: false });
    expect(sent).toHaveLength(0);
  });

  it("cancels by asset id and order id", async () => {
    const sent = mockExchange({ status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } });
    expect(await cancelPerpOrder(env, key, { coin: "ETH", oid: 42 })).toMatchObject({ ok: true });
    expect(sent[0]).toEqual({ type: "cancel", cancels: [{ a: 1, o: 42 }] });
  });

  it("reads stop-loss / take-profit trigger prices from frontendOpenOrders", () => {
    const [sl, lim] = parseOpenOrders([
      { coin: "ETH", side: "A", sz: "0.05", limitPx: "1620", oid: 7, orderType: "Stop Market", triggerPx: "1800", isTrigger: true, reduceOnly: true },
      { coin: "ETH", side: "B", sz: "0.05", limitPx: "1950", oid: 8, orderType: "Limit", triggerPx: "0", isTrigger: false },
    ]);
    expect(sl).toMatchObject({ orderType: "Stop Market", triggerPx: 1800, reduceOnly: true });
    expect(lim).toMatchObject({ orderType: "Limit", triggerPx: 0, limitPx: 1950 });
  });
});

describe("HIP-3 markets (stocks, indices, commodities)", () => {
  const key = "0x0123456789012345678901234567890123456789012345678901234567890123" as const;
  const metas: Record<string, unknown> = {
    "": { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "ETH", szDecimals: 4, maxLeverage: 25 }] },
    usdh: { collateralToken: 360, universe: [{ name: "usdh:TSLA", szDecimals: 3, maxLeverage: 20 }] },
    xyz: {
      collateralToken: 0,
      universe: [
        { name: "xyz:XYZ100", szDecimals: 4, maxLeverage: 30 },
        { name: "xyz:TSLA", szDecimals: 3, maxLeverage: 20 },
        { name: "xyz:SP500", szDecimals: 3, maxLeverage: 50 },
        { name: "xyz:AMD", szDecimals: 3, maxLeverage: 10, onlyIsolated: true },
      ],
    },
  };

  function mockHip3(state: { abstraction?: string | null; dexAbstraction?: boolean } = {}) {
    const sent: { type: string; [k: string]: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      const json = (v: unknown) => ({ ok: true, status: 200, json: async () => v });
      if (url.endsWith("/exchange")) {
        sent.push(body.action);
        return json(body.action.type === "order"
          ? { status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.265", avgPx: "377" } }] } } }
          : { status: "ok", response: { type: "default" } });
      }
      if (body.type === "perpDexs") return json([null, { name: "usdh" }, { name: "xyz" }]);
      if (body.type === "meta") return json(metas[body.dex ?? ""]);
      if (body.type === "allMids") return json(body.dex === "xyz" ? { "xyz:TSLA": "377", "xyz:AMD": "555" } : { ETH: "2000" });
      if (body.type === "userAbstraction") return json(state.abstraction ?? null);
      if (body.type === "userDexAbstraction") return json(state.dexAbstraction ?? false);
      return json(null);
    }));
    return sent;
  }

  it("numbers HIP-3 assets like the SDK: 110000 + (dex slot − 1) × 10000 + index", () => {
    expect(hip3AssetId(1, 0)).toBe(110000);
    expect(hip3AssetId(2, 3)).toBe(120003);
  });

  it("splits an explicit dex market and strips PERP", () => {
    expect(splitDexCoin("xyz:TSLA PERP")).toEqual({ dex: "xyz", name: "TSLA" });
    expect(splitDexCoin("ETH-PERP")).toEqual({ name: "ETH" });
  });

  it("finds a stock on the USDC-collateral dex, skipping a dex funded in another stablecoin", async () => {
    mockHip3();
    expect(await fetchPerpMarket(env, "TSLA")).toMatchObject({ coin: "xyz:TSLA", dex: "xyz", asset: 120001, index: 1 });
    expect(await fetchPerpMarket(env, "S&P 500")).toMatchObject({ coin: "xyz:SP500", asset: 120002 });
    expect(await fetchPerpMarket(env, "ETH PERP")).toMatchObject({ coin: "ETH", dex: "", asset: 1 });
    expect(await fetchPerpMarket(env, "usdh:TSLA")).toBeNull();
  });

  it("links the main balance to HIP-3 once (agent action), sets isolated leverage, then orders at the HIP-3 asset id", async () => {
    const sent = mockHip3();
    const out = await perpMarketOrder(env, key, { coin: "AMD", isBuy: true, sizeUsd: 100, leverage: 3, user: wallet.address });
    expect(out.ok).toBe(true);
    expect(sent.map((a) => a.type)).toEqual(["agentEnableDexAbstraction", "updateLeverage", "order"]);
    expect(sent[1]).toEqual({ type: "updateLeverage", asset: 120003, isCross: false, leverage: 3 });
    expect((sent[2].orders as { a: number }[])[0].a).toBe(120003);
  });

  it("skips the abstraction step for a unified account", async () => {
    const sent = mockHip3({ abstraction: "unifiedAccount" });
    await perpMarketOrder(env, key, { coin: "xyz:TSLA", isBuy: false, sizeUsd: 100, user: "0x00000000000000000000000000000000000000aa" });
    expect(sent.map((a) => a.type)).toEqual(["order"]);
  });
});

describe("fitNotionalToMargin", () => {
  it("keeps the asked size when the margin covers it", () => {
    expect(fitNotionalToMargin(100, 2, 60)).toBe(100);
  });

  it("opens the most the margin allows when only the fees buffer is missing (the reported $66 vs $68.34)", () => {
    const size = fitNotionalToMargin(134, 2, 66)!;
    expect(size).toBeCloseTo(129.41, 2);
    expect(marginNeededUsd(size, 2)).toBeLessThanOrEqual(66);
  });

  it("waits (undefined) while the deposit hasn't landed", () => {
    expect(fitNotionalToMargin(134, 2, 0.8)).toBeUndefined();
    expect(fitNotionalToMargin(134, 2, 50)).toBeUndefined();
  });
});

describe("planSpotBuy", () => {
  it("sizes the buy, keeping the IOC slippage reserve inside the spot USDC", async () => {
    const { planSpotBuy } = await import("@/lib/integrations/hyperliquidTrade");
    expect(planSpotBuy({ usd: 31, mid: 2460, spotUsdc: 66, szDecimals: 4 })).toEqual({ size: 0.0126, usd: 0.0126 * 2460 });
    // Only $20 free: at most 20 / 1.05 is spent.
    const capped = planSpotBuy({ usd: 31, mid: 2460, spotUsdc: 20, szDecimals: 4 });
    expect(capped.usd * 1.05).toBeLessThanOrEqual(20);
  });
});
