import { describe, expect, it } from "vitest";
import { deployableUsd, isLockedVenue } from "@/lib/budgetFit";
import { buildPortfolioView } from "@/lib/portfolioView";
import { READ_VAULTS, assetPrice, eigenLayerPosition, lidoWithdrawalPositions, morphoVaultPositions, vaultPositions } from "@/lib/defiPositions";
import { VAULTS } from "@/lib/protocols/vaults";

const prices: Record<string, number> = { ETH: 3000, USDC: 1, CRVUSD: 0.999 };
const priceOf = (s: string) => prices[s] ?? 0;

describe("defiPositions", () => {
  it("never reads a vault whose share token the wallet reader already counts (sUSDe)", () => {
    expect(READ_VAULTS.some((v) => v.shareSymbol === "sUSDe")).toBe(false);
    expect(READ_VAULTS.some((v) => v.shareSymbol === "scrvUSD")).toBe(true);
    expect(READ_VAULTS.length).toBeLessThan(VAULTS.length);
  });

  it("values vault shares by their underlying (convertToAssets) and the asset's price", () => {
    const rows = READ_VAULTS.filter((v) => ["fUSDC", "spETH", "scrvUSD"].includes(v.shareSymbol) && v.chainId === 1);
    const out = vaultPositions(
      rows.map((v) => (v.shareSymbol === "fUSDC" ? 250_500_000n : v.shareSymbol === "spETH" ? 2n * 10n ** 18n : undefined)),
      priceOf,
      rows,
    );
    expect(out).toEqual([
      { symbol: "USDC", venue: "Fluid vault · fUSDC", chain: "Ethereum", balance: 250.5, usd: 250.5 },
      { symbol: "WETH", venue: "Spark Savings vault · spETH", chain: "Ethereum", balance: 2, usd: 6000 },
    ]);
  });

  it("prices WETH and stETH as ETH, and an unpriced stablecoin at $1", () => {
    expect(assetPrice("WETH", priceOf)).toBe(3000);
    expect(assetPrice("stETH", priceOf)).toBe(3000);
    expect(assetPrice("GHO", priceOf)).toBe(1);
    expect(assetPrice("PEPE", priceOf)).toBe(0);
  });

  it("MetaMorpho vaults from the indexer, EigenLayer and Lido's queue", () => {
    expect(morphoVaultPositions([{ vaultName: "Steakhouse USDC", vaultAddress: "0x1", chainId: 8453, assetSymbol: "USDC", assetDecimals: 6, assets: "1000000000", assetsUsd: 1000.2 }], priceOf)).toEqual([
      { symbol: "USDC", venue: "Morpho vault · Steakhouse USDC", chain: "Base", balance: 1000, usd: 1000.2 },
    ]);
    expect(eigenLayerPosition(5n * 10n ** 17n, priceOf)).toEqual([{ symbol: "stETH", venue: "EigenLayer", chain: "Ethereum", balance: 0.5, usd: 1500 }]);
    const lido = lidoWithdrawalPositions(
      [
        { amountOfStETH: 10n ** 18n, isFinalized: false, isClaimed: false },
        { amountOfStETH: 2n * 10n ** 18n, isFinalized: true, isClaimed: false },
        { amountOfStETH: 9n * 10n ** 18n, isFinalized: true, isClaimed: true },
      ],
      priceOf,
    );
    expect(lido.map((r) => [r.venue, r.balance])).toEqual([
      ["Lido withdrawal (pending)", 1],
      ["Lido withdrawal (ready to claim)", 2],
    ]);
  });

  it("positions count in net worth (a 'DeFi positions' group), never in the free balance", () => {
    const assets = [
      { symbol: "USDC", venue: "Wallet", chain: "Base", balance: 100, usd: 100 },
      ...vaultPositions([250_000_000n], priceOf, READ_VAULTS.filter((v) => v.shareSymbol === "fUSDC" && v.chainId === 8453)),
      ...eigenLayerPosition(10n ** 18n, priceOf),
      ...lidoWithdrawalPositions([{ amountOfStETH: 10n ** 18n, isFinalized: false, isClaimed: false }], priceOf),
    ];
    expect(deployableUsd(assets)).toBe(100);
    expect(assets.slice(1).every((a) => isLockedVenue(a.venue))).toBe(true);
    const view = buildPortfolioView(assets, []);
    const defi = view.groups.find((g) => g.group === "defi")!;
    expect(defi.label).toBe("DeFi positions");
    // Restaked stETH and stETH in Lido's queue stay two rows.
    expect(defi.holdings.map((h) => `${h.symbol} ${h.venues[0]}`)).toEqual(["stETH EigenLayer", "stETH Lido withdrawal (pending)", "USDC Fluid vault · fUSDC"]);
    expect(view.totalUsd).toBe(100 + 250 + 3000 + 3000);
  });
});
