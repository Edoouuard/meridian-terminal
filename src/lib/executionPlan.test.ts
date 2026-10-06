import { describe, expect, it } from "vitest";
import type { Order } from "@/lib/execution";
import {
  classifyExecutionError,
  createOrderPlan,
  isFailureState,
  isPlanExpired,
  isTerminalState,
  isWalletDebitingAction,
  validateOrderPlan,
  EXECUTION_PLAN_VERSION,
  PLAN_TTL_MS,
} from "@/lib/executionPlan";

const WALLET = "0x1111111111111111111111111111111111111111" as const;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;

const supplyOrder: Order = {
  type: "supply",
  protocol: "aave",
  token: USDC,
  symbol: "USDC",
  amount: 1_000_000n,
  chainId: 1,
  decimals: 6,
};

describe("executionPlan — createOrderPlan", () => {
  it("stamps version, a planId, and an expiry PLAN_TTL_MS after createdAt", () => {
    const plan = createOrderPlan(WALLET, supplyOrder, 1_000_000);
    expect(plan.version).toBe(EXECUTION_PLAN_VERSION);
    expect(plan.planId.length).toBeGreaterThan(0);
    expect(plan.createdAt).toBe(1_000_000);
    expect(plan.expiresAt).toBe(1_000_000 + PLAN_TTL_MS);
    expect(plan.order).toBe(supplyOrder);
  });

  it("generates distinct planIds across calls", () => {
    const a = createOrderPlan(WALLET, supplyOrder);
    const b = createOrderPlan(WALLET, supplyOrder);
    expect(a.planId).not.toBe(b.planId);
  });
});

describe("executionPlan — isPlanExpired", () => {
  it("is not expired right after creation", () => {
    const plan = createOrderPlan(WALLET, supplyOrder, 1_000_000);
    expect(isPlanExpired(plan, plan.createdAt)).toBe(false);
  });

  it("is not expired just before the TTL elapses", () => {
    const plan = createOrderPlan(WALLET, supplyOrder, 1_000_000);
    expect(isPlanExpired(plan, plan.expiresAt - 1)).toBe(false);
  });

  it("is expired exactly at and after expiresAt", () => {
    const plan = createOrderPlan(WALLET, supplyOrder, 1_000_000);
    expect(isPlanExpired(plan, plan.expiresAt)).toBe(true);
    expect(isPlanExpired(plan, plan.expiresAt + 1)).toBe(true);
  });
});

describe("executionPlan — isWalletDebitingAction", () => {
  it("flags every debiting action supported across protocols", () => {
    expect(isWalletDebitingAction({ protocol: "aave", type: "supply" })).toBe(true);
    expect(isWalletDebitingAction({ protocol: "uniswap", type: "swap" })).toBe(true);
    expect(isWalletDebitingAction({ protocol: "weth", type: "withdraw" })).toBe(true);
    expect(isWalletDebitingAction({ protocol: "lido", type: "unstake" })).toBe(true);
    expect(isWalletDebitingAction({ protocol: "debridge", type: "swap" })).toBe(true);
    expect(isWalletDebitingAction({ protocol: "lifi", type: "swap" })).toBe(true);
    expect(isWalletDebitingAction({ protocol: "eth", type: "transfer" })).toBe(true);
  });

  it("does not flag receiving actions (borrow/withdraw-from-protocol/claim)", () => {
    expect(isWalletDebitingAction({ protocol: "aave", type: "borrow" })).toBe(false);
    expect(isWalletDebitingAction({ protocol: "aave", type: "withdraw" })).toBe(false);
    expect(isWalletDebitingAction({ protocol: "morpho", type: "withdraw" })).toBe(false);
    expect(isWalletDebitingAction({ protocol: "lido", type: "claim" })).toBe(false);
  });
});

describe("executionPlan — validateOrderPlan", () => {
  const plan = createOrderPlan(WALLET, supplyOrder, 1_000_000);

  it("passes when wallet/chain match, plan is fresh, and balance covers a debiting order", () => {
    const result = validateOrderPlan(plan, {
      connectedAddress: WALLET,
      connectedChainId: 1,
      liveBalance: 2_000_000n,
      now: plan.createdAt + 1,
    });
    expect(result.ok).toBe(true);
  });

  it("fails WRONG_CHAIN when the wallet is disconnected", () => {
    const result = validateOrderPlan(plan, { connectedAddress: undefined, connectedChainId: 1, liveBalance: 2_000_000n });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.state).toBe("WRONG_CHAIN");
  });

  it("fails WRONG_CHAIN when a different wallet is now connected", () => {
    const other = "0x2222222222222222222222222222222222222222" as const;
    const result = validateOrderPlan(plan, { connectedAddress: other, connectedChainId: 1, liveBalance: 2_000_000n });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.state).toBe("WRONG_CHAIN");
  });

  it("fails WRONG_CHAIN when connected to a different chain than the order", () => {
    const result = validateOrderPlan(plan, { connectedAddress: WALLET, connectedChainId: 8453, liveBalance: 2_000_000n });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.state).toBe("WRONG_CHAIN");
  });

  it("fails PLAN_EXPIRED once the TTL has elapsed", () => {
    const result = validateOrderPlan(plan, {
      connectedAddress: WALLET,
      connectedChainId: 1,
      liveBalance: 2_000_000n,
      now: plan.expiresAt + 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.state).toBe("PLAN_EXPIRED");
  });

  it("fails INSUFFICIENT_BALANCE when the live balance is below the order amount", () => {
    const result = validateOrderPlan(plan, {
      connectedAddress: WALLET,
      connectedChainId: 1,
      liveBalance: 999_999n,
      now: plan.createdAt + 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.state).toBe("INSUFFICIENT_BALANCE");
  });

  it("treats an unreadable balance (undefined) as a non-blocking RPC error for a debiting order", () => {
    const result = validateOrderPlan(plan, { connectedAddress: WALLET, connectedChainId: 1, now: plan.createdAt + 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.state).toBe("RPC_ERROR");
  });

  it("skips the balance check entirely for a non-debiting order (e.g. borrow)", () => {
    const borrowPlan = createOrderPlan(WALLET, { ...supplyOrder, type: "borrow" }, 1_000_000);
    const result = validateOrderPlan(borrowPlan, { connectedAddress: WALLET, connectedChainId: 1, now: borrowPlan.createdAt + 1 });
    expect(result.ok).toBe(true);
  });

  it("accepts a balance exactly equal to the order amount", () => {
    const result = validateOrderPlan(plan, {
      connectedAddress: WALLET,
      connectedChainId: 1,
      liveBalance: supplyOrder.amount as bigint,
      now: plan.createdAt + 1,
    });
    expect(result.ok).toBe(true);
  });
});

describe("executionPlan — classifyExecutionError", () => {
  it("classifies a wallet rejection during approval as APPROVAL_REJECTED", () => {
    expect(classifyExecutionError(new Error("User rejected the request (4001)"), "approval").state).toBe("APPROVAL_REJECTED");
  });

  it("classifies a wallet rejection during the main order as SIGNATURE_REJECTED", () => {
    expect(classifyExecutionError(new Error("User denied transaction signature"), "supply").state).toBe("SIGNATURE_REJECTED");
  });

  it("classifies a timeout as CONFIRMATION_TIMEOUT regardless of phase", () => {
    expect(classifyExecutionError(new Error("Timed out while waiting for receipt"), "supply").state).toBe("CONFIRMATION_TIMEOUT");
    expect(classifyExecutionError(new Error("timeout exceeded"), "approval").state).toBe("CONFIRMATION_TIMEOUT");
  });

  it("classifies an on-chain revert as TRANSACTION_REVERTED", () => {
    expect(classifyExecutionError(new Error("execution reverted: TRANSFER_AMOUNT_EXCEEDS_BALANCE"), "supply").state).toBe(
      "TRANSACTION_REVERTED",
    );
  });

  it("falls back to APPROVAL_FAILED / RPC_ERROR for anything else, by phase", () => {
    expect(classifyExecutionError(new Error("network hiccup"), "approval").state).toBe("APPROVAL_FAILED");
    expect(classifyExecutionError(new Error("network hiccup"), "supply").state).toBe("RPC_ERROR");
  });

  it("handles a non-Error throw value", () => {
    expect(classifyExecutionError("some string failure", "supply").state).toBe("RPC_ERROR");
  });
});

describe("executionPlan — terminal/failure state helpers", () => {
  it("CONFIRMED and every failure state are terminal", () => {
    expect(isTerminalState("CONFIRMED")).toBe(true);
    expect(isTerminalState("INSUFFICIENT_BALANCE")).toBe(true);
    expect(isTerminalState("TRANSACTION_REVERTED")).toBe(true);
  });

  it("in-flight states are not terminal", () => {
    expect(isTerminalState("DRAFT")).toBe(false);
    expect(isTerminalState("VALIDATING")).toBe(false);
    expect(isTerminalState("SIMULATING")).toBe(false);
    expect(isTerminalState("READY_FOR_SIGNATURE")).toBe(false);
    expect(isTerminalState("APPROVAL_PENDING")).toBe(false);
    expect(isTerminalState("APPROVAL_CONFIRMED")).toBe(false);
    expect(isTerminalState("SUPPLY_PENDING")).toBe(false);
    expect(isTerminalState("CONFIRMING")).toBe(false);
  });

  it("isFailureState agrees with isTerminalState minus CONFIRMED", () => {
    expect(isFailureState("CONFIRMED")).toBe(false);
    expect(isFailureState("WRONG_CHAIN")).toBe(true);
    expect(isFailureState("INVALID_AMOUNT")).toBe(true);
    expect(isFailureState("SIMULATION_FAILED")).toBe(true);
    expect(isFailureState("APPROVAL_FAILED")).toBe(true);
    expect(isFailureState("RPC_ERROR")).toBe(true);
    expect(isFailureState("CONFIRMATION_TIMEOUT")).toBe(true);
  });
});
