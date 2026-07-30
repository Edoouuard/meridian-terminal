import { formatUnits } from "viem";
import { useAccount, useBalance, useReadContract } from "wagmi";
import { mainnet } from "wagmi/chains";
import { AAVE_NO_DEBT_HEALTH_FACTOR, AAVE_POOL_ABI, AAVE_V3_POOL_ADDRESS, ERC20_ABI, STETH_ADDRESS } from "@/lib/onchain";
import { useLivePrices } from "./useLivePrices";

export interface LivePortfolio {
  isConnected: boolean;
  isLoading: boolean;
  ethBalance: number;
  stEthBalance: number;
  aaveCollateralUsd: number;
  aaveDebtUsd: number;
  /** null = no Aave debt (or not yet loaded/connected) — check isConnected to tell those apart. */
  healthFactor: number | null;
  netUsd: number;
}

export function useLivePortfolio(): LivePortfolio {
  const { address, isConnected } = useAccount();
  const { data: prices } = useLivePrices();

  const ethBalanceQuery = useBalance({ address, chainId: mainnet.id, query: { enabled: isConnected } });

  const stEthQuery = useReadContract({
    address: STETH_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: mainnet.id,
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

  const ethPrice = prices?.find((p) => p.symbol === "ETH")?.price ?? 0;

  const ethBalance = ethBalanceQuery.data ? Number(formatUnits(ethBalanceQuery.data.value, 18)) : 0;
  const stEthBalance = stEthQuery.data ? Number(formatUnits(stEthQuery.data, 18)) : 0;

  const account = aaveQuery.data;
  const aaveCollateralUsd = account ? Number(formatUnits(account[0], 8)) : 0;
  const aaveDebtUsd = account ? Number(formatUnits(account[1], 8)) : 0;
  const rawHealthFactor = account?.[5];
  const healthFactor = rawHealthFactor === undefined || rawHealthFactor >= AAVE_NO_DEBT_HEALTH_FACTOR ? null : Number(formatUnits(rawHealthFactor, 18));

  const netUsd = ethBalance * ethPrice + stEthBalance * ethPrice + aaveCollateralUsd - aaveDebtUsd;

  return {
    isConnected,
    isLoading: ethBalanceQuery.isLoading || stEthQuery.isLoading || aaveQuery.isLoading,
    ethBalance,
    stEthBalance,
    aaveCollateralUsd,
    aaveDebtUsd,
    healthFactor,
    netUsd,
  };
}
