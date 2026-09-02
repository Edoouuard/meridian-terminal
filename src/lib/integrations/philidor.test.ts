import { describe, expect, it } from "vitest";
import { normalizeVault, PHILIDOR_PROTOCOL_ID } from "@/lib/integrations/philidor";

describe("philidor — normalizeVault", () => {
  it("normalizes a well-formed raw vault row", () => {
    const v = normalizeVault({
      id: "aave-1-0xabc",
      name: "Aave Ethereum USDC",
      address: "0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c",
      protocol_name: "Aave",
      chain_name: "Ethereum",
      chain_id: 1,
      asset_symbol: "USDC",
      asset_address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      tvl_usd: 2_284_335_608.5,
      apr_net: 0.0344,
      total_score: 9.02,
      risk_tier: "Prime",
      is_audited: true,
    });
    expect(v).not.toBeNull();
    expect(v!.id).toBe("aave-1-0xabc");
    expect(v!.address).toBe("0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c");
    expect(v!.chainId).toBe(1);
    expect(v!.assetAddress).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    expect(v!.riskTier).toBe("Prime");
    expect(v!.riskScore).toBe(9.02);
    expect(v!.isAudited).toBe(true);
    expect(v!.tvlUsd).toBeCloseTo(2_284_335_608.5);
  });

  it("returns null when id is missing", () => {
    expect(normalizeVault({ name: "x", total_score: 5, risk_tier: "Core" })).toBeNull();
  });

  it("returns null when name is missing", () => {
    expect(normalizeVault({ id: "x", total_score: 5, risk_tier: "Core" })).toBeNull();
  });

  it("returns null when total_score is missing or not a number", () => {
    expect(normalizeVault({ id: "x", name: "y", risk_tier: "Core" })).toBeNull();
    expect(normalizeVault({ id: "x", name: "y", total_score: "9" as unknown as number, risk_tier: "Core" })).toBeNull();
    expect(normalizeVault({ id: "x", name: "y", total_score: NaN, risk_tier: "Core" })).toBeNull();
  });

  it("returns null for an unrecognized risk tier", () => {
    expect(normalizeVault({ id: "x", name: "y", total_score: 5, risk_tier: "Junk" })).toBeNull();
    expect(normalizeVault({ id: "x", name: "y", total_score: 5 })).toBeNull();
  });

  it("defaults optional numeric/string/bool fields when absent", () => {
    const v = normalizeVault({ id: "x", name: "y", total_score: 5, risk_tier: "Edge" });
    expect(v).not.toBeNull();
    expect(v!.address).toBe("");
    expect(v!.protocol).toBe("");
    expect(v!.chain).toBe("");
    expect(v!.chainId).toBeNull();
    expect(v!.assetSymbol).toBe("");
    expect(v!.assetAddress).toBe("");
    expect(v!.tvlUsd).toBe(0);
    expect(v!.aprNet).toBe(0);
    expect(v!.isAudited).toBe(false);
  });

  it("rejects a malformed tvl_usd/apr_net rather than propagating garbage", () => {
    const v = normalizeVault({
      id: "x",
      name: "y",
      total_score: 5,
      risk_tier: "Core",
      tvl_usd: "not a number" as unknown as number,
      apr_net: NaN,
    });
    expect(v).not.toBeNull();
    expect(v!.tvlUsd).toBe(0);
    expect(v!.aprNet).toBe(0);
  });
});

describe("philidor — PHILIDOR_PROTOCOL_ID", () => {
  it("only maps lending/vault protocols Philidor actually scores", () => {
    expect(PHILIDOR_PROTOCOL_ID["Aave"]).toBe("aave");
    expect(PHILIDOR_PROTOCOL_ID["Morpho"]).toBe("morpho");
    expect(PHILIDOR_PROTOCOL_ID["Compound"]).toBe("compound");
    expect(PHILIDOR_PROTOCOL_ID["Spark"]).toBe("spark");
  });

  it("excludes directional-only perp venues and non-vault protocols", () => {
    expect(PHILIDOR_PROTOCOL_ID["Hyperliquid"]).toBeUndefined();
    expect(PHILIDOR_PROTOCOL_ID["Extended"]).toBeUndefined();
    expect(PHILIDOR_PROTOCOL_ID["Variational"]).toBeUndefined();
    expect(PHILIDOR_PROTOCOL_ID["Lido"]).toBeUndefined();
    expect(PHILIDOR_PROTOCOL_ID["Pendle"]).toBeUndefined();
  });
});
