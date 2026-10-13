import { describe, expect, it } from "vitest";
import { chainIdFromName, legChainId } from "@/lib/chains";

describe("chains", () => {
  it("maps the names the LLM and DefiLlama use", () => {
    expect(chainIdFromName("Base")).toBe(8453);
    expect(chainIdFromName(" arbitrum ")).toBe(42161);
    expect(chainIdFromName("OP Mainnet")).toBe(10);
    expect(chainIdFromName("Narnia")).toBeUndefined();
    expect(chainIdFromName(undefined)).toBeUndefined();
  });

  it("executes a leg on the chain the plan names, not the wallet's current chain", () => {
    expect(legChainId({ chain: "Base" }, 1)).toBe(8453);
  });

  it("falls back to the wallet's chain only when the leg names none or an unknown one", () => {
    expect(legChainId({}, 42161)).toBe(42161);
    expect(legChainId({ chain: "Narnia" }, 42161)).toBe(42161);
  });
});
