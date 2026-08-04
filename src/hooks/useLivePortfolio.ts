import { formatUnits } from "viem";
import { useEffect, useSyncExternalStore } from "react";
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
  perpCoinIsEth,
} from "@/lib/onchain";
import { fetchClearinghouseState, hyperliquidEnv, type HlAccount } from "@/lib/integrations/hyperliquid-live";
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

/** A live Hyperliquid perp position, distilled for the portfolio / risk views (read-only). */
export interface LivePerp {
  coin: string;
  /** Signed coin quantity; positive = long, negative = short. */
  size: number;
  notional: number;
  unrealizedPnl: number;
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
  /** Net Hyperliquid perp exposure to ETH (ETH/WETH/stETH/wstETH perp sizes, signed), in ETH units. */
  perpNetDeltaEth: number | null;
  /** Net directional exposure to ETH across venues (spot + Hyperliquid perps), in ETH units. */
  netDeltaEthTotal: number | null;
  /** Open Hyperliquid perp positions (read-only; empty when none / HL read fails). */
  perps: LivePerp[];
  /** Sum of absolute perp notional (USD exposure held on Hyperliquid). */
  perpNotionalUsd: number;
  /** Sum of unrealized PnL across open perp positions. */
  perpUnrealizedPnl: number;
  /** Approximate ETH price (derived from tracked holdings) used to size the flatten trade. */
  ethPrice: number | null;
  /** stETH + wstETH as a percent of net portfolio value. */
  stakingConcentrationPct: number | null;
}

// ---------------------------------------------------------------------------
// Shared Hyperliquid account store
// ---------------------------------------------------------------------------
// A tiny module-level store that both useLivePortfolio() and HyperliquidPanel
// read/write so the portfolio and the panel always reflect the same live
// Hyperliquid account. Read-only: nothing here can place an order.
let sharedHlAccount: HlAccount | null = null;
const hlListeners = new Set<() => void>();

export function setSharedHlAccount(acc: HlAccount | null): void {
  sharedHlAccount = acc;
  hlListeners.forEach((l) => l());
}

export function getSharedHlAccount(): HlAccount | null {
  return sharedHlAccount;
}

function subscribeHlAccount(listener: () => void): () => void {
  hlListeners.add(listener);
  return () => {
    hlListeners.delete(listener);
  };
}

/** Subscribe to the shared Hyperliquid account (returns the current value reactively). */
export function useSharedHlAccount(): HlAccount | null {
  return useSyncExternalStore(subscribeHlAccount, getSharedHlAccount, getSharedHlAccount);
}

export function useLivePortfolio(): LivePortfolio {
  const { address, isConnected } = useAccount();
  const hlAccount = useSharedHlAccount();
  const { data: prices } = useLivePrices();

  // Fetch the Hyperliquid clearinghouse state when a wallet connects (read-only,
  // TESTNET default). The result is written to the shared store so the portfolio
  // and the Hyperliquid panel always agree.
  useEffect(() => {
    if (!isConnected || !address) {
      setSharedHlAccount(null);
      return;
    }
    let cancelled = false;
    fetchClearinghouseState(address, hyperliquidEnv(true))
      .then((acc) => {
        if (!cancelled) setSharedHlAccount(acc);
      })
      .catch(() => {
        // Graceful: a chain/network where HL reads fail just yields no perps.
        if (!cancelled) setSharedHlAccount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [address, isConnected]);

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

  // Risk metrics derived from the live tracked holdings. netDeltaEth is the spot
  // book; the Hyperliquid perps are folded in via their own netDelta and a
  // cross-venue total. All of this math lives in the pure riskModel engine so
  // the hook and the Risk panel compute identical numbers.
  const ethPrice = ethPriceFromAssets(assets);
  const spotNetDeltaEth = netEthDelta(assets, ethPrice);

  const perps: LivePerp[] = (hlAccount?.positions ?? []).map((p) => ({
    coin: p.coin,
    size: p.size,
    notional: p.notional,
    unrealizedPnl: p.unrealizedPnl,
  }));
  // Net perp ETH delta = signed perp size of ETH-denominated perps (long +, short -).
  const perpNetDeltaEth = perps
    .filter((p) => perpCoinIsEth(p.coin))
    .reduce((sum, p) => sum + p.size, 0);
  const perpNotionalUsd = perps.reduce((sum, p) => sum + Math.abs(p.notional), 0);
  const perpUnrealizedPnl = perps.reduce((sum, p) => sum + p.unrealizedPnl, 0);

  // Cross-venue net ETH delta: spot plus perp. If spot can't be priced but perps
  // exist, fall back to the perp-only figure; if nothing is priced, null.
  let netDeltaEthTotal: number | null = null;
  if (spotNetDeltaEth !== null) netDeltaEthTotal = spotNetDeltaEth + perpNetDeltaEth;
  else if (perps.length > 0) netDeltaEthTotal = perpNetDeltaEth;

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
    netDeltaEth: spotNetDeltaEth,
    perpNetDeltaEth,
    netDeltaEthTotal,
    perps,
    perpNotionalUsd,
    perpUnrealizedPnl,
    ethPrice,
    stakingConcentrationPct,
  };
}
