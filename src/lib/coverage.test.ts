import { describe, expect, it } from "vitest";
import { executableCoverage, PERP_VENUES } from "@/lib/coverage";
import { ACTIVE_CHAIN_IDS } from "@/lib/onchain";

describe("executable coverage (from the execution tables)", () => {
  const c = executableCoverage();
  const on = (name: string) => c.chains.find((x) => x.name === name)?.protocols ?? [];

  it("covers every active chain, and only those", () => {
    expect(c.chains.map((x) => x.chainId)).toEqual([...ACTIVE_CHAIN_IDS]);
  });

  it("lists a protocol only where Meridian holds its contract", () => {
    expect(on("Ethereum")).toEqual(expect.arrayContaining(["Aave", "Lido", "Pendle", "EigenLayer", "Sky", "Yearn", "Uniswap"]));
    expect(on("Base")).toEqual(expect.arrayContaining(["Aave", "Compound", "Pendle", "Renzo"]));
    expect(on("Base")).not.toContain("Lido");
    expect(on("HyperEVM")).toEqual(["LI.FI / deBridge"]);
  });

  it("counts distinct protocols across chains", () => {
    expect(c.protocols.length).toBeGreaterThanOrEqual(20);
    expect(new Set(c.protocols).size).toBe(c.protocols.length);
    expect(PERP_VENUES).toEqual(["Hyperliquid", "Extended", "TxFlow"]);
  });
});
