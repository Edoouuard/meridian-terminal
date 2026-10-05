import { describe, expect, it } from "vitest";
import {
  classifyExecutionError,
  createAaveSupplyPlan,
  isFailureState,
  isPlanExpired,
  isTerminalState,
  validateAaveSupplyPlan,
  EXECUTION_PLAN_VERSION,
  PLAN_TTL_MS,
  type AaveSupplyPlan,
} from "@/lib/executionPlan";

const WALLET = "0x1111111111111111111111111111111111111111" as const;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;

function basePlan(overrides: Partial<Parameters<typeof createAaveSupplyPlan>[0]> = {}): AaveSupplyPlan {
  return createAaveSupplyPlan({
    walletAddress: WALLET,
    chainId: 1,
    token: USDC,
    symbol: "USDC",
    decimals: 6,
    amount: 1_000_000n, // 1 USDC
    now: 1_000_000,
    ...overrides,
  });
}

describe("executionPlan — createAaveSupplyPlan", () => {
  it("stamps version, a planId, and an expiry PLAN_TTL_MS after createdAt", () => {
    const plan = basePlan();
    expect(plan.version).toBe(EXECUTION_PLAN_VERSION);
    expect(plan.planId.length).toBeGreaterThan(0);
    expect(plan.createdAt).toBe(1_000_000);
    expect(plan.expiresAt).toBe(1_000_000 + PLAN_TTL_MS);
  });

  it("generates distinct planIds across calls", () => {
    const a = basePlan();
    const b = basePlan();
    expect(a.planId).not.toBe(b.planId);
  });
});

describe("executionPlan — isPlanExpired", () => {
  it("is not expired right after creation", () => {
    const plan = basePlan();
    expect(isPlanExpired(plan, plan.createdAt)).toBe(false);
  });

  it("is not expired just before the TTL elapses", () => {
    const plan = basePlan();
    expect(isPlanExpired(plan, plan.expiresAt - 1)).toBe(false);
  });

  it("is expired exactly at and after expiresAt", () => {
    const plan = basePlan();
    expect(isPlanExpired(plan, plan.expiresAt)).toBe(true);
    expect(isPlanExpired(plan, plan.expiresAt + 1)).toBe(true);
  });
});

describe("executionPlan — validateAaveSupplyPlan", () => {
  const plan = basePlan();

  it("passes when wallet/chain match, plan is fresh, and balance covers the amount", () => {
    const result = validateAaveSupplyPlan(plan, {
      connectedAddress: WALLET,
      connectedChainId: 1,
      usdcBalance: 2_000_000n,
      now: plan.createdAt + 1,
    });
    expect(result.ok).toBe(true);
  });

  it("fails WRONG_CHAIN when the wallet is disconnected", () => {
    const result = validateAaveSupplyPlan(plan, {
      connectedAddress: undefined,
      connectedChainId: 1,
      usdcBalance: 2_000_000n,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.state).toBe("WRONG_CHAIN");
  });

  it("fails WRONG_CHAIN when a different wallet is now connected", () => {
    const other = "0x2222222222222222222222222222222222222222" as const;
    const result = validateAaveSupplyPlan(plan, {
      connectedAddress: other,
      connectedChainId: 1,
      usdcBalance: 2_000_000n,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.state).toBe("WRONG_CHAIN");
  });

  it("fails WRONG_CHAIN when connected to a different chain than the plan", () => {
    const result = validateAaveSupplyPlan(plan, {
      connectedAddress: WALLET,
      connectedChainId: 8453,
      usdcBalance: 2_000_000n,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.state).toBe("WRONG_CHAIN");
  });

  it("fails PLAN_EXPIRED once the TTL has elapsed", () => {
    const result = validateAaveSupplyPlan(plan, {
      connectedAddress: WALLET,
      connectedChainId: 1,
      usdcBalance: 2_000_000n,
      now: plan.expiresAt + 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.state).toBe("PLAN_EXPIRED");
  });

  it("fails INSUFFICIENT_BALANCE when the live balance is below the plan amount", () => {
    const result = validateAaveSupplyPlan(plan, {
      connectedAddress: WALLET,
      connectedChainId: 1,
      usdcBalance: 999_999n,
      now: plan.createdAt + 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.state).toBe("INSUFFICIENT_BALANCE");
  });

  it("treats an unreadable balance (undefined) as a non-blocking RPC error, not a silent pass", () => {
    const result = validateAaveSupplyPlan(plan, {
      connectedAddress: WALLET,
      connectedChainId: 1,
      usdcBalance: undefined,
      now: plan.createdAt + 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.state).toBe("RPC_ERROR");
  });

  it("accepts a balance exactly equal to the plan amount", () => {
    const result = validateAaveSupplyPlan(plan, {
      connectedAddress: WALLET,
      connectedChainId: 1,
      usdcBalance: plan.amount,
      now: plan.createdAt + 1,
    });
    expect(result.ok).toBe(true);
  });
});

describe("executionPlan — classifyExecutionError", () => {
  it("classifies a wallet rejection during approval as APPROVAL_REJECTED", () => {
    const r = classifyExecutionError(new Error("User rejected the request (4001)"), "approval");
    expect(r.state).toBe("APPROVAL_REJECTED");
  });

  it("classifies a wallet rejection during supply as SIGNATURE_REJECTED", () => {
    const r = classifyExecutionError(new Error("User denied transaction signature"), "supply");
    expect(r.state).toBe("SIGNATURE_REJECTED");
  });

  it("classifies a timeout as CONFIRMATION_TIMEOUT regardless of phase", () => {
    expect(classifyExecutionError(new Error("Timed out while waiting for receipt"), "supply").state).toBe(
      "CONFIRMATION_TIMEOUT",
    );
    expect(classifyExecutionError(new Error("timeout exceeded"), "approval").state).toBe("CONFIRMATION_TIMEOUT");
  });

  it("classifies an on-chain revert as TRANSACTION_REVERTED", () => {
    const r = classifyExecutionError(new Error("execution reverted: TRANSFER_AMOUNT_EXCEEDS_BALANCE"), "supply");
    expect(r.state).toBe("TRANSACTION_REVERTED");
  });

  it("falls back to APPROVAL_FAILED / RPC_ERROR for anything else, by phase", () => {
    expect(classifyExecutionError(new Error("network hiccup"), "approval").state).toBe("APPROVAL_FAILED");
    expect(classifyExecutionError(new Error("network hiccup"), "supply").state).toBe("RPC_ERROR");
  });

  it("handles a non-Error throw value", () => {
    const r = classifyExecutionError("some string failure", "supply");
    expect(r.state).toBe("RPC_ERROR");
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
