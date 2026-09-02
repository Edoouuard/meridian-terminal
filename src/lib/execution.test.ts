import { describe, expect, it } from "vitest";
import { zeroAddress } from "viem";
import {
  applySender,
  buildExecution,
  normalizeAmount,
  type ExecutionPlan,
  type Order,
} from "@/lib/execution";

const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const AAVE_MAINNET = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const SENDER = "0x1111111111111111111111111111111111111111";

function baseOrder(overrides: Partial<Order> = {}): Order {
  return {
    type: "supply",
    protocol: "aave",
    token: USDC_MAINNET,
    symbol: "USDC",
    amount: "1000",
    chainId: 1,
    decimals: 6,
    ...overrides,
  };
}

describe("execution — normalizeAmount", () => {
  it("accepts a human-unit string", () => {
    expect(normalizeAmount("1000", 6)).toEqual({ value: 1_000_000_000n });
  });

  it("accepts a base-unit bigint", () => {
    expect(normalizeAmount(1_000_000_000n, 6)).toEqual({ value: 1_000_000_000n });
  });

  it("rejects negative and zero bigints", () => {
    expect(normalizeAmount(-1n, 6)).toEqual({ error: "amount must be positive" });
    expect(normalizeAmount(0n, 6)).toEqual({ error: "amount must be positive" });
  });

  it("rejects negative / malformed / over-precision strings", () => {
    expect(normalizeAmount("-5", 6).error).toContain("not a valid");
    expect(normalizeAmount("abc", 6).error).toContain("not a valid");
    // 7 fraction digits exceeds 6-decimal token precision
    expect(normalizeAmount("1.0000001", 6).error).toContain("exceeds the 6-decimal precision");
  });

  it("rejects invalid decimals", () => {
    expect(normalizeAmount("1", -1).error).toContain("invalid token decimals");
  });
});

describe("execution — buildExecution aave plans", () => {
  it("builds a supply plan with sender wiring on onBehalfOf", () => {
    const plan = buildExecution(baseOrder()) as ExecutionPlan;
    expect(plan.address).toBe(AAVE_MAINNET);
    expect(plan.functionName).toBe("supply");
    expect(plan.senderIndex).toBe(2);
    expect(plan.args?.[0]).toBe(USDC_MAINNET);
    expect(plan.args?.[1]).toBe(1_000_000_000n);
    expect(plan.args?.[2]).toBe(zeroAddress);
    expect(plan.chainId).toBe(1);
  });

  it("builds a repay plan (variable rate) with sender on onBehalfOf", () => {
    const plan = buildExecution(baseOrder({ type: "repay" })) as ExecutionPlan;
    expect(plan.functionName).toBe("repay");
    expect(plan.senderIndex).toBe(3);
    expect(plan.args?.[2]).toBe(2n); // variable rate mode
  });

  it("builds a borrow plan", () => {
    const plan = buildExecution(baseOrder({ type: "borrow" })) as ExecutionPlan;
    expect(plan.functionName).toBe("borrow");
    expect(plan.senderIndex).toBe(4);
    expect(plan.args?.[2]).toBe(2n);
  });

  it("builds a withdraw plan", () => {
    const plan = buildExecution(baseOrder({ type: "withdraw" })) as ExecutionPlan;
    expect(plan.functionName).toBe("withdraw");
    expect(plan.senderIndex).toBe(2);
  });

  it("builds an approve plan against the Aave pool by default", () => {
    const plan = buildExecution(baseOrder({ type: "approve" })) as ExecutionPlan;
    expect(plan.functionName).toBe("approve");
    expect(plan.address).toBe(USDC_MAINNET);
    expect(plan.args?.[0]).toBe(AAVE_MAINNET);
    expect(plan.senderIndex).toBeUndefined();
  });

  it("rejects an aave order on an unsupported chain", () => {
    const res = buildExecution(baseOrder({ chainId: 9999 }));
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toContain("Aave v3 is not supported");
  });

  it("requires a token address for aave", () => {
    const res = buildExecution(baseOrder({ token: undefined }));
    expect((res as { error: string }).error).toContain("requires a token address");
  });

  it("propagates normalizeAmount errors (over-precision)", () => {
    const res = buildExecution(baseOrder({ amount: "1.0000001" }));
    expect((res as { error: string }).error).toContain("exceeds the 6-decimal precision");
  });

  it("rejects unsupported aave order type and unknown protocol", () => {
    const res = buildExecution(baseOrder({ type: "transfer" as Order["type"] }));
    expect((res as { error: string }).error).toContain("does not yet support order type");
    const res2 = buildExecution(baseOrder({ protocol: "weird" as Order["protocol"] }));
    expect((res2 as { error: string }).error).toContain("unknown protocol");
  });

  it("rejects an invalid chainId", () => {
    const res = buildExecution(baseOrder({ chainId: 0 }));
    expect((res as { error: string }).error).toContain("invalid chainId");
  });
});

describe("execution — eth native transfer + applySender", () => {
  it("builds a native transfer with a value", () => {
    const plan = buildExecution({
      type: "transfer",
      protocol: "eth",
      amount: "1", // 1 human ETH at 18 decimals
      decimals: 18,
      chainId: 1,
      to: "0xRecipient0000000000000000000000000000000",
    }) as ExecutionPlan;
    expect(plan.value).toBe(1_000_000_000_000_000_000n);
    expect(plan.address).toBe("0xRecipient0000000000000000000000000000000");
    expect(plan.senderIndex).toBeUndefined();
  });

  it("rejects native transfer without a 'to'", () => {
    const res = buildExecution({ type: "transfer", protocol: "eth", amount: "1", chainId: 1 });
    expect((res as { error: string }).error).toContain("requires a 'to' address");
  });

  it("rejects non-transfer for eth protocol", () => {
    const res = buildExecution({ type: "supply", protocol: "eth", amount: "1", chainId: 1 });
    expect((res as { error: string }).error).toContain("only supports 'transfer'");
  });

  it("patches the sender placeholder at execution time", () => {
    const plan = applySender(buildExecution(baseOrder()) as ExecutionPlan, SENDER);
    expect((plan as ExecutionPlan).args?.[2]).toBe(SENDER);
  });

  it("fails when a sender is required but not connected", () => {
    const res = applySender(buildExecution(baseOrder()) as ExecutionPlan, undefined);
    expect((res as { error: string }).error).toBe("wallet not connected");
  });

  it("returns plan unchanged when no sender placeholder", () => {
    const plan = buildExecution(baseOrder({ type: "approve" })) as ExecutionPlan;
    expect(applySender(plan, SENDER)).toBe(plan);
  });
});

const STETH_MAINNET = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84";

describe("execution — buildExecution lido stake plans", () => {
  it("builds a payable stake plan against Lido's stETH submit()", () => {
    const plan = buildExecution({
      type: "stake",
      protocol: "lido",
      symbol: "ETH",
      amount: "1",
      decimals: 18,
      chainId: 1,
    }) as ExecutionPlan;
    expect(plan.address).toBe(STETH_MAINNET);
    expect(plan.functionName).toBe("submit");
    expect(plan.args).toEqual([zeroAddress]);
    expect(plan.value).toBe(1_000_000_000_000_000_000n);
    expect(plan.senderIndex).toBeUndefined();
  });

  it("rejects Lido staking off mainnet", () => {
    const res = buildExecution({ type: "stake", protocol: "lido", amount: "1", decimals: 18, chainId: 8453 });
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toContain("only supported on Ethereum mainnet");
  });

  it("rejects a non-stake order type for Lido", () => {
    const res = buildExecution({ type: "supply" as Order["type"], protocol: "lido", amount: "1", decimals: 18, chainId: 1 });
    expect((res as { error: string }).error).toContain("only supports 'stake'");
  });

  it("propagates normalizeAmount errors for a stake order", () => {
    const res = buildExecution({ type: "stake", protocol: "lido", amount: "0", decimals: 18, chainId: 1 });
    expect((res as { error: string }).error).toBe("amount must be positive");
  });
});