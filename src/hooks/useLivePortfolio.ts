import { formatUnits } from "viem";
import { useEffect, useSyncExternalStore } from "react";
import { useAccount, useBalance, useReadContracts } from "wagmi";
import {
  arbitrum,
  avalanche,
  base,
  bsc,
  celo,
  fantom,
  gnosis,
  linea,
  mainnet,
  mantle,
  metis,
  optimism,
  polygon,
  scroll,
  sonic,
  zkSync,
} from "wagmi/chains";
import {
  AAVE_NO_DEBT_HEALTH_FACTOR,
  AAVE_POOL_ABI,
  CHAIN_LABEL,
  COMET_ABI,
  COMET_MARKETS,
  ERC20_ABI,
  LENDING_POOLS_BY_CHAIN,
  SUPPORTED_CHAINS,
  TRACKED_TOKENS_BY_CHAIN,
  perpCoinIsEth,
} from "@/lib/onchain";
import { fetchClearinghouseState, hyperliquidEnv, type HlAccount } from "@/lib/integrations/hyperliquid-live";
import { ethPriceFromAssets, netEthDelta, stakingConcentration } from "@/lib/riskModel";
import { useLivePrices } from "./useLivePrices";
import { useIndexedPositions } from "./useIndexedPositions";

export interface LiveAsset {
  symbol: string;
  venue: string;
  chain: string;
  balance: number;
  usd: number;
}

export interface LiveAavePosition {
  chain: string;
  /** Lending protocol (e.g. "Aave v3", "SparkLend"). */
  protocol: string;
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
  const { morpho: indexedMorpho } = useIndexedPositions(address, isConnected);

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
  const bscBalance = useBalance({ address, chainId: bsc.id, query: { enabled: isConnected } });
  const gnosisBalance = useBalance({ address, chainId: gnosis.id, query: { enabled: isConnected } });
  const scrollBalance = useBalance({ address, chainId: scroll.id, query: { enabled: isConnected } });
  const zkSyncBalance = useBalance({ address, chainId: zkSync.id, query: { enabled: isConnected } });
  const lineaBalance = useBalance({ address, chainId: linea.id, query: { enabled: isConnected } });
  const mantleBalance = useBalance({ address, chainId: mantle.id, query: { enabled: isConnected } });
  const metisBalance = useBalance({ address, chainId: metis.id, query: { enabled: isConnected } });
  const fantomBalance = useBalance({ address, chainId: fantom.id, query: { enabled: isConnected } });
  const sonicBalance = useBalance({ address, chainId: sonic.id, query: { enabled: isConnected } });
  const celoBalance = useBalance({ address, chainId: celo.id, query: { enabled: isConnected } });
  const nativeBalanceByChainId: Record<number, typeof mainnetBalance> = {
    [mainnet.id]: mainnetBalance,
    [base.id]: baseBalance,
    [arbitrum.id]: arbitrumBalance,
    [optimism.id]: optimismBalance,
    [polygon.id]: polygonBalance,
    [avalanche.id]: avalancheBalance,
    [bsc.id]: bscBalance,
    [gnosis.id]: gnosisBalance,
    [scroll.id]: scrollBalance,
    [zkSync.id]: zkSyncBalance,
    [linea.id]: lineaBalance,
    [mantle.id]: mantleBalance,
    [metis.id]: metisBalance,
    [fantom.id]: fantomBalance,
    [sonic.id]: sonicBalance,
    [celo.id]: celoBalance,
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

  // Lending pools (Aave v3 + SparkLend) — getUserAccountData per pool, batched into one hook.
  // Each contract keeps a parallel { chainId, protocol } descriptor so results map back.
  const lendingPoolList = SUPPORTED_CHAINS.flatMap((chain) =>
    (LENDING_POOLS_BY_CHAIN[chain.id] ?? []).map((lp) => ({ chain, protocol: lp.protocol, pool: lp.pool })),
  );
  const lendingContracts = lendingPoolList.map((lp) => ({
    address: lp.pool,
    abi: AAVE_POOL_ABI,
    functionName: "getUserAccountData" as const,
    args: address ? ([address] as const) : undefined,
    chainId: lp.chain.id,
  }));
  const lendingQuery = useReadContracts({
    contracts: lendingContracts,
    query: { enabled: isConnected && !!address },
  });

  // Compound V3 (Comet) — getSupplyBalance/getBorrowBalance per market (base asset).
  const cometContracts = COMET_MARKETS.flatMap((m) => [
    {
      address: m.market,
      abi: COMET_ABI,
      functionName: "getSupplyBalance" as const,
      args: address ? ([m.baseToken, address] as const) : undefined,
      chainId: mainnet.id,
    },
    {
      address: m.market,
      abi: COMET_ABI,
      functionName: "getBorrowBalance" as const,
      args: address ? ([m.baseToken, address] as const) : undefined,
      chainId: mainnet.id,
    },
  ]);
  const cometQuery = useReadContracts({
    contracts: cometContracts,
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

  const aavePositions: LiveAavePosition[] = lendingPoolList
    .map((lp, i) => {
      const entry = lendingQuery.data?.[i];
      if (!entry || entry.status !== "success") return null;
      const [totalCollateralBase, totalDebtBase, availableBorrowsBase, , ltv, rawHealthFactor] = entry.result;
      const collateralUsd = Number(formatUnits(totalCollateralBase, 8));
      const debtUsd = Number(formatUnits(totalDebtBase, 8));
      if (collateralUsd <= 0 && debtUsd <= 0) return null;
      const healthFactor = rawHealthFactor >= AAVE_NO_DEBT_HEALTH_FACTOR ? null : Number(formatUnits(rawHealthFactor, 18));
      return {
        chain: CHAIN_LABEL[lp.chain.id],
        protocol: lp.protocol,
        collateralUsd,
        debtUsd,
        availableToBorrowUsd: Number(formatUnits(availableBorrowsBase, 8)),
        ltvPct: Number(ltv) / 100,
        healthFactor,
      };
    })
    .filter((v): v is LiveAavePosition => v !== null);

  // Compound V3 (Comet) positions — base-token amounts (baseDecimals) valued by the base symbol.
  COMET_MARKETS.forEach((m, mi) => {
    const supply = cometQuery.data?.[mi * 2];
    const borrow = cometQuery.data?.[mi * 2 + 1];
    const supplyUsd = supply?.status === "success" ? Number(formatUnits(supply.result, m.baseDecimals)) : 0;
    const borrowUsd = borrow?.status === "success" ? Number(formatUnits(borrow.result, m.baseDecimals)) : 0;
    if (supplyUsd <= 0 && borrowUsd <= 0) return;
    // Prix du base token via le prix marché du symbole (fallback simple : supposé 1:1 si stable).
    const basePrice = priceOf(m.baseSymbol) || 1;
    aavePositions.push({
      chain: CHAIN_LABEL[mainnet.id],
      protocol: m.protocol,
      collateralUsd: supplyUsd * basePrice,
      debtUsd: borrowUsd * basePrice,
      availableToBorrowUsd: 0,
      ltvPct: 0,
      healthFactor: null,
    });
  });

  // Morpho Blue positions from the official indexer (per-market positions, already in USD).
  indexedMorpho.forEach((m) => {
    const collUsd = m.collateralUsd || 0;
    const debtUsd = m.borrowUsd || 0;
    if (collUsd <= 0 && debtUsd <= 0) return;
    aavePositions.push({
      chain: CHAIN_LABEL[mainnet.id],
      protocol: m.protocol,
      collateralUsd: collUsd + (m.supplyUsd || 0),
      debtUsd,
      availableToBorrowUsd: 0,
      ltvPct: 0,
      healthFactor: null,
    });
  });

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
      Object.values(nativeBalanceByChainId).some((q) => q.isLoading) || tokenBalancesQuery.isLoading || lendingQuery.isLoading || cometQuery.isLoading,
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
