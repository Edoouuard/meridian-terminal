import { describe, expect, it } from "vitest";
import { coerceArgsToSchema, parseMcpToolResult } from "@/lib/mcp/client";
import {
  normalizeCreateTxResponse,
  normalizeSameChainSwapResponse,
  normalizeSupportedChains,
  toDebridgeChainId,
} from "@/lib/mcp/debridge";
import { normalizeLifiChains, normalizeLifiEarnVaults, normalizeLifiQuote } from "@/lib/mcp/lifi";
import { aaveV3Payload, normalizeAaveMarkets, normalizeAavePositions } from "@/lib/mcp/aave";
import { isSignableQuote, type RouteQuote } from "@/lib/mcp/router";

const text = (v: unknown) => [{ type: "text", text: JSON.stringify(v) }];

describe("mcp/client — coerceArgsToSchema", () => {
  const schema = {
    properties: {
      chainId: { type: "string" },
      limit: { type: "integer" },
      ratio: { type: ["number"] },
      either: { type: ["string", "number"] },
      free: {},
    },
  };

  it("turns numbers into strings when the schema wants a string (deBridge chain IDs)", () => {
    expect(coerceArgsToSchema({ chainId: 42161 }, schema)).toEqual({ chainId: "42161" });
  });

  it("turns numeric strings into numbers when the schema wants a number", () => {
    expect(coerceArgsToSchema({ limit: "20", ratio: "0.5" }, schema)).toEqual({ limit: 20, ratio: 0.5 });
  });

  it("leaves non-numeric strings, union types and undeclared keys alone; drops undefined", () => {
    expect(coerceArgsToSchema({ limit: "abc", either: 1, free: 2, extra: 3, gone: undefined }, schema)).toEqual({
      limit: "abc",
      either: 1,
      free: 2,
      extra: 3,
    });
  });

  it("passes everything through without a schema", () => {
    expect(coerceArgsToSchema({ a: 1, b: "2" }, undefined)).toEqual({ a: 1, b: "2" });
  });
});

describe("mcp/client — parseMcpToolResult", () => {
  it("parses the first JSON text block, skipping non-JSON text", () => {
    expect(parseMcpToolResult([{ type: "text", text: "hello" }, ...text({ a: 1 })])).toEqual({ a: 1 });
  });

  it("returns structured content (plain object or array) as-is", () => {
    expect(parseMcpToolResult({ data: 1 })).toEqual({ data: 1 });
    expect(parseMcpToolResult([1, 2])).toEqual([1, 2]);
  });

  it("returns null for empty/unparseable content", () => {
    expect(parseMcpToolResult(null)).toBeNull();
    expect(parseMcpToolResult([{ type: "text", text: "nope" }])).toBeNull();
  });
});

describe("mcp/debridge — normalization", () => {
  it("maps EVM chain IDs to deBridge IDs where they differ, as strings", () => {
    expect(toDebridgeChainId(1)).toBe("1");
    expect(toDebridgeChainId(100)).toBe("100000002");
    expect(toDebridgeChainId(146)).toBe("100000014");
    expect(toDebridgeChainId(5000)).toBe("100000023");
  });

  it("normalizes a create_tx response (tx at .tx, amount under estimation, chainId from the request)", () => {
    const order = normalizeCreateTxResponse(
      {
        tx: { to: "0xeF4fB24aD0916217251F553c0596F8Edc630EB66", data: "0xabc", value: "1000" },
        approveTx: { to: "0xtoken", data: "0x095ea7b3" },
        orderId: "0xorder",
        estimation: { dstChainTokenOut: { amount: "990", recommendedAmount: "995" } },
        order: { approximateFulfillmentDelay: 12 },
      },
      42161,
    );
    expect(order).toMatchObject({
      kind: "cross-chain",
      tx: { to: "0xeF4fB24aD0916217251F553c0596F8Edc630EB66", data: "0xabc", value: "1000", chainId: 42161 },
      approveTx: { to: "0xtoken", data: "0x095ea7b3", value: "0", chainId: 42161 },
      orderId: "0xorder",
      estimatedDstAmount: "995",
      estimatedTimeSeconds: 12,
    });
  });

  it("returns tx: null when the response carries no usable tx", () => {
    expect(normalizeCreateTxResponse({ estimation: {} }, 1)?.tx).toBeNull();
    expect(normalizeCreateTxResponse("oops", 1)).toBeNull();
  });

  it("normalizes a same-chain swap response (tx nested, NOT the whole payload)", () => {
    const swap = normalizeSameChainSwapResponse(
      { data: { tx: { to: "0xrouter", data: "0x01", value: "0" }, tokenOut: { amount: "10027065", minAmount: "10019037" } } },
      8453,
    );
    expect(swap).toMatchObject({
      kind: "same-chain",
      tx: { to: "0xrouter", data: "0x01", value: "0", chainId: 8453 },
      estimatedAmountOut: "10027065",
      minAmountOut: "10019037",
    });
  });

  it("accepts supported chains as an array or wrapped in { chains }", () => {
    expect(normalizeSupportedChains([{ chainId: 1, chainName: "Ethereum" }])).toEqual([{ chainId: 1, name: "Ethereum" }]);
    expect(normalizeSupportedChains({ chains: [{ chainId: "8453", name: "Base" }] })).toEqual([{ chainId: 8453, name: "Base" }]);
  });
});

describe("mcp/lifi — normalization", () => {
  it("accepts chains as an array or LI.FI's { chains } REST shape", () => {
    expect(normalizeLifiChains({ chains: [{ id: 1, key: "eth", name: "Ethereum" }] })).toHaveLength(1);
    expect(normalizeLifiChains([{ id: 10, key: "opt", name: "Optimism" }])).toHaveLength(1);
    expect(normalizeLifiChains({ nope: true })).toEqual([]);
  });

  it("normalizes a quote and falls back to action.fromChainId for the tx chain", () => {
    const q = normalizeLifiQuote({
      action: { fromChainId: 137 },
      estimate: { toAmount: "123", executionDuration: 30, approvalAddress: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" },
      transactionRequest: { to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", data: "0xdead", value: "0x0" },
      tool: "stargate",
    });
    expect(q?.transactionRequest).toEqual({
      to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
      data: "0xdead",
      value: "0x0",
      chainId: 137,
      gasLimit: undefined,
    });
    expect(q?.estimate?.toAmount).toBe("123");
  });
});

describe("mcp/lifi — earn vaults", () => {
  // NormalizedVault shape as served live by earn.li.fi (APY in percent).
  const vault = {
    address: "0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A",
    network: "base",
    chainId: 8453,
    name: "Morpho USDC Vault",
    protocol: { name: "Morpho", url: "https://morpho.org" },
    underlyingTokens: [{ address: "0x8335", symbol: "USDC", decimals: 6, weight: 1.0 }],
    tags: ["stablecoin", "lending"],
    analytics: { apy: { base: 5.34, reward: null, total: 5.34 }, tvl: { usd: "12500000.00" } },
    isTransactional: true,
  };

  it("reads { data: NormalizedVault[] }, converting percent APY to a fraction and string TVL to a number", () => {
    expect(normalizeLifiEarnVaults({ data: [vault], nextCursor: null, total: 1 })).toEqual([
      {
        address: "0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A",
        chainId: 8453,
        name: "Morpho USDC Vault",
        protocol: "Morpho",
        asset: "USDC",
        apy: expect.closeTo(0.0534, 10),
        tvlUsd: 12_500_000,
        tags: ["stablecoin", "lending"],
        isTransactional: true,
      },
    ]);
  });

  it("joins multi-asset symbols, tolerates missing analytics, skips junk rows", () => {
    const multi = { ...vault, underlyingTokens: [{ symbol: "WETH" }, { symbol: "USDC" }], analytics: undefined };
    const [v] = normalizeLifiEarnVaults([multi, null, { nope: 1 }]);
    expect(v.asset).toBe("WETH/USDC");
    expect(v.apy).toBe(0);
    expect(normalizeLifiEarnVaults("error fetching earn vaults: HTTP 404")).toEqual([]);
  });
});

describe("mcp/aave — normalization", () => {
  const markets = {
    data: {
      v3: {
        chainsCovered: [1],
        markets: [
          {
            market: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
            chainId: 1,
            reserves: [
              { symbol: "USDC", underlyingToken: "0xA0b8", supplyApyPct: "4.25", borrowApyPct: "5.5", totalSuppliedUsd: "1000000" },
            ],
          },
        ],
      },
    },
    next_actions: [],
  };

  it("unwraps { data: { v3 } } from content blocks or structured content", () => {
    expect(aaveV3Payload(text(markets))).toMatchObject({ chainsCovered: [1] });
    expect(aaveV3Payload(markets)).toMatchObject({ chainsCovered: [1] });
    expect(aaveV3Payload({ data: { v3: { error: "down" } } })).toBeNull();
  });

  it("converts percent-string APYs into fractions and keeps the market pool", () => {
    const [r] = normalizeAaveMarkets(markets, 1);
    expect(r).toMatchObject({ market: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", symbol: "USDC", underlyingAsset: "0xA0b8", totalSupply: 1_000_000 });
    expect(r.supplyAPY).toBeCloseTo(0.0425);
    expect(r.borrowAPY).toBeCloseTo(0.055);
    expect(normalizeAaveMarkets(markets, 8453)).toEqual([]);
  });

  it("groups flat v3 supplies/borrows into per-chain positions", () => {
    const positions = normalizeAavePositions({
      data: {
        v3: {
          supplies: [
            { chainId: 1, symbol: "WETH", balanceUsd: "2000", apyPct: "2", isCollateral: true },
            { chainId: 8453, symbol: "USDC", balanceUsd: "500", apyPct: "5" },
          ],
          borrows: [{ chainId: 1, symbol: "USDC", debtUsd: "800", apyPct: "6" }],
        },
      },
    });
    const eth = positions.find((p) => p.chainId === 1)!;
    expect(eth.totalCollateralUsd).toBe(2000);
    expect(eth.totalDebtUsd).toBe(800);
    expect(eth.supplies[0].apy).toBeCloseTo(0.02);
    const base = positions.find((p) => p.chainId === 8453)!;
    expect(base.totalCollateralUsd).toBe(0);
    expect(base.supplies[0].balanceUsd).toBe(500);
  });
});

describe("mcp/router — isSignableQuote", () => {
  const q = (provider: "lifi" | "debridge", to: string, chainId = 1): RouteQuote => ({ provider, tx: { to, data: "0x", chainId } });

  it("accepts allowlisted entrypoints only, per provider and chain", () => {
    expect(isSignableQuote(q("lifi", "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae"))).toBe(true);
    expect(isSignableQuote(q("debridge", "0xeF4fB24aD0916217251F553c0596F8Edc630EB66", 8453))).toBe(true);
    expect(isSignableQuote(q("debridge", "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"))).toBe(false);
    expect(isSignableQuote(q("lifi", "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", 56))).toBe(false);
  });
});
