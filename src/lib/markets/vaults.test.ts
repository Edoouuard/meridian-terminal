import { describe, expect, it } from "vitest";
import {
  PARADEX_GIGAVAULT_ADDRESS,
  parseExtendedVault,
  parseGainsUsdc,
  parseGmxGlvs,
  parseHlp,
  parseJlp,
  parseLighterLlp,
  parseMegavault,
  parseParadexVault,
  rankVaults,
} from "./vaults";

// Samples are trimmed from the protocols' real answers on 24 Oct 2026.
describe("perp vault parsers", () => {
  it("HLP: Hyperliquid's APR, TVL from the month's account value; Meridian deposits into it", () => {
    const v = parseHlp({ apr: 0.0412, portfolio: [["day", {}], ["month", { accountValueHistory: [[1, "370000000.0"], [2, "381234567.5"]] }]] });
    expect(v?.aprPct).toBeCloseTo(4.12, 6);
    expect(v?.tvlUsd).toBeCloseTo(381234567.5, 1);
    expect(v?.executable).toBe(true);
  });

  it("Extended: last30dApr is a fraction", () => {
    const v = parseExtendedVault({ status: "OK", data: { equity: "60273815.648749", last30dApr: "0.0806", numberOfDepositors: 14804 } });
    expect(v?.aprPct).toBeCloseTo(8.06, 6);
    expect(v?.tvlUsd).toBeCloseTo(60273815.65, 1);
    expect(v?.executable).toBe(false);
  });

  it("Lighter: the pool named LLP, its yield already in %", () => {
    const v = parseLighterLlp({ code: 200, public_pools: [{ account_index: 281474976710654, name: "Lighter Liquidity Provider (LLP)", annual_percentage_yield: 14.294034529940413, total_asset_value: "93410460.31828004" }] });
    expect(v?.aprPct).toBeCloseTo(14.29, 2);
    expect(v?.tvlUsd).toBeCloseTo(93410460.32, 1);
    expect(parseLighterLlp({ code: 200, public_pools: [] })).toBeNull();
  });

  it("Paradex GigaVault: last_month_return is already annualised, not annualised again", () => {
    const v = parseParadexVault({ results: [{ address: "0xother", last_month_return: "9" }, { address: PARADEX_GIGAVAULT_ADDRESS, tvl: "2391969.112919", roi_30d: "0.0157", last_month_return: "0.20612701281109125" }] });
    expect(v?.aprPct).toBeCloseTo(20.61, 2);
    expect(v?.tvlUsd).toBeCloseTo(2391969.11, 1);
  });

  it("Jupiter JLP: APY in %, AUM in USD", () => {
    const v = parseJlp({ jlpApyPct: "6.28", aumUsdFormatted: "850737561.75" });
    expect(v?.aprPct).toBeCloseTo(6.28, 6);
    expect(v?.tvlUsd).toBeCloseTo(850737561.75, 1);
  });

  it("GMX GLVs: APY by token, names and TVL (30-decimal USD) from glvs/info", () => {
    const apy = { glvs: { "0x528A5bac7E746C9A509A1f4F6dF58A03d44279F9": { apy: 0.16472435625702908 }, "0xUNLISTED": { apy: 0.5 } } };
    const info = {
      glvs: [
        { name: "GLV [ETH-USDC]", glvToken: "0x528A5bac7E746C9A509A1f4F6dF58A03d44279F9", isListed: true, markets: [{ balanceUsd: "5681700755885583961132469487823190461" }, { balanceUsd: "244308880221909732417350785448773120" }] },
        { name: "GLV [OLD]", glvToken: "0xUNLISTED", isListed: false, markets: [] },
      ],
    };
    const vs = parseGmxGlvs(apy, info, "Arbitrum");
    expect(vs).toHaveLength(1);
    expect(vs[0].name).toBe("GLV [ETH-USDC]");
    expect(vs[0].asset).toBe("ETH / USDC");
    expect(vs[0].aprPct).toBeCloseTo(16.47, 2);
    expect(vs[0].tvlUsd).toBeCloseTo(5_926_009.64, 0);
  });

  it("Gains gUSDC: vaultApr in %, TVL with 6 decimals", () => {
    const v = parseGainsUsdc({ collateralRewards: [{ symbol: "DAI", vaultApr: 0 }, { symbol: "USDC", vaultTvl: "4216979373583", vaultApr: 7.9436885153 }] }, "Arbitrum");
    expect(v?.aprPct).toBeCloseTo(7.94, 2);
    expect(v?.tvlUsd).toBeCloseTo(4216979.37, 1);
    expect(v?.id).toBe("gains-usdc-arbitrum");
  });

  it("dYdX MegaVault: 30 days of PnL over the starting equity, annualised; null with under a week of history", () => {
    const now = Date.parse("2026-10-24T00:00:00Z");
    const day = (d: number) => new Date(now - d * 86_400_000).toISOString();
    const rows = [
      { equity: "1000000", totalPnl: "4000000", createdAt: day(40) },
      { equity: "1000000", totalPnl: "4600000", createdAt: day(30) },
      { equity: "1010000", totalPnl: "4610000", createdAt: day(0) },
    ];
    const v = parseMegavault({ megavaultPnl: rows }, now);
    expect(v?.aprPct).toBeCloseTo((10000 / 1000000) * (365 / 30) * 100, 6);
    expect(v?.tvlUsd).toBe(1010000);
    expect(parseMegavault({ megavaultPnl: rows.slice(2).concat({ equity: "1", totalPnl: "1", createdAt: day(3) }) }, now)).toBeNull();
  });

  it("a protocol that doesn't answer is left out, the rest ranked by APR", () => {
    const ranked = rankVaults([parseJlp({ jlpApyPct: "6.28" }), parseHlp(null), parseExtendedVault({ data: { last30dApr: "0.0806" } }), parseJlp({ jlpApyPct: "99999" })]);
    expect(ranked.map((v) => v.id)).toEqual(["extended", "jlp"]);
  });
});
