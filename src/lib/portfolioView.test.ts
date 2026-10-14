import { describe, expect, it } from "vitest";
import { allocationSlices, buildPortfolioView, dayChangeUsd, fmtAmount, fmtPrice, holdingGroup } from "@/lib/portfolioView";

const assets = [
  { symbol: "ETH", venue: "Wallet", chain: "Ethereum", balance: 1, usd: 3000 },
  { symbol: "ETH", venue: "Wallet", chain: "Arbitrum", balance: 0.5, usd: 1500 },
  { symbol: "USDC", venue: "Wallet", chain: "Base", balance: 1200, usd: 1200 },
  { symbol: "wstETH", venue: "Wallet", chain: "Ethereum", balance: 0.4, usd: 1400 },
  { symbol: "HYPE", venue: "Hyperliquid staking", chain: "Hyperliquid L1", balance: 10, usd: 400 },
  { symbol: "HYPE", venue: "Hyperliquid spot", chain: "Hyperliquid L1", balance: 2, usd: 80 },
  { symbol: "USDC", venue: "Hyperliquid perps", chain: "Hyperliquid L1", balance: 500, usd: 500 },
  { symbol: "HLP", venue: "Hyperliquid HLP", chain: "Hyperliquid L1", balance: 250, usd: 250 },
];
const lending = [
  { chain: "Base", protocol: "Aave v3", collateralUsd: 2000, debtUsd: 500, healthFactor: 2.1 },
  { chain: "Hyperliquid L1", protocol: "Hyperliquid lending", collateralUsd: 0, debtUsd: 0, healthFactor: null },
];

describe("portfolioView", () => {
  it("classifies holdings", () => {
    expect(holdingGroup({ symbol: "ETH", venue: "Wallet" })).toBe("crypto");
    expect(holdingGroup({ symbol: "USDT0", venue: "Wallet" })).toBe("stable");
    expect(holdingGroup({ symbol: "wstETH", venue: "Wallet" })).toBe("staking");
    expect(holdingGroup({ symbol: "HYPE", venue: "Hyperliquid staking" })).toBe("staking");
    expect(holdingGroup({ symbol: "HYPE", venue: "Hyperliquid spot" })).toBe("crypto");
    expect(holdingGroup({ symbol: "USDC", venue: "Hyperliquid perps" })).toBe("hyperliquid");
  });

  it("merges a token across chains, groups and orders by value, adds lending net", () => {
    const v = buildPortfolioView(assets, lending, (s) => (s === "ETH" ? 2 : undefined));
    expect(v.groups.map((g) => g.group)).toEqual(["crypto", "stable", "staking", "lending", "hyperliquid"]);
    const eth = v.groups[0].holdings[0];
    expect(eth).toMatchObject({ symbol: "ETH", balance: 1.5, usd: 4500, price: 3000, change24h: 2, chains: ["Ethereum", "Arbitrum"] });
    expect(v.groups.find((g) => g.group === "lending")?.usd).toBe(1500);
    expect(v.lending).toHaveLength(1); // the empty Hyperliquid lending row is dropped
    expect(v.totalUsd).toBe(4580 + 1200 + 1800 + 1500 + 750);
  });

  it("computes the 24h change from priced holdings only", () => {
    const v = buildPortfolioView(assets, [], (s) => (s === "ETH" ? 2 : undefined));
    const d = dayChangeUsd(v)!;
    expect(d.usd).toBeCloseTo(4500 - 4500 / 1.02, 6);
    expect(dayChangeUsd(buildPortfolioView(assets, []))).toBeNull();
  });

  it("formats amounts and prices with sensible precision", () => {
    expect(fmtAmount(0.00432123)).toBe("0.004321");
    expect(fmtAmount(1.234567)).toBe("1.2346");
    expect(fmtAmount(12345.67)).toBe("12,345.7");
    expect(fmtPrice(98450.4)).toBe("$98,450");
    expect(fmtPrice(3412.2)).toBe("$3,412");
    expect(fmtPrice(25.5)).toBe("$25.50");
    expect(fmtPrice(0.45213)).toBe("$0.4521");
  });
});

describe("portfolioView — allocation slices", () => {
  const assets = [
    { symbol: "ETH", venue: "Wallet", chain: "Base", balance: 1, usd: 3000 },
    { symbol: "USDC", venue: "Wallet", chain: "Arbitrum", balance: 1000, usd: 1000 },
    { symbol: "USDC", venue: "Wallet", chain: "Base", balance: 1000, usd: 1000 },
  ];
  const view = buildPortfolioView(assets, [{ chain: "Ethereum", protocol: "Aave", collateralUsd: 500, debtUsd: 100, healthFactor: 3 }]);

  it("splits by type with shares of the positive total, biggest first", () => {
    const s = allocationSlices(view, "type");
    expect(s.map((x) => x.key)).toEqual(["crypto", "stable", "lending"]);
    expect(s[0].share).toBeCloseTo(3000 / 5400, 5);
    expect(s.reduce((a, x) => a + x.share, 0)).toBeCloseTo(1, 5);
  });

  it("splits by chain, lending counted net on its chain", () => {
    const s = allocationSlices(view, "chain");
    expect(s.find((x) => x.key === "Base")?.usd).toBe(4000);
    expect(s.find((x) => x.key === "Arbitrum")?.usd).toBe(1000);
    expect(s.find((x) => x.key === "Ethereum")?.usd).toBe(400);
  });

  it("folds the chain tail into Other past the cap", () => {
    const many = buildPortfolioView(
      ["Base", "Arbitrum", "Ethereum", "Optimism", "Polygon", "BNB Chain"].map((chain, i) => ({ symbol: "USDC", venue: "Wallet", chain, balance: 10 + i, usd: 10 + i })),
      [],
    );
    const s = allocationSlices(many, "chain", 5);
    expect(s).toHaveLength(5);
    expect(s[4].label).toBe("Other");
  });
});
