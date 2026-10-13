import { describe, expect, it } from "vitest";
import { isAddress } from "viem";
import * as onchain from "@/lib/onchain";
import * as uniswap from "@/lib/integrations/uniswap";
import * as routerAllowlist from "@/lib/mcp/routerAllowlist";

/** Every hex address in the signing tables, with its path (e.g. "onchain.TRACKED_TOKENS_BY_CHAIN.10.4.address"). */
function collectAddresses(value: unknown, path: string, out: [string, string][] = []): [string, string][] {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) out.push([path, value]);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) collectAddresses(v, `${path}.${k}`, out);
  return out;
}

describe("address tables", () => {
  it("only hold valid EIP-55 addresses (viem rejects a bad checksum at signing time)", () => {
    const bad = collectAddresses({ onchain, uniswap, routerAllowlist }, "").filter(([, a]) => !isAddress(a));
    expect(bad).toEqual([]);
  });
});
