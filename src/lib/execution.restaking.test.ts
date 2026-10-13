import { describe, expect, it } from "vitest";
import { buildExecution, type Order } from "@/lib/execution";
import { approveOrderFor, needsLiveCompletion, resolveOrderForLeg } from "@/lib/assetMap";
import { PENDLE_ROUTER_V4 } from "@/lib/integrations/pendle";
import { EIGENLAYER_STETH_STRATEGY, EIGENLAYER_STRATEGY_MANAGER } from "@/lib/integrations/eigenlayer";
import { STETH_ADDRESS } from "@/lib/onchain";

const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const prices = [{ symbol: "ETH", price: 2500 }, { symbol: "USDC", price: 1 }];

describe("execution — Pendle PT", () => {
  const order: Order = {
    type: "swap",
    protocol: "pendle",
    token: USDC_ARB,
    symbol: "USDC",
    amount: 100_000_000n,
    chainId: 42161,
    decimals: 6,
    routerTx: { to: PENDLE_ROUTER_V4, data: "0xc81f847a" },
  };

  it("signs the quoted call against Pendle's router and approves that router", () => {
    const plan = buildExecution(order);
    expect(plan).toMatchObject({ address: PENDLE_ROUTER_V4, data: "0xc81f847a", chainId: 42161 });
    const approve = approveOrderFor(order);
    expect(approve).toMatchObject({ type: "approve", spender: PENDLE_ROUTER_V4 });
    expect(buildExecution(approve!)).toMatchObject({ functionName: "approve", address: USDC_ARB });
  });

  it("refuses a quote that targets anything else", () => {
    expect(buildExecution({ ...order, routerTx: { to: "0x" + "1".repeat(40) as `0x${string}`, data: "0x" } })).toMatchObject({ error: expect.stringMatching(/not Pendle's verified router/) });
  });

  it("resolves a Pendle leg to a shell the dedicated button completes", () => {
    const shell = resolveOrderForLeg({ side: "Supply", asset: "PT-sUSDe", protocol: "Pendle", sizeUsd: 100 }, undefined, prices, 42161);
    expect(shell).toMatchObject({ protocol: "pendle", symbol: "USDC" });
    expect(needsLiveCompletion(shell as Order)).toBe(true);
  });
});

describe("execution — EigenLayer restake", () => {
  it("resolves a stETH restake on Ethereum to a signable deposit with its approval", () => {
    const order = resolveOrderForLeg({ side: "Restake", asset: "stETH", protocol: "EigenLayer", sizeUsd: 1000 }, undefined, prices, 1) as Order;
    expect(order).toMatchObject({ type: "stake", protocol: "eigenlayer", amount: 400_000_000_000_000_000n });
    expect(needsLiveCompletion(order)).toBe(false);
    expect(buildExecution(order)).toMatchObject({
      address: EIGENLAYER_STRATEGY_MANAGER,
      functionName: "depositIntoStrategy",
      args: [EIGENLAYER_STETH_STRATEGY, STETH_ADDRESS, 400_000_000_000_000_000n],
    });
    expect(buildExecution(approveOrderFor(order)!)).toMatchObject({ address: STETH_ADDRESS, args: [EIGENLAYER_STRATEGY_MANAGER, 400_000_000_000_000_000n] });
  });

  it("refuses other chains and other assets", () => {
    expect(resolveOrderForLeg({ side: "Restake", asset: "stETH", protocol: "EigenLayer", sizeUsd: 1000 }, undefined, prices, 8453)).toMatchObject({ unsupported: expect.stringMatching(/Ethereum mainnet/) });
    expect(resolveOrderForLeg({ side: "Restake", asset: "rETH", protocol: "EigenLayer", sizeUsd: 1000 }, undefined, prices, 1)).toMatchObject({ unsupported: expect.stringMatching(/stETH only/) });
  });
});
