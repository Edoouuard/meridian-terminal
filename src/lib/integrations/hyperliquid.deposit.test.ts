import { describe, expect, it } from "vitest";
import { resolveOrderForLeg } from "@/lib/assetMap";
import { buildExecution, type Order } from "@/lib/execution";
import { ARBITRUM_USDC, HYPERLIQUID_BRIDGE2 } from "@/lib/integrations/hyperliquidDeposit";
import { parseHlHoldings } from "@/lib/integrations/hyperliquid-live";
import { assetKind } from "@/lib/protocols/registry";
import { parseOpportunities } from "@/lib/protocols/opportunities";
import { isTrustedDebridgeEntrypoint, isTrustedLifiEntrypoint } from "@/lib/mcp/routerAllowlist";
import { chainIdFromName } from "@/lib/chains";

const prices = [{ symbol: "USDC", price: 1 }];

describe("Hyperliquid deposit", () => {
  it("resolves to a USDC transfer to Bridge2 on Arbitrum", () => {
    const o = resolveOrderForLeg({ side: "Deposit", asset: "USDC", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 50 }, undefined, prices, 42161) as Order;
    expect(o).toMatchObject({ type: "transfer", protocol: "erc20", token: ARBITRUM_USDC, to: HYPERLIQUID_BRIDGE2, amount: 50_000_000n, chainId: 42161 });
    const built = buildExecution(o);
    expect("error" in built).toBe(false);
    if (!("error" in built)) expect(built.description).toMatch(/Hyperliquid account/);
  });

  it("refuses other chains, other tokens and deposits under 5 USDC", () => {
    expect(resolveOrderForLeg({ side: "Deposit", asset: "USDC", protocol: "Hyperliquid", sizeUsd: 50 }, undefined, prices, 8453)).toHaveProperty("unsupported");
    expect(resolveOrderForLeg({ side: "Deposit", asset: "ETH", protocol: "Hyperliquid", sizeUsd: 50 }, undefined, prices, 42161)).toHaveProperty("unsupported");
    expect(resolveOrderForLeg({ side: "Deposit", asset: "USDC", protocol: "Hyperliquid", sizeUsd: 4 }, undefined, prices, 42161)).toHaveProperty("unsupported");
  });

  it("never builds a transfer to Bridge2 that Hyperliquid would not credit", () => {
    const base: Order = { type: "transfer", protocol: "erc20", token: ARBITRUM_USDC, symbol: "USDC", amount: 10_000_000n, chainId: 42161, decimals: 6, to: HYPERLIQUID_BRIDGE2 };
    expect(buildExecution({ ...base, token: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", symbol: "USDT" })).toHaveProperty("error");
    expect(buildExecution({ ...base, amount: 4_999_999n })).toHaveProperty("error");
    expect(buildExecution(base)).not.toHaveProperty("error");
  });
});

describe("Hyperliquid holdings", () => {
  it("parses spot balances and vault equity, dropping empties", () => {
    const h = parseHlHoldings(
      { balances: [{ coin: "USDC", total: "120.5" }, { coin: "HYPE", total: "0" }, { coin: "HYPE", total: "3" }] },
      [{ vaultAddress: "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303", equity: "250.1" }, { vaultAddress: "0xabc", equity: "0" }],
    );
    expect(h.spot).toEqual([{ coin: "USDC", total: 120.5 }, { coin: "HYPE", total: 3 }]);
    expect(h.vaults).toEqual([{ vaultAddress: "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303", equity: 250.1 }]);
    expect(parseHlHoldings(null, null)).toEqual({ spot: [], vaults: [] });
  });
});

describe("HyperEVM", () => {
  it("is routable: its own LI.FI diamond, deBridge DlnSource, chain name", () => {
    expect(isTrustedLifiEntrypoint(999, "0x0a0758d937d1059c356D4714e57F5df0239bce1A")).toBe(true);
    expect(isTrustedLifiEntrypoint(999, "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE")).toBe(false);
    expect(isTrustedDebridgeEntrypoint(999, "0xeF4fB24aD0916217251F553c0596F8Edc630EB66")).toBe(true);
    expect(chainIdFromName("HyperEVM")).toBe(999);
    expect(chainIdFromName("Hyperliquid L1")).toBeUndefined();
  });

  it("ranks Hyperliquid-ecosystem pools under HYPE, comparison only", () => {
    expect(assetKind("KHYPE")).toBe("hype");
    const out = parseOpportunities(
      [{ project: "kinetiq-khype", chain: "Hyperliquid L1", symbol: "KHYPE", apy: 1.94, apyBase: 1.94, tvlUsd: 854e6, exposure: "single" }],
      { kind: "hype" },
    );
    expect(out).toEqual([expect.objectContaining({ protocol: "Kinetiq", chain: "HyperEVM", chainId: 999, coverage: "watch" })]);
  });
});
