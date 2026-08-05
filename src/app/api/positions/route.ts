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

/** Query the Morpho Blue indexer for a wallet's positions (market + vault). */
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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address") ?? "";

  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "A valid EVM address is required." }, { status: 400 });
  }

  try {
    const morpho = await fetchMorphoPositions(address);
    return NextResponse.json({ address, positions: [...morpho] });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message || "Indexer lookup failed." },
      { status: 502 },
    );
  }
}
