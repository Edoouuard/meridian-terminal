/**
 * Response-parsing tests for the MCP adapters. Each fixture is a trimmed copy
 * of a real response captured from the live server (2026-10-12) — so a shape
 * mismatch like "markets is not iterable" fails here instead of silently
 * returning empty data in production.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const callMcpTool = vi.fn();

vi.mock("@/lib/mcp/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/client")>();
  return { ...actual, callMcpTool: (...args: unknown[]) => callMcpTool(...args) };
});

const text = (payload: unknown) => [{ type: "text", text: JSON.stringify(payload) }];

const USER = "0x9600A48ed0f931d0c422D574e3275a90D8b22745";
const ARB_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

const AAVE_MARKETS_ARB = {
  data: {
    v4: { chainsCovered: [], chainsNotServed: [42161], markets: [] },
    v3: {
      chainsCovered: [42161],
      markets: [{
        market: ARB_POOL,
        chainId: 42161,
        name: "AaveV3Arbitrum",
        reserves: [
          { symbol: "USDC", underlyingToken: USDC_ARB, supplyApyPct: "4.1", totalSuppliedUsd: "900000000", canSupply: true, borrowApyPct: "5.2", availableLiquidity: { value: "1", usd: "100000000" }, canBorrow: true },
          { symbol: "DAI", underlyingToken: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", supplyApyPct: "1.52", totalSuppliedUsd: "3134155.9", canSupply: true, isFrozen: true, supplyCapReached: true, borrowApyPct: "4.19", canBorrow: true },
          { symbol: "AAVE", underlyingToken: "0xba5DdD1f9d7F570dc94a51479a000E3BCE967196", supplyApyPct: "0", totalSuppliedUsd: "1714100.2", canSupply: true },
        ],
      }],
    },
  },
  next_actions: [],
};

beforeEach(() => callMcpTool.mockReset());

/** Arguments of the first recorded call to `tool` (asserted after the fact, never inside the mock). */
const argsOf = (tool: string) => callMcpTool.mock.calls.find((c) => c[2] === tool)?.[3] as Record<string, unknown> | undefined;

describe("aave adapter", () => {
  it("flattens v3 markets into reserves with percent APYs", async () => {
    callMcpTool.mockResolvedValue(text(AAVE_MARKETS_ARB));
    const { fetchAaveReserves } = await import("@/lib/mcp/aave");
    const reserves = await fetchAaveReserves(42161);
    expect(reserves).toHaveLength(3);
    expect(reserves[0]).toMatchObject({ symbol: "USDC", market: ARB_POOL, supplyApyPct: 4.1, borrowApyPct: 5.2, chainId: 42161 });
    expect(reserves[1]).toMatchObject({ symbol: "DAI", isFrozen: true, supplyCapReached: true });
  });

  it("leaves frozen / capped / zero-rate reserves out of the strategy summary", async () => {
    callMcpTool.mockResolvedValue(text(AAVE_MARKETS_ARB));
    const { fetchAaveYieldSummary } = await import("@/lib/mcp/aave");
    const summary = await fetchAaveYieldSummary([42161]);
    expect(summary).toContain("USDC: Supply 4.10% APY | Borrow 5.20% APY");
    expect(summary).not.toContain("DAI");
    expect(summary).not.toContain("AAVE:");
  });

  it("groups positions per market and attaches the health factor", async () => {
    callMcpTool.mockImplementation(async (...call: unknown[]) => {
      const tool = call[2];
      if (tool === "get_user_positions") {
        return text({ data: { v3: {
          supplies: [{ market: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", marketName: "AaveV3Ethereum", chainId: 1, symbol: "weETH", token: "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee", decimals: 18, balance: "100", balanceUsd: "270000", priceUsd: "2700", apyPct: "0.01", isCollateral: true }],
          borrows: [{ market: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", marketName: "AaveV3Ethereum", chainId: 1, symbol: "WETH", token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18, debt: "50", debtUsd: "127700", priceUsd: "2554", apyPct: "1.97" }],
        } } });
      }
      return text({ data: { v3: { markets: [{ market: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", chainId: 1, healthFactor: "1.0322", netWorthUsd: "142300" }] } } });
    });
    const { fetchAavePositions } = await import("@/lib/mcp/aave");
    const [p] = await fetchAavePositions(USER);
    expect(p).toMatchObject({ chainId: 1, chain: "Ethereum", totalCollateralUsd: 270000, totalDebtUsd: 127700, healthFactor: 1.0322 });
    expect(p.borrows[0]).toMatchObject({ symbol: "WETH", balanceUsd: 127700, apy: 1.97 });
  });

  it("returns the approval step and the action tx from prepare_action", async () => {
    callMcpTool.mockImplementation(async (...call: unknown[]) => {
      if (call[2] === "get_markets") return text(AAVE_MARKETS_ARB);
      return text({ data: {
        __typename: "ApprovalRequired",
        approval: { to: USDC_ARB, data: "0x095ea7b3", value: "0", chainId: 42161 },
        originalTransaction: { to: ARB_POOL, data: "0x617ba037", value: "0", chainId: 42161, operation: "SUPPLY" },
      } });
    });
    const { buildAaveTransaction } = await import("@/lib/mcp/aave");
    const plan = await buildAaveTransaction(USER, 42161, "supply", "USDC", "100");
    expect(plan?.approval).toEqual({ to: USDC_ARB, data: "0x095ea7b3", value: "0", chainId: 42161 });
    expect(plan?.tx).toEqual({ to: ARB_POOL, data: "0x617ba037", value: "0", chainId: 42161 });
    expect(argsOf("prepare_action")).toMatchObject({ market: ARB_POOL, token: USDC_ARB, chainId: 42161, action: "supply", amount: "100" });
  });

  it("simulates with market + token resolved from get_markets", async () => {
    callMcpTool.mockImplementation(async (...call: unknown[]) => {
      if (call[2] === "get_markets") return text(AAVE_MARKETS_ARB);
      return text({ data: { healthFactorBefore: "1.8", healthFactorAfter: "0.95" } });
    });
    const { previewAaveAction } = await import("@/lib/mcp/aave");
    expect(await previewAaveAction(USER, 42161, "borrow", USDC_ARB, "1000")).toEqual({
      healthFactorBefore: 1.8,
      healthFactorAfter: 0.95,
      willLiquidate: true,
    });
    expect(argsOf("preview_action")).toMatchObject({ market: ARB_POOL, token: USDC_ARB });
  });
});

describe("debridge adapter", () => {
  it("sends string chain ids and reads the DLN order estimate", async () => {
    callMcpTool.mockImplementation(async () => {
      return text({
        estimation: { dstChainTokenOut: { amount: "49644886", recommendedAmount: "49644886", approximateUsdValue: 49.64, recommendedApproximateUsdValue: 49.64 } },
        tx: { to: "0xeF4fB24aD0916217251F553c0596F8Edc630EB66", data: "0xb9303701", value: "1000000000000000" },
        order: { approximateFulfillmentDelay: 2 },
        orderId: "0x58757859bebef236fe7eafe22959bf3fe4bca0afcb314c7445dcd11f00c9e379",
      });
    });
    const { createDebridgeCrossChainTx } = await import("@/lib/mcp/debridge");
    const order = await createDebridgeCrossChainTx({
      srcChainId: 42161, srcTokenAddress: USDC_ARB, srcAmount: "50000000",
      dstChainId: 8453, dstTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", senderAddress: USER,
    });
    expect(order).toMatchObject({
      tx: { to: "0xeF4fB24aD0916217251F553c0596F8Edc630EB66", value: "1000000000000000", chainId: 42161 },
      estimatedDstAmount: "49644886",
      estimatedDstAmountUsd: 49.64,
      estimatedTimeSeconds: 2,
    });
    expect(argsOf("create_tx")).toMatchObject({ srcChainId: "42161", dstChainId: "8453" });
  });

  it("uses tokenInAmount / tokenOutRecipient for same-chain swaps", async () => {
    callMcpTool.mockImplementation(async () => {
      return text({
        tx: { to: "0x663DC15D3C1aC63ff12E45Ab68FeA3F0a883C251", data: "0x258c16ee", value: "10000000000000000" },
        tokenOut: { amount: "25502803", minAmount: "25375187", approximateUsdValue: 25.52 },
      });
    });
    const { createDebridgeSameChainSwapTx } = await import("@/lib/mcp/debridge");
    const swap = await createDebridgeSameChainSwapTx({
      chainId: 42161, tokenIn: "0x0000000000000000000000000000000000000000", tokenOut: USDC_ARB,
      amountIn: "10000000000000000", senderAddress: USER, slippageBps: 50,
    });
    expect(swap).toMatchObject({ tx: { chainId: 42161 }, estimatedAmountOut: "25502803", minAmountOut: "25375187", estimatedAmountOutUsd: 25.52 });
    const args = argsOf("transaction_same_chain_swap");
    expect(args).toMatchObject({ chainId: "42161", tokenInAmount: "10000000000000000", tokenOutRecipient: USER, slippage: "0.5" });
    expect(args).not.toHaveProperty("amountIn");
  });

  it("parses the supported-chain list (string ids)", async () => {
    callMcpTool.mockResolvedValue(text([{ chainId: "42161", chainNames: ["Arbitrum", "ARB"] }, { chainId: "8453", chainNames: ["Base"] }]));
    const { fetchDebridgeSupportedChains } = await import("@/lib/mcp/debridge");
    expect(await fetchDebridgeSupportedChains()).toEqual([{ chainId: 42161, name: "Arbitrum" }, { chainId: 8453, name: "Base" }]);
  });
});

describe("lifi adapter", () => {
  it("unwraps the { chains } envelope", async () => {
    callMcpTool.mockResolvedValue(text({ chains: [{ id: 1, key: "eth", name: "Ethereum" }, { id: 8453, key: "bas", name: "Base" }] }));
    const { fetchLifiChains } = await import("@/lib/mcp/lifi");
    expect((await fetchLifiChains()).map((c) => c.id)).toEqual([1, 8453]);
  });

  it("sends every get-quote argument as a string", async () => {
    callMcpTool.mockImplementation(async () => {
      return text({ transactionRequest: { to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", data: "0x", value: "0x0", chainId: 42161 }, estimate: { toAmount: "49903200", executionDuration: 1080 } });
    });
    const { getLifiQuote } = await import("@/lib/mcp/lifi");
    const q = await getLifiQuote({ fromChain: 42161, toChain: 8453, fromToken: USDC_ARB, toToken: USDC_ARB, fromAddress: USER, fromAmount: "50000000", slippage: 0.005 });
    expect(q?.estimate?.toAmount).toBe("49903200");
    for (const v of Object.values(argsOf("get-quote") ?? { missing: 0 })) expect(typeof v).toBe("string");
  });
});

describe("deBridge order status (DLN stats API)", () => {
  it("maps the API's PascalCase states onto the tracked lifecycle", async () => {
    const { mapDlnOrderState } = await import("@/lib/mcp/providers/debridge");
    expect(mapDlnOrderState("Created")).toBe("created");
    expect(mapDlnOrderState("Fulfilled")).toBe("fulfilled");
    expect(mapDlnOrderState("SentUnlock")).toBe("fulfilled");
    expect(mapDlnOrderState("ClaimedUnlock")).toBe("claimed");
    expect(mapDlnOrderState("OrderCancelled")).toBe("cancelled");
    expect(mapDlnOrderState(undefined)).toBe("created");
  });
});
