import { describe, expect, it } from "vitest";
import { getAddress, isAddress } from "viem";
import { VAULTS, findVault, isTrustedVault } from "@/lib/protocols/vaults";
import { isExecutablePool } from "@/lib/protocols/registry";
import { parseOpportunities } from "@/lib/protocols/opportunities";
import { approveOrderFor, resolveOrderForLeg } from "@/lib/assetMap";
import { buildExecution, type Order } from "@/lib/execution";
import { isWalletDebitingAction } from "@/lib/executionPlan";

const prices = [
  { symbol: "USDC", price: 1 },
  { symbol: "USDT", price: 1 },
  { symbol: "USDS", price: 1 },
  { symbol: "USDE", price: 1 },
  { symbol: "ETH", price: 2500 },
];

describe("vault registry", () => {
  it("holds checksummed addresses and one row per vault", () => {
    for (const v of VAULTS) {
      expect(isAddress(v.vault) && getAddress(v.vault) === v.vault, `${v.shareSymbol} vault`).toBe(true);
      expect(isAddress(v.assetAddress) && getAddress(v.assetAddress) === v.assetAddress, `${v.shareSymbol} asset`).toBe(true);
    }
    expect(new Set(VAULTS.map((v) => `${v.chainId}:${v.vault}`)).size).toBe(VAULTS.length);
  });

  it("finds a vault by protocol + deposited asset or share token, per chain", () => {
    expect(findVault("Fluid", "USDC", 8453)?.shareSymbol).toBe("fUSDC");
    expect(findVault("fluid", "USDT", 42161)?.shareSymbol).toBe("fUSDT");
    expect(findVault("Sky", "USDS", 1)?.shareSymbol).toBe("sUSDS");
    expect(findVault("Sky", "sUSDS", 1)?.shareSymbol).toBe("sUSDS");
    expect(findVault("Spark Savings", "USDC", 42161)?.shareSymbol).toBe("sUSDC");
    expect(findVault("Ethena", "USDe", 1)?.shareSymbol).toBe("sUSDe");
    expect(findVault("Spark Savings", "USDT", 1)?.shareSymbol).toBe("spUSDT");
    expect(findVault("Spark Savings", "ETH", 1)?.shareSymbol).toBe("spETH");
    expect(findVault("Yearn", "USDC", 1)?.shareSymbol).toBe("yvUSDC-1");
    expect(findVault("yearn v3", "ETH", 1)?.shareSymbol).toBe("yvWETH-1");
    expect(findVault("Yearn", "USDC", 8453)).toBeUndefined();
    expect(findVault("Fluid", "DAI", 1)).toBeUndefined();
    expect(findVault("Aave", "USDC", 1)).toBeUndefined();
  });
});

describe("vault execution", () => {
  it("resolves a Fluid leg to a deposit into the verified vault, approve first", () => {
    const order = resolveOrderForLeg({ side: "Supply", asset: "USDC", protocol: "Fluid", sizeUsd: 100, chain: "Base" }, undefined, prices, 8453) as Order;
    expect(order).toMatchObject({ type: "supply", protocol: "vault", chainId: 8453, amount: 100_000_000n, vaultAddress: findVault("Fluid", "USDC", 8453)!.vault });
    expect(isWalletDebitingAction(order)).toBe(true);

    const approve = buildExecution(approveOrderFor(order)!);
    expect("error" in approve).toBe(false);
    if (!("error" in approve)) {
      expect(approve.address).toBe(order.token);
      expect(approve.args?.[0]).toBe(order.vaultAddress);
    }
    const deposit = buildExecution(order);
    expect("error" in deposit).toBe(false);
    if (!("error" in deposit)) {
      expect(deposit.address).toBe(order.vaultAddress);
      expect(deposit.functionName).toBe("deposit");
    }
  });

  it("refuses an unlisted vault address, a wrong asset, and a chain without a vault", () => {
    const base: Order = { type: "supply", protocol: "vault", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", amount: 1_000_000n, chainId: 8453, decimals: 6 };
    expect(buildExecution({ ...base, vaultAddress: "0x000000000000000000000000000000000000dEaD" })).toHaveProperty("error");
    expect(buildExecution({ ...base, vaultAddress: findVault("Fluid", "USDC", 8453)!.vault, token: "0x4200000000000000000000000000000000000006" })).toHaveProperty("error");
    expect(resolveOrderForLeg({ side: "Supply", asset: "USDC", protocol: "Fluid", sizeUsd: 100 }, undefined, prices, 137)).toHaveProperty("unsupported");
  });

  it("won't build a direct withdraw from sUSDe (cooldown)", () => {
    const v = findVault("Ethena", "USDe", 1)!;
    expect(isTrustedVault(1, v.vault)).toBeDefined();
    expect(buildExecution({ type: "withdraw", protocol: "vault", token: v.assetAddress, symbol: "USDe", amount: 1n, chainId: 1, decimals: 18, vaultAddress: v.vault })).toHaveProperty("error");
  });

  it("keeps 'Sky' + DAI on the existing sDAI path", () => {
    expect(resolveOrderForLeg({ side: "Supply", asset: "DAI", protocol: "Sky", sizeUsd: 10 }, undefined, [...prices, { symbol: "DAI", price: 1 }], 1)).toMatchObject({ protocol: "maker" });
  });
});

describe("DefiLlama opportunities", () => {
  const pool = (o: Record<string, unknown>) => ({ exposure: "single", ilRisk: "no", outlier: false, tvlUsd: 50e6, apy: 5, apyBase: 5, ...o });
  const raw = [
    pool({ project: "fluid-lending", chain: "Base", symbol: "USDC", apy: 9.67, apyBase: 6.16, apyReward: 3.51 }),
    pool({ project: "aave-v3", chain: "Arbitrum", symbol: "USDC", apy: 4.1 }),
    pool({ project: "maple", chain: "Ethereum", symbol: "USDC", apy: 5.3 }),
    pool({ project: "unknown-farm", chain: "Base", symbol: "USDC", apy: 30 }),
    pool({ project: "aave-v3", chain: "Fantom", symbol: "USDC", apy: 8 }),
    pool({ project: "aave-v3", chain: "Base", symbol: "USDC", apy: 3.9, tvlUsd: 1e6 }),
    pool({ project: "aave-v3", chain: "Base", symbol: "USDC-WETH", exposure: "multi", apy: 12 }),
    pool({ project: "fluid-lending", chain: "Ethereum", symbol: "USDC", apy: 95 }),
    pool({ project: "lido", chain: "Ethereum", symbol: "STETH", apy: 2.2 }),
  ];

  it("keeps covered protocols on the 7 chains, drops thin, LP, unknown and absurd pools, ranks by APY", () => {
    const out = parseOpportunities(raw, { kind: "stable" });
    expect(out.map((o) => `${o.protocol}/${o.chain}`)).toEqual(["Fluid/Base", "Maple/Ethereum", "Aave/Arbitrum"]);
    expect(out[0]).toMatchObject({ coverage: "execute", shareSymbol: "fUSDC", apyReward: 3.51 });
    expect(out[1].coverage).toBe("watch");
  });

  it("splits ETH from stablecoins", () => {
    expect(parseOpportunities(raw, { kind: "eth" }).map((o) => o.protocol)).toEqual(["Lido"]);
  });

  it("marks executability per chain", () => {
    expect(isExecutablePool("sparklend", 1, "USDC")).toBe(true);
    expect(isExecutablePool("sparklend", 8453, "USDC")).toBe(false);
    expect(isExecutablePool("fluid-lending", 137, "USDC")).toBe(false);
    expect(isExecutablePool("maple", 1, "USDC")).toBe(false);
  });
});
