import { formatUnits } from "viem";
import { useAccount, useBalance, useReadContract, useReadContracts } from "wagmi";
import { mainnet } from "wagmi/chains";
import { AAVE_NO_DEBT_HEALTH_FACTOR, AAVE_POOL_ABI, AAVE_V3_POOL_ADDRESS, ERC20_ABI, TRACKED_TOKENS } from "@/lib/onchain";
import { useLivePrices } from "./useLivePrices";

export interface LiveAsset {
  symbol: string;
  venue: string;
  balance: number;
  usd: number;
}

export interface LivePortfolio {
  isConnected: boolean;
  isLoading: boolean;
  assets: LiveAsset[];
  assetsUsd: number;
  aaveCollateralUsd: number;
  aaveDebtUsd: number;
  aaveAvailableToBorrowUsd: number;
  aaveLtvPct: number | null;
  /** null = no Aave debt (or not yet loaded/connected) — check isConnected to tell those apart. */
  healthFactor: number | null;
  netUsd: number;
}

export function useLivePortfolio(): LivePortfolio {
  const { address, isConnected } = useAccount();
  const { data: prices } = useLivePrices();

  const ethBalanceQuery = useBalance({ address, chainId: mainnet.id, query: { enabled: isConnected } });

  const tokenBalancesQuery = useReadContracts({
    contracts: TRACKED_TOKENS.map((token) => ({
      address: token.address,
      abi: ERC20_ABI,
      functionName: "balanceOf" as const,
      args: address ? ([address] as const) : undefined,
      chainId: mainnet.id,
    })),
    query: { enabled: isConnected && !!address },
  });

  const aaveQuery = useReadContract({
    address: AAVE_V3_POOL_ADDRESS,
    abi: AAVE_POOL_ABI,
    functionName: "getUserAccountData",
    args: address ? [address] : undefined,
    chainId: mainnet.id,
    query: { enabled: isConnected && !!address },
  });

  function priceOf(symbol: string): number {
    return prices?.find((p) => p.symbol === symbol)?.price ?? 0;
  }

  const ethBalance = ethBalanceQuery.data ? Number(formatUnits(ethBalanceQuery.data.value, 18)) : 0;
  const ethAsset: LiveAsset[] = ethBalance > 0 ? [{ symbol: "ETH", venue: "Wallet", balance: ethBalance, usd: ethBalance * priceOf("ETH") }] : [];

  const tokenAssets: LiveAsset[] = TRACKED_TOKENS.map((token, i) => {
    const entry = tokenBalancesQuery.data?.[i];
    if (!entry || entry.status !== "success") return null;
    const balance = Number(formatUnits(entry.result, token.decimals));
    if (balance <= 0) return null;
    return { symbol: token.symbol, venue: token.venue, balance, usd: balance * priceOf(token.priceSymbol) };
  }).filter((v): v is LiveAsset => v !== null);

  const assets = [...ethAsset, ...tokenAssets].sort((a, b) => b.usd - a.usd);
  const assetsUsd = assets.reduce((sum, a) => sum + a.usd, 0);

  const account = aaveQuery.data;
  const aaveCollateralUsd = account ? Number(formatUnits(account[0], 8)) : 0;
  const aaveDebtUsd = account ? Number(formatUnits(account[1], 8)) : 0;
  const aaveAvailableToBorrowUsd = account ? Number(formatUnits(account[2], 8)) : 0;
  const aaveLtvPct = account ? Number(account[4]) / 100 : null; // ltv is in basis points (100 = 1%)
  const rawHealthFactor = account?.[5];
  const healthFactor = rawHealthFactor === undefined || rawHealthFactor >= AAVE_NO_DEBT_HEALTH_FACTOR ? null : Number(formatUnits(rawHealthFactor, 18));

  const netUsd = assetsUsd + aaveCollateralUsd - aaveDebtUsd;

  return {
    isConnected,
    isLoading: ethBalanceQuery.isLoading || tokenBalancesQuery.isLoading || aaveQuery.isLoading,
    assets,
    assetsUsd,
    aaveCollateralUsd,
    aaveDebtUsd,
    aaveAvailableToBorrowUsd,
    aaveLtvPct,
    healthFactor,
    netUsd,
  };
}
