import { describe, expect, it } from "vitest";
import { explainError, shortError, userFacingError } from "@/lib/errorText";
import { classifyExecutionError } from "@/lib/executionPlan";

const viemLike = (shortMessage: string, details = "") =>
  Object.assign(new Error(`${shortMessage}\n\nRequest Arguments:\n  from: 0xabc\n${details}\nVersion: viem@2.0.0`), { shortMessage });

describe("errorText — explainError", () => {
  it.each([
    ["insufficient funds for gas * price + value", "gas"],
    ["ERC20: transfer amount exceeds balance", "balance"],
    ["ERC20: insufficient allowance", "allowance"],
    ["Too little received", "slippage"],
    ["nonce too low", "pending-tx"],
    ["The current chain of the wallet (id: 1) does not match the target chain for the transaction (id: 8453)", "network-mismatch"],
    ["execution reverted: SUPPLY_CAP_EXCEEDED", "cap"],
    ["HTTP request failed. Status: 429", "rpc"],
  ])("recognises %s", (msg, cause) => {
    expect(explainError(new Error(msg)).cause).toBe(cause);
  });

  it("quotes a revert reason it doesn't know", () => {
    expect(explainError(new Error("execution reverted: BAD_THING")).text).toBe("The contract refused the transaction: BAD_THING.");
  });

  it("treats a revert wrapped in an RPC internal error as a revert, not a network problem", () => {
    expect(explainError(new Error("RPC error -32603: execution reverted: BAD_THING")).cause).toBe("revert");
  });
});

describe("errorText — user-facing text", () => {
  it("keeps one short technical line, never viem's multi-line dump", () => {
    const err = viemLike("HTTP request failed.", "URL: https://rpc\nStatus: 503");
    expect(shortError(err)).toBe("HTTP request failed.");
    const text = userFacingError(err);
    expect(text).toContain("didn't answer");
    expect(text).not.toContain("Request Arguments");
    expect(text).not.toContain("\n");
  });

  it("classifier: no gas money is the user's balance problem, with a clear sentence", () => {
    const c = classifyExecutionError(new Error("insufficient funds for gas * price + value"), "supply");
    expect(c.state).toBe("INSUFFICIENT_BALANCE");
    expect(c.message).toMatch(/network fee/);
  });
});
