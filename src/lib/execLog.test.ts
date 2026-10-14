import { describe, expect, it } from "vitest";
import { isActionableFailure, sanitizeExecEvent } from "@/lib/execLog";

const HASH = "0x" + "a".repeat(64);
const ADDR = "0x" + "b".repeat(40);

describe("execLog — sanitizeExecEvent", () => {
  it("keeps a confirmed execution's metadata", () => {
    const e = sanitizeExecEvent({ planId: "p-1", state: "CONFIRMED", chainId: 8453, protocol: "aave", type: "supply", symbol: "USDC", amount: "100.5", address: ADDR, hash: HASH });
    expect(e).toEqual({ planId: "p-1", state: "CONFIRMED", outcome: "success", chainId: 8453, protocol: "aave", type: "supply", symbol: "USDC", amount: "100.5", address: ADDR, hash: HASH, reason: undefined });
  });

  it("marks failures and caps the reason", () => {
    const e = sanitizeExecEvent({ state: "TRANSACTION_REVERTED", reason: "reverted\n" + "x".repeat(2000) });
    expect(e?.outcome).toBe("failure");
    expect(e?.reason?.length).toBe(500);
    expect(e?.reason).not.toContain("\n");
  });

  it("rejects unknown states and junk bodies", () => {
    expect(sanitizeExecEvent({ state: "HACKED" })).toBeNull();
    expect(sanitizeExecEvent(null)).toBeNull();
    expect(sanitizeExecEvent("CONFIRMED")).toBeNull();
  });

  it("drops malformed fields and anything not in the schema", () => {
    const e = sanitizeExecEvent({ state: "CONFIRMED", address: "not-an-address", hash: "0x123", chainId: -1, amount: "1e18", privateKey: "0xdead", signature: "0xbeef" });
    expect(e).toMatchObject({ address: undefined, hash: undefined, chainId: undefined, amount: undefined });
    expect(e).not.toHaveProperty("privateKey");
    expect(e).not.toHaveProperty("signature");
  });
});

describe("execLog — which failures alert", () => {
  it("alerts on infrastructure and venue failures, not on the user's own choices", () => {
    for (const s of ["SIMULATION_FAILED", "APPROVAL_FAILED", "TRANSACTION_REVERTED", "RPC_ERROR", "CONFIRMATION_TIMEOUT"] as const) expect(isActionableFailure(s)).toBe(true);
    for (const s of ["CONFIRMED", "SIGNATURE_REJECTED", "APPROVAL_REJECTED", "INSUFFICIENT_BALANCE", "WRONG_CHAIN", "INVALID_AMOUNT", "PLAN_EXPIRED"] as const) expect(isActionableFailure(s)).toBe(false);
  });
});
