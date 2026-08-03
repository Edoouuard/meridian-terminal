import { formatUnits } from "viem";
import { useAccount, useBalance, useReadContracts } from "wagmi";
import { arbitrum, avalanche, base, mainnet, optimism, polygon } from "wagmi/chains";
import {
  AAVE_NO_DEBT_HEALTH_FACTOR,
  AAVE_POOL_ABI,
  AAVE_V3_POOL_BY_CHAIN,
  CHAIN_LABEL,
  ERC20_ABI,
  SUPPORTED_CHAINS,
  TRACKED_TOKENS_BY_CHAIN,
} from "@/lib/onchain";
import { ethPriceFromAssets, netEthDelta, stakingConcentration } from "@/lib/riskModel";
import { useLivePrices } from "./useLivePrices";

export interface LiveAsset {
  symbol: string;
  venue: string;
  chain: string;
  balance: number;
  usd: number;
}

export interface LiveAavePosition {
  chain: string;
  collateralUsd: number;
  debtUsd: number;
  availableToBorrowUsd: number;
  ltvPct: number;
  healthFactor: number | null;
}

export interface LivePortfolio {
  isConnected: boolean;
  isLoading: boolean;
  assets: LiveAsset[];
  assetsUsd: number;
  aavePositions: LiveAavePosition[];
  aaveCollateralUsd: number;
  aaveDebtUsd: number;
  /** The Aave position most at risk (lowest health factor), driving the Risk panel's gauge. */
  riskAave: LiveAavePosition | null;
  /** null = no Aave debt anywhere (or not yet loaded/connected) — check isConnected to tell those apart. */
  healthFactor: number | null;
  netUsd: number;
  /** Net directional spot exposure to ETH (tracked ETH/WETH/stETH/wstETH holdings), in ETH units. */
  netDeltaEth: number | null;
  /** Approximate ETH price (derived from tracked holdings) used to size the flatten trade. */
  ethPrice: number | null;
  /** stETH + wstETH as a percent of net portfolio value. */
  stakingConcentrationPct: number | null;
}

export function useLivePortfolio(): LivePortfolio {
  const { address, isConnected } = useAccount();
  const { data: prices } = useLivePrices();

  // Native balances — one explicit useBalance call per supported chain. Hooks can't be
  // called in a loop/map, so this list is unrolled to match SUPPORTED_CHAINS exactly.
  const mainnetBalance = useBalance({ address, chainId: mainnet.id, query: { enabled: isConnected } });
  const baseBalance = useBalance({ address, chainId: base.id, query: { enabled: isConnected } });
  const arbitrumBalance = useBalance({ address, chainId: arbitrum.id, query: { enabled: isConnected } });
  const optimismBalance = useBalance({ address, chainId: optimism.id, query: { enabled: isConnected } });
  const polygonBalance = useBalance({ address, chainId: polygon.id, query: { enabled: isConnected } });
  const avalancheBalance = useBalance({ address, chainId: avalanche.id, query: { enabled: isConnected } });
  const nativeBalanceByChainId: Record<number, typeof mainnetBalance> = {
    [mainnet.id]: mainnetBalance,
    [base.id]: baseBalance,
    [arbitrum.id]: arbitrumBalance,
    [optimism.id]: optimismBalance,
    [polygon.id]: polygonBalance,
    [avalanche.id]: avalancheBalance,
  };

  // ERC20 balanceOf across every chain's tracked token list, in one batched call
  // (wagmi groups same-chain entries into a single multicall each).
  const tokenContracts = SUPPORTED_CHAINS.flatMap((chain) =>
    (TRACKED_TOKENS_BY_CHAIN[chain.id] ?? []).map((token) => ({
      address: token.address,
      abi: ERC20_ABI,
      functionName: "balanceOf" as const,
      args: address ? ([address] as const) : undefined,
      chainId: chain.id,
    })),
  );
  const tokenBalancesQuery = useReadContracts({
    contracts: tokenContracts,
    query: { enabled: isConnected && !!address },
  });

  // Aave v3 getUserAccountData, one call per chain, likewise batched into one hook.
  const aaveContracts = SUPPORTED_CHAINS.map((chain) => ({
    address: AAVE_V3_POOL_BY_CHAIN[chain.id],
    abi: AAVE_POOL_ABI,
    functionName: "getUserAccountData" as const,
    args: address ? ([address] as const) : undefined,
    chainId: chain.id,
  }));
  const aaveQuery = useReadContracts({
    contracts: aaveContracts,
    query: { enabled: isConnected && !!address },
  });

  function priceOf(symbol: string): number {
    return prices?.find((p) => p.symbol === symbol)?.price ?? 0;
  }

  const nativeAssets: LiveAsset[] = SUPPORTED_CHAINS.map((chain) => {
    const q = nativeBalanceByChainId[chain.id];
    if (!q.data) return null;
    const balance = Number(formatUnits(q.data.value, q.data.decimals));
    if (balance <= 0) return null;
    return { symbol: q.data.symbol, venue: "Wallet", chain: CHAIN_LABEL[chain.id], balance, usd: balance * priceOf(q.data.symbol) };
  }).filter((v): v is LiveAsset => v !== null);

  const tokenAssets: LiveAsset[] = [];
  let tokenIndex = 0;
  for (const chain of SUPPORTED_CHAINS) {
    for (const token of TRACKED_TOKENS_BY_CHAIN[chain.id] ?? []) {
      const entry = tokenBalancesQuery.data?.[tokenIndex];
      tokenIndex++;
      if (!entry || entry.status !== "success") continue;
      const balance = Number(formatUnits(entry.result, token.decimals));
      if (balance <= 0) continue;
      tokenAssets.push({ symbol: token.symbol, venue: token.venue, chain: CHAIN_LABEL[chain.id], balance, usd: balance * priceOf(token.priceSymbol) });
    }
  }

  const assets = [...nativeAssets, ...tokenAssets].sort((a, b) => b.usd - a.usd);
  const assetsUsd = assets.reduce((sum, a) => sum + a.usd, 0);

  const aavePositions: LiveAavePosition[] = SUPPORTED_CHAINS.map((chain, i) => {
    const entry = aaveQuery.data?.[i];
    if (!entry || entry.status !== "success") return null;
    const [totalCollateralBase, totalDebtBase, availableBorrowsBase, , ltv, rawHealthFactor] = entry.result;
    const collateralUsd = Number(formatUnits(totalCollateralBase, 8));
    const debtUsd = Number(formatUnits(totalDebtBase, 8));
    if (collateralUsd <= 0 && debtUsd <= 0) return null;
    const healthFactor = rawHealthFactor >= AAVE_NO_DEBT_HEALTH_FACTOR ? null : Number(formatUnits(rawHealthFactor, 18));
    return {
      chain: CHAIN_LABEL[chain.id],
      collateralUsd,
      debtUsd,
      availableToBorrowUsd: Number(formatUnits(availableBorrowsBase, 8)),
      ltvPct: Number(ltv) / 100,
      healthFactor,
    };
  }).filter((v): v is LiveAavePosition => v !== null);

  const aaveCollateralUsd = aavePositions.reduce((sum, p) => sum + p.collateralUsd, 0);
  const aaveDebtUsd = aavePositions.reduce((sum, p) => sum + p.debtUsd, 0);

  const positionsWithDebt = aavePositions.filter((p) => p.healthFactor !== null);
  const riskAave =
    positionsWithDebt.length > 0
      ? positionsWithDebt.reduce((worst, p) => ((p.healthFactor as number) < (worst.healthFactor as number) ? p : worst))
      : (aavePositions[0] ?? null);

  const netUsd = assetsUsd + aaveCollateralUsd - aaveDebtUsd;

  // Risk metrics derived from the live tracked holdings (spot only — perps on
  // Hyperliquid/Extended aren't wired up yet, so netDeltaEth is the spot book).
  // All of this math lives in the pure riskModel engine so the hook and the
  // Risk panel compute identical numbers.
  const ethPrice = ethPriceFromAssets(assets);
  const netDeltaEth = netEthDelta(assets, ethPrice);
  const stakingConcentrationPct = stakingConcentration(assets, netUsd);

  return {
    isConnected,
    isLoading:
      Object.values(nativeBalanceByChainId).some((q) => q.isLoading) || tokenBalancesQuery.isLoading || aaveQuery.isLoading,
    assets,
    assetsUsd,
    aavePositions,
    aaveCollateralUsd,
    aaveDebtUsd,
    riskAave,
    healthFactor: riskAave?.healthFactor ?? null,
    netUsd,
    netDeltaEth,
    ethPrice,
    stakingConcentrationPct,
  };
}
