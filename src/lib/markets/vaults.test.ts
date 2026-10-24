import { describe, expect, it } from "vitest";
import { emptyVault, PARADEX_GIGAVAULT_ADDRESS, parseExtendedVault, parseHlp, parseParadexVault, rankVaults } from "./vaults";

describe("perp vault parsers", () => {
  it("Extended's vault summary (real answer, 24 Oct 2026)", () => {
    const v = parseExtendedVault({ status: "OK", data: { equity: "60273815.648749", last30dApr: "0.0806", numberOfDepositors: 14804, ageDays: 563 } });
    expect(v.tvlUsd).toBeCloseTo(60273815.65, 1);
    expect(v.aprPct).toBeCloseTo(8.06, 6);
    expect(v.depositors).toBe(14804);
    expect(v.meridianPrompt).toBeUndefined();
  });

  it("Paradex GigaVault: TVL, 30-day ROI, and last month's return, already annualised by Paradex, as the APR", () => {
    const v = parseParadexVault({ results: [{ address: "0xother", tvl: "9" }, { address: PARADEX_GIGAVAULT_ADDRESS, tvl: "2391969.112919", roi_30d: "0.0157", last_month_return: "0.20612701281109125", num_depositors: 3464 }] });
    expect(v.tvlUsd).toBeCloseTo(2391969.11, 1);
    expect(v.return30dPct).toBeCloseTo(1.57, 6);
    expect(v.aprPct).toBeCloseTo(20.61, 2); // arb.sh shows the same vault at +20.6%
  });

  it("HLP: APR from vaultDetails, TVL and 30-day return from the month's histories", () => {
    const v = parseHlp({
      apr: 0.039,
      followers: [{}, {}],
      portfolio: [
        ["day", { accountValueHistory: [[1, "1"]], pnlHistory: [[1, "0"]] }],
        ["month", { accountValueHistory: [[1, "176000000"], [2, "177100000"]], pnlHistory: [[1, "1000000"], [2, "1563200"]] }],
      ],
    });
    expect(v.aprPct).toBeCloseTo(3.9, 6);
    expect(v.tvlUsd).toBe(177_100_000);
    expect(v.return30dPct).toBeCloseTo((563_200 / 176_000_000) * 100, 6);
    expect(v.meridianPrompt).toMatch(/HLP/);
  });

  it("a missing answer gives a vault with no numbers, ranked last", () => {
    expect(parseHlp(null).aprPct).toBeNull();
    const ranked = rankVaults([emptyVault("paradex"), parseExtendedVault({ data: { last30dApr: "0.08" } }), parseHlp({ apr: 0.04 })]);
    expect(ranked.map((v) => v.id)).toEqual(["extended", "hlp", "paradex"]);
  });
});
