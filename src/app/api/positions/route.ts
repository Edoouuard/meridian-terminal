import { NextResponse } from "next/server";

export const revalidate = 30;

const MORPHO_INDEXER = "https://blue-api.morpho.org/graphql";

/**
 * A normalized position read from the Morpho Blue official indexer.
 * Morpho identifies positions by market, so we need an indexer (no plain-RPC
 * "list my markets" view exists); the official blue-api indexer exposes exactly
 * that and requires no API key. Values are already USD floats from the indexer.
 */
export interface IndexedLendingPosition {
  protocol: string;
  venue: string;
  collateralUsd: number;
  supplyUsd: number;
  borrowUsd: number;
  loanSymbol?: string;
  collateralSymbol?: string;
}

/**
 * A MetaMorpho vault position — distinct from a Blue market position above.
 * This is what a Meridian "supply on Morpho" order actually creates (an
 * ERC-4626 deposit into a vault), so it's what a "withdraw from Morpho"
 * order needs to know about: which vault, how many assets, on which chain.
 */
export interface IndexedVaultPosition {
  vaultAddress: string;
  vaultName: string;
  chainId: number;
  assetSymbol: string;
  assetAddress: string;
  assetDecimals: number;
  /** Raw underlying-asset units the position is worth, as a decimal string (exact, from the indexer's BigInt). */
  assets: string;
  assetsUsd: number;
}

/** Query the Morpho Blue indexer for a wallet's market positions (collateral/borrow). */
async function fetchMorphoPositions(address: string): Promise<IndexedLendingPosition[]> {
  const query = `
    query UserPositions($user: String!) {
      marketPositions(first: 100, where: { userAddress_in: [$user] }) {
        items {
          market {
            collateralAsset { symbol }
            loanAsset { symbol }
          }
          state { supplyAssetsUsd borrowAssetsUsd collateralUsd }
        }
      }
    }
  `;
  const res = await fetch(MORPHO_INDEXER, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { user: address.toLowerCase() } }),
    next: { revalidate: 30 },
  });
  if (!res.ok) throw new Error(`Morpho indexer responded ${res.status}`);
  const json = await res.json();
  const items = json?.data?.marketPositions?.items ?? [];
  const positions: IndexedLendingPosition[] = [];
  for (const it of items) {
    const s = it.state ?? {};
    const supplyUsd = Number(s.supplyAssetsUsd ?? 0) || 0;
    const borrowUsd = Number(s.borrowAssetsUsd ?? 0) || 0;
    const collateralUsd = Number(s.collateralUsd ?? 0) || 0;
    if (supplyUsd <= 0 && borrowUsd <= 0 && collateralUsd <= 0) continue;
    positions.push({
      protocol: "Morpho Blue",
      venue: "Indexer",
      collateralUsd,
      supplyUsd,
      borrowUsd,
      loanSymbol: it.market?.loanAsset?.symbol,
      collateralSymbol: it.market?.collateralAsset?.symbol,
    });
  }
  return positions;
}

/** Query the Morpho indexer for a wallet's MetaMorpho vault (ERC-4626) positions. */
async function fetchMorphoVaultPositions(address: string): Promise<IndexedVaultPosition[]> {
  const query = `
    query UserVaultPositions($user: String!) {
      vaultPositions(first: 100, where: { userAddress_in: [$user] }) {
        items {
          vault {
            address
            name
            chain { id }
            asset { symbol address decimals }
          }
          state { assets assetsUsd }
        }
      }
    }
  `;
  const res = await fetch(MORPHO_INDEXER, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { user: address.toLowerCase() } }),
    next: { revalidate: 30 },
  });
  if (!res.ok) throw new Error(`Morpho indexer responded ${res.status}`);
  const json = await res.json();
  const items = json?.data?.vaultPositions?.items ?? [];
  const positions: IndexedVaultPosition[] = [];
  for (const it of items) {
    const assets = String(it.state?.assets ?? "0");
    if (!assets || assets === "0") continue;
    const v = it.vault ?? {};
    positions.push({
      vaultAddress: v.address,
      vaultName: v.name ?? "Morpho vault",
      chainId: Number(v.chain?.id ?? 0),
      assetSymbol: v.asset?.symbol ?? "",
      assetAddress: v.asset?.address ?? "",
      assetDecimals: Number(v.asset?.decimals ?? 18),
      assets,
      assetsUsd: Number(it.state?.assetsUsd ?? 0) || 0,
    });
  }
  return positions;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address") ?? "";

  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "A valid EVM address is required." }, { status: 400 });
  }

  try {
    const [morpho, vaults] = await Promise.all([fetchMorphoPositions(address), fetchMorphoVaultPositions(address)]);
    return NextResponse.json({ address, positions: [...morpho], vaults });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message || "Indexer lookup failed." },
      { status: 502 },
    );
  }
}
