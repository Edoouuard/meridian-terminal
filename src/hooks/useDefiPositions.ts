import { useCallback } from "react";
import { useReadContract, useReadContracts } from "wagmi";
import type { Address } from "viem";
import { SUPPORTED_CHAINS } from "@/lib/onchain";
import { EIGENLAYER_SHARES_TO_UNDERLYING_ABI, EIGENLAYER_STAKER_SHARES_ABI, EIGENLAYER_STETH_STRATEGY, EIGENLAYER_STRATEGY_MANAGER } from "@/lib/integrations/eigenlayer";
import { LIDO_GET_WITHDRAWAL_REQUESTS_ABI, LIDO_GET_WITHDRAWAL_STATUS_ABI, LIDO_WITHDRAWAL_QUEUE_ADDRESS } from "@/lib/integrations/lido";
import {
  ERC4626_READ_ABI,
  READ_VAULTS,
  eigenLayerPosition,
  lidoWithdrawalPositions,
  morphoVaultPositions,
  vaultPositions,
  type MorphoVaultLike,
  type PositionAsset,
} from "@/lib/defiPositions";

type ChainId = (typeof SUPPORTED_CHAINS)[number]["id"];
const MAINNET = 1 as const;

/**
 * Positions the user holds in protocols (vault shares, EigenLayer, Lido
 * withdrawals, MetaMorpho vaults), valued in USD. Reads in two rounds: shares
 * and request ids first, then the underlying value of what is held.
 */
export function useDefiPositions(
  address: Address | undefined,
  enabled: boolean,
  priceOf: (symbol: string) => number,
  morphoVaults: MorphoVaultLike[],
): { positions: PositionAsset[]; isLoading: boolean; refetch: () => Promise<unknown> } {
  const on = enabled && !!address;

  // Round 1: vault shares, EigenLayer deposit shares, Lido request ids.
  const first = useReadContracts({
    contracts: [
      ...READ_VAULTS.map((v) => ({ address: v.vault, abi: ERC4626_READ_ABI, functionName: "balanceOf" as const, args: address ? ([address] as const) : undefined, chainId: v.chainId as ChainId })),
      {
        address: EIGENLAYER_STRATEGY_MANAGER,
        abi: EIGENLAYER_STAKER_SHARES_ABI,
        functionName: "stakerDepositShares" as const,
        args: address ? ([address, EIGENLAYER_STETH_STRATEGY] as const) : undefined,
        chainId: MAINNET,
      },
      { address: LIDO_WITHDRAWAL_QUEUE_ADDRESS as Address, abi: LIDO_GET_WITHDRAWAL_REQUESTS_ABI, functionName: "getWithdrawalRequests" as const, args: address ? ([address] as const) : undefined, chainId: MAINNET },
    ],
    query: { enabled: on },
  });
  const r1 = first.data ?? [];
  const shares = READ_VAULTS.map((_, i) => (r1[i]?.status === "success" ? (r1[i].result as bigint) : 0n));
  const eigenShares = r1[READ_VAULTS.length]?.status === "success" ? (r1[READ_VAULTS.length].result as bigint) : 0n;
  const lidoIds = r1[READ_VAULTS.length + 1]?.status === "success" ? (r1[READ_VAULTS.length + 1].result as readonly bigint[]) : [];

  // Round 2: what the held shares are worth, and the status of each Lido request.
  const held = READ_VAULTS.map((v, i) => ({ v, i })).filter(({ i }) => shares[i] > 0n);
  const vaultValue = useReadContracts({
    contracts: held.map(({ v, i }) => ({ address: v.vault, abi: ERC4626_READ_ABI, functionName: "convertToAssets" as const, args: [shares[i]] as const, chainId: v.chainId as ChainId })),
    query: { enabled: on && held.length > 0 },
  });
  const eigenValue = useReadContract({
    address: EIGENLAYER_STETH_STRATEGY,
    abi: EIGENLAYER_SHARES_TO_UNDERLYING_ABI,
    functionName: "sharesToUnderlyingView",
    args: [eigenShares],
    chainId: MAINNET,
    query: { enabled: on && eigenShares > 0n },
  });
  const lidoStatus = useReadContract({
    address: LIDO_WITHDRAWAL_QUEUE_ADDRESS as Address,
    abi: LIDO_GET_WITHDRAWAL_STATUS_ABI,
    functionName: "getWithdrawalStatus",
    args: [lidoIds],
    chainId: MAINNET,
    query: { enabled: on && lidoIds.length > 0 },
  });

  const assets: (bigint | undefined)[] = READ_VAULTS.map(() => undefined);
  held.forEach(({ i }, k) => {
    const r = vaultValue.data?.[k];
    if (r?.status === "success") assets[i] = r.result as bigint;
  });
  const eigenUnderlying = eigenShares > 0n ? (eigenValue.data as bigint | undefined) : undefined;
  const statuses = lidoIds.length > 0 ? (lidoStatus.data ?? []) : [];

  const positions = on
    ? [
        ...vaultPositions(assets, priceOf),
        ...morphoVaultPositions(morphoVaults, priceOf),
        ...eigenLayerPosition(eigenUnderlying, priceOf),
        ...lidoWithdrawalPositions([...statuses], priceOf),
      ]
    : [];

  const { refetch: r1f } = first;
  const { refetch: r2f } = vaultValue;
  const { refetch: r3f } = eigenValue;
  const { refetch: r4f } = lidoStatus;
  const refetch = useCallback(() => Promise.all([r1f(), r2f(), r3f(), r4f()]), [r1f, r2f, r3f, r4f]);
  return { positions, isLoading: first.isLoading || vaultValue.isLoading, refetch };
}
