import { describe, expect, it } from "vitest";
import { resolveOrderForLeg } from "@/lib/assetMap";
import { buildExecution, type Order } from "@/lib/execution";
import { ARBITRUM_USDC, HYPERLIQUID_BRIDGE2 } from "@/lib/integrations/hyperliquidDeposit";
import { parseClearinghouseState, parseHlHoldings } from "@/lib/integrations/hyperliquid-live";
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
  // Shapes taken from live info API responses (portfolio-margin account with lending + staking).
  const spotMeta = [
    { universe: [{ tokens: [150, 0], index: 107 }, { tokens: [268, 0], index: 166 }] },
    Object.assign(new Array(200).fill({}), { 107: { markPx: "81.91", midPx: "81.9105" }, 166: { markPx: "1.0", midPx: null } }),
  ];
  const raw = {
    spot: {
      balances: [
        { coin: "USDC", token: 0, total: "10171.6", hold: "9847.7" },
        { coin: "HYPE", token: 150, total: "14", hold: "7.9" },
        { coin: "USDT0", token: 268, total: "0", hold: "-324.1" },
      ],
    },
    vaults: [{ vaultAddress: "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303", equity: "250.1" }, { vaultAddress: "0xabc", equity: "0" }],
    borrowLend: {
      tokenToState: [
        [0, { borrow: { basis: "417.5", value: "417.6" }, supply: { basis: "0.0", value: "0.0" } }],
        [150, { borrow: { basis: "0.0", value: "0.0" }, supply: { basis: "14", value: "14" } }],
      ],
      health: "healthy",
      healthFactor: "1.78",
    },
    delegator: { delegated: "12", undelegated: "0.5", totalPendingWithdrawal: "1", nPendingWithdrawals: 1 },
    abstraction: "portfolioMargin",
    spotMeta,
  };

  it("splits lent spot balances, reads borrows, staking, account mode and marks", () => {
    const h = parseHlHoldings(raw);
    expect(h.spot).toEqual([
      { coin: "USDC", total: 10171.6, supplied: 0, px: 1 },
      { coin: "HYPE", total: 14, supplied: 14, px: 81.9105 },
    ]);
    expect(h.borrows).toEqual([{ coin: "USDC", amount: 417.6, px: 1 }]);
    expect(h.lendingHealthFactor).toBe(1.78);
    expect(h.stakedHype).toBe(13.5);
    expect(h.hypePx).toBe(81.9105);
    expect(h.unified).toBe(true);
    expect(h.vaults).toEqual([{ vaultAddress: "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303", equity: 250.1 }]);
  });

  it("degrades to empty holdings when every read failed", () => {
    expect(parseHlHoldings({})).toEqual({ spot: [], borrows: [], lendingHealthFactor: null, stakedHype: 0, hypePx: 0, unified: false, vaults: [] });
    expect(parseHlHoldings({ abstraction: "default" }).unified).toBe(false);
  });

  it("reads the perps account from the top-level clearinghouseState response", () => {
    const acc = parseClearinghouseState({
      marginSummary: { accountValue: "86251.17", totalMarginUsed: "1200" },
      withdrawable: "500",
      assetPositions: [{ position: { coin: "ETH", szi: "-2", entryPx: "3000", positionValue: "6000", unrealizedPnl: "40", leverage: { value: 5 } } }],
    });
    expect(acc.accountValue).toBe(86251.17);
    expect(acc.positions).toHaveLength(1);
    expect(acc.positions[0]).toMatchObject({ coin: "ETH", size: -2, unrealizedPnl: 40 });
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
