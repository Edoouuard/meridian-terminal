/**
 * defiPositions.ts — money the user has put to work outside the wallet, read
 * on-chain and turned into portfolio rows: shares of the verified ERC-4626
 * vaults, MetaMorpho vault positions (indexer), stETH restaked on EigenLayer
 * and stETH waiting in Lido's withdrawal queue.
 *
 * These count in net worth, never in the free balance: every venue here is
 * something other than "Wallet"/"Lido", so lib/budgetFit treats it as locked.
 * Pure: the hook (hooks/useDefiPositions) reads the chain, this file values.
 */

import { formatUnits } from "viem";
import { CHAIN_LABEL, TRACKED_TOKENS_BY_CHAIN } from "@/lib/onchain";
import { VAULTS, type VaultEntry } from "@/lib/protocols/vaults";

export interface PositionAsset {
  symbol: string;
  venue: string;
  chain: string;
  /** Amount of the underlying the position is worth (USDC for a USDC vault, stETH for restaked stETH). */
  balance: number;
  usd: number;
}

/** Venues of the rows this file produces (portfolioView groups them as "DeFi positions"). */
export const POSITION_VENUE = /\b(vault|savings|llamalend|pendle|eigenlayer|withdrawal)\b/i;

/**
 * The vaults whose shares are read here: every verified row whose share token
 * isn't already a tracked wallet token (sUSDe is both: the wallet reader
 * already counts it, reading it again would count it twice).
 */
export const READ_VAULTS: VaultEntry[] = VAULTS.filter(
  (v) => !(TRACKED_TOKENS_BY_CHAIN[v.chainId] ?? []).some((t) => t.address.toLowerCase() === v.vault.toLowerCase()),
);

/** The two ERC-4626 reads behind a vault position. */
export const ERC4626_READ_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "convertToAssets", stateMutability: "view", inputs: [{ name: "shares", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

const STABLE = /^(USDC|USDT|USDS|DAI|USDE|GHO|CRVUSD|PYUSD)$/;

/** The /api/prices symbol for an asset (WETH → ETH, crvUSD → CRVUSD…); stables default to $1 when unpriced. */
export function assetPrice(symbol: string, priceOf: (symbol: string) => number): number {
  const s = symbol.toUpperCase();
  const key = s === "WETH" ? "ETH" : s === "STETH" ? "ETH" : s;
  return priceOf(key) || (STABLE.test(s) ? 1 : 0);
}

const label = (chainId: number) => CHAIN_LABEL[chainId] ?? String(chainId);

/** Vault rows from the raw reads: `assets[i]` is convertToAssets(shares) for READ_VAULTS[i] (undefined = not held / not read). */
export function vaultPositions(assets: (bigint | undefined)[], priceOf: (symbol: string) => number, rows: VaultEntry[] = READ_VAULTS): PositionAsset[] {
  const out: PositionAsset[] = [];
  rows.forEach((v, i) => {
    const raw = assets[i];
    if (raw === undefined || raw <= 0n) return;
    const balance = Number(formatUnits(raw, v.assetDecimals));
    out.push({ symbol: v.assetSymbol, venue: `${v.protocol} vault · ${v.shareSymbol}`, chain: label(v.chainId), balance, usd: balance * assetPrice(v.assetSymbol, priceOf) });
  });
  return out;
}

export interface MorphoVaultLike {
  vaultName: string;
  vaultAddress: string;
  chainId: number;
  assetSymbol: string;
  assetDecimals: number;
  assets: string;
  assetsUsd: number;
}

/** MetaMorpho vault positions from the Morpho indexer (already in USD). */
export function morphoVaultPositions(vaults: MorphoVaultLike[], priceOf: (symbol: string) => number): PositionAsset[] {
  return vaults
    .map((v) => {
      let balance = 0;
      try {
        balance = Number(formatUnits(BigInt(v.assets), v.assetDecimals));
      } catch {
        return null;
      }
      if (!(balance > 0)) return null;
      const usd = v.assetsUsd > 0 ? v.assetsUsd : balance * assetPrice(v.assetSymbol, priceOf);
      return { symbol: v.assetSymbol, venue: `Morpho vault · ${v.vaultName || v.assetSymbol}`, chain: label(v.chainId), balance, usd };
    })
    .filter((p): p is PositionAsset => p !== null);
}

/** stETH restaked on EigenLayer: the strategy's sharesToUnderlyingView(shares), in stETH. */
export function eigenLayerPosition(underlyingStEth: bigint | undefined, priceOf: (symbol: string) => number): PositionAsset[] {
  if (underlyingStEth === undefined || underlyingStEth <= 0n) return [];
  const balance = Number(formatUnits(underlyingStEth, 18));
  return [{ symbol: "stETH", venue: "EigenLayer", chain: label(1), balance, usd: balance * assetPrice("stETH", priceOf) }];
}

export interface PendleLike {
  chainId: number;
  kind: "PT" | "YT" | "LP";
  symbol: string;
  balance: number;
  usd: number;
  expiry?: string;
}

/** "27 Nov 2026" */
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** Pendle PT / YT / LP (valued by Pendle), with the maturity in the venue; a matured PT is redeemable 1:1. */
export function pendlePositions(rows: PendleLike[], now: Date = new Date()): PositionAsset[] {
  return rows
    .filter((r) => r.usd > 0)
    .map((r) => {
      const matured = r.expiry ? Date.parse(r.expiry) <= now.getTime() : false;
      const when = r.expiry ? (matured ? " · matured, redeemable" : ` · matures ${fmtDate(r.expiry)}`) : "";
      return { symbol: r.symbol, venue: `Pendle ${r.kind}${when}`, chain: label(r.chainId), balance: r.balance, usd: r.usd };
    });
}

export interface LidoRequestLike {
  amountOfStETH: bigint;
  isFinalized: boolean;
  isClaimed: boolean;
}

/** Unclaimed Lido withdrawal requests: pending ones and those ready to claim, one row each kind. */
export function lidoWithdrawalPositions(requests: LidoRequestLike[], priceOf: (symbol: string) => number): PositionAsset[] {
  const sum = (finalized: boolean) =>
    requests.filter((r) => !r.isClaimed && r.isFinalized === finalized).reduce((a, r) => a + r.amountOfStETH, 0n);
  const px = assetPrice("ETH", priceOf);
  const rows: PositionAsset[] = [];
  const pending = sum(false);
  const ready = sum(true);
  if (pending > 0n) {
    const balance = Number(formatUnits(pending, 18));
    rows.push({ symbol: "stETH", venue: "Lido withdrawal (pending)", chain: label(1), balance, usd: balance * px });
  }
  if (ready > 0n) {
    const balance = Number(formatUnits(ready, 18));
    rows.push({ symbol: "ETH", venue: "Lido withdrawal (ready to claim)", chain: label(1), balance, usd: balance * px });
  }
  return rows;
}
