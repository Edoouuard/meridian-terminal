"use client";

import { useAccount, useBalance, useSimulateContract } from "wagmi";
import { findToken, DEFAULT_CHAIN_ID } from "@/lib/assetMap";
import { CHAIN_LABEL, STETH_ADDRESS, SUPPORTED_CHAINS } from "@/lib/onchain";
import type { Order } from "@/lib/execution";
import type { TradeLeg } from "@/lib/tradePlan";
import { legChainId } from "@/lib/chains";
import { useIndexedPositions } from "@/hooks/useIndexedPositions";
import { useVaultRisk } from "@/hooks/useVaultRisk";
import { MIN_VAULT_TVL_USD } from "@/lib/vaultPolicy";
import { MIN_MORPHO_RISK_SCORE } from "@/lib/integrations/morpho";
import { QUOTER_V2_QUOTE_EXACT_INPUT_SINGLE_ABI, UNISWAP_QUOTER_V2_BY_CHAIN, applySlippage, defaultFeeTier, parseSwapAsset } from "@/lib/integrations/uniswap";
import { formatBaseUnits, resolvePriceFromList, usdToTokenAmount, type PriceEntry } from "@/lib/quote";
import { ValidatedExecuteButton } from "@/components/ValidatedExecuteButton";
import { NotWired, OrderRow, RISK_TIER_COLOR } from "@/components/thread/shared";

/**
 * Live Uniswap v3 swap execution. Unlike Aave/Lido (whose amount is sized
 * purely from a REST price feed), a swap's `amountOutMinimum` can only come
 * from a real on-chain quote (QuoterV2.quoteExactInputSingle) taken right
 * before signing — so this bypasses `resolveOrderForLeg`'s pure/offline
 * result for "swap" legs (mirrors how PerpExecuteButton bypasses it for
 * Hyperliquid's live mid-price). Once the quote lands, execution itself
 * (approve + exactInputSingle) reuses the existing ExecuteButton — same
 * confirm dialog, same idempotency guard, same honest error handling.
 */
export function SwapExecuteButton({ leg, prices }: { leg: TradeLeg; prices?: PriceEntry[] }) {
  const { chain } = useAccount();
  const chainId = legChainId(leg, chain?.id) ?? DEFAULT_CHAIN_ID;

  const parsed = parseSwapAsset(leg.asset);
  const tokenIn = parsed ? findToken(parsed.from, chainId) : undefined;
  const tokenOut = parsed ? findToken(parsed.to, chainId) : undefined;
  const fee = tokenIn && tokenOut ? defaultFeeTier(tokenIn.symbol, tokenOut.symbol) : undefined;

  const price = tokenIn ? resolvePriceFromList(prices, tokenIn.symbol) : null;
  const inQuote = tokenIn ? usdToTokenAmount(tokenIn.symbol, leg.sizeUsd, price, tokenIn.decimals) : null;

  const quoterAddress = UNISWAP_QUOTER_V2_BY_CHAIN[chainId];
  const quoteEnabled = !!(tokenIn && tokenOut && fee && inQuote && quoterAddress);
  const {
    data: sim,
    isLoading: quoting,
    error: quoteError,
  } = useSimulateContract({
    address: quoterAddress,
    abi: QUOTER_V2_QUOTE_EXACT_INPUT_SINGLE_ABI,
    functionName: "quoteExactInputSingle",
    args:
      tokenIn && tokenOut && fee !== undefined && inQuote
        ? [{ tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn: inQuote.amountBase, fee, sqrtPriceLimitX96: BigInt(0) }]
        : undefined,
    chainId: chainId as (typeof SUPPORTED_CHAINS)[number]["id"],
    query: { enabled: quoteEnabled },
  });

  if (!parsed) {
    return <NotWired venue="Uniswap" reason={`Could not parse a swap pair from "${leg.asset}".`} />;
  }
  if (!tokenIn || !tokenOut) {
    const missing = !tokenIn ? parsed.from : parsed.to;
    return (
      <NotWired
        venue="Uniswap"
        reason={`"${missing}" has no tracked address on ${CHAIN_LABEL[chainId] ?? `chain ${chainId}`}.`}
      />
    );
  }
  if (!quoterAddress) {
    return <NotWired venue="Uniswap" reason={`Uniswap v3 is not supported on ${CHAIN_LABEL[chainId] ?? `chain ${chainId}`}.`} />;
  }
  if (!inQuote) {
    return <NotWired venue="Uniswap" reason={`No live price for ${tokenIn.symbol} — cannot size this order safely.`} />;
  }
  if (quoteError) {
    return <NotWired venue="Uniswap" reason="Could not fetch a live quote from Uniswap right now." />;
  }
  if (quoting || !sim) {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)" }}>Fetching live Uniswap quote…</p>
    );
  }

  const amountOut = sim.result[0];
  const amountOutMinimum = applySlippage(amountOut);

  const order: Order = {
    type: "swap",
    protocol: "uniswap",
    token: tokenIn.address,
    tokenOut: tokenOut.address,
    fee,
    amount: inQuote.amountBase,
    amountOutMinimum,
    chainId,
    decimals: tokenIn.decimals,
    symbol: tokenIn.symbol,
  };

  return (
    <>
      <OrderRow
        label="Min received"
        value={`${formatBaseUnits(amountOutMinimum, tokenOut.decimals)} ${tokenOut.symbol}`}
        valueColor="var(--color-accent-700)"
      />
      <ValidatedExecuteButton order={order} label="Swap on Uniswap →" />
    </>
  );
}

/**
 * Live Morpho vault deposit. Morpho Blue has no single canonical pool like
 * Aave — deposits go into one of hundreds of MetaMorpho vaults, each its own
 * ERC-4626 contract. Rather than hardcode a curated vault list, this resolves
 * the vault to deposit into at execute-time from Philidor's live risk data
 * (same source as the Vault Risk panel / LegRiskBadge), scoped to the
 * connected wallet's chain so no network-switch flow is needed, and gated to
 * MIN_MORPHO_RISK_SCORE so a low-scoring (Edge-tier) vault is never silently
 * picked for a one-click deposit. Once resolved, execution (approve +
 * deposit) reuses the existing ExecuteButton, same as SwapExecuteButton does.
 */
export function MorphoExecuteButton({ leg, prices }: { leg: TradeLeg; prices?: PriceEntry[] }) {
  const { chain } = useAccount();
  const chainId = legChainId(leg, chain?.id) ?? DEFAULT_CHAIN_ID;
  const chainName = CHAIN_LABEL[chainId];
  const symbol = (leg.asset || "").trim();

  const { data: vaults, isLoading } = useVaultRisk({
    protocol: "Morpho",
    asset: symbol || undefined,
    chain: chainName,
    limit: 25,
    enabled: !!symbol && !!chainName,
  });
  // Best-rated vault that also clears the TVL floor (the risk sort alone can
  // surface a sub-$1M vault with no yield).
  const vault = vaults?.find((v) => v.tvlUsd >= MIN_VAULT_TVL_USD);

  const token = findToken(symbol, chainId);
  const price = token ? resolvePriceFromList(prices, token.symbol) : null;
  const quote = token ? usdToTokenAmount(token.symbol, leg.sizeUsd, price, token.decimals) : null;

  if (!chainName) {
    return <NotWired venue="Morpho" reason={`Chain ${chainId} is not supported for Morpho vault deposits.`} />;
  }
  if (isLoading) {
    return <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)" }}>Finding the best-rated Morpho {symbol} vault…</p>;
  }
  if (!vault) {
    return (
      <NotWired
        venue="Morpho"
        reason={`No live Morpho ${symbol} vault with at least $${MIN_VAULT_TVL_USD / 1_000_000}M TVL found on ${chainName} — try another asset or chain.`}
      />
    );
  }
  if (vault.riskScore < MIN_MORPHO_RISK_SCORE) {
    return (
      <NotWired
        venue="Morpho"
        reason={`The best available Morpho ${symbol} vault on ${chainName} scores ${vault.riskScore.toFixed(1)}/10 (${vault.riskTier}) — below Meridian's ${MIN_MORPHO_RISK_SCORE}/10 floor for one-click deposits.`}
      />
    );
  }
  if (!vault.address || !vault.assetAddress) {
    return <NotWired venue="Morpho" reason="Live vault data is missing an on-chain address — cannot build a safe order." />;
  }
  if (!token) {
    return <NotWired venue="Morpho" reason={`"${symbol}" has no tracked address on ${chainName}.`} />;
  }
  if (!quote) {
    return <NotWired venue="Morpho" reason={`No live price for ${symbol} — cannot size this order safely.`} />;
  }

  const order: Order = {
    type: "supply",
    protocol: "morpho",
    token: token.address,
    vaultAddress: vault.address as `0x${string}`,
    amount: quote.amountBase,
    chainId,
    decimals: token.decimals,
    symbol: token.symbol,
  };

  return (
    <>
      <OrderRow label="Vault" value={vault.name} />
      <OrderRow label="Risk" value={`${vault.riskTier} · ${vault.riskScore.toFixed(1)}/10 (Philidor)`} valueColor={RISK_TIER_COLOR[vault.riskTier]} />
      <ValidatedExecuteButton order={order} label="Deposit on Morpho →" />
    </>
  );
}

/**
 * Live Morpho vault withdrawal. Unlike supply (which picks a NEW vault via
 * live Philidor risk data), withdraw needs to find the vault the user is
 * ALREADY in — read from the official Morpho indexer (same one
 * useLivePortfolio uses for read-only display, see useIndexedPositions). An
 * unspecified amount withdraws the full position; a requested amount is
 * capped to it — never over-withdraws, since capping down is always safe
 * but guessing up could try to pull more than the vault holds. No approval
 * step: ERC-4626 withdraw needs no allowance when receiver/owner are both
 * the caller, which is the only shape Meridian ever builds.
 */
export function MorphoWithdrawButton({ leg, prices }: { leg: TradeLeg; prices?: PriceEntry[] }) {
  const { chain, address } = useAccount();
  const chainId = legChainId(leg, chain?.id) ?? DEFAULT_CHAIN_ID;
  const symbol = (leg.asset || "").trim();

  const { vaults, loading } = useIndexedPositions(address, !!address);

  if (!address) {
    return <NotWired venue="Morpho" reason="Connect a wallet to withdraw." />;
  }
  if (loading) {
    return <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)" }}>Finding your Morpho position…</p>;
  }

  const candidates = vaults.filter((v) => v.assetSymbol.toUpperCase() === symbol.toUpperCase() && v.chainId === chainId);
  const position = candidates.sort((a, b) => b.assetsUsd - a.assetsUsd)[0];
  if (!position) {
    return (
      <NotWired
        venue="Morpho"
        reason={`No Morpho ${symbol} position found on ${CHAIN_LABEL[chainId] ?? `chain ${chainId}`} to withdraw from.`}
      />
    );
  }

  const positionAssets = BigInt(position.assets);
  const price = resolvePriceFromList(prices, symbol);
  const requestedQuote = leg.sizeUsd && price ? usdToTokenAmount(symbol, leg.sizeUsd, price, position.assetDecimals) : null;
  // Cap to the real position — never withdraw more than it holds. No
  // explicit amount (or no live price to size one) means "withdraw everything".
  const amountBase = requestedQuote && requestedQuote.amountBase < positionAssets ? requestedQuote.amountBase : positionAssets;

  if (amountBase <= BigInt(0)) {
    return <NotWired venue="Morpho" reason="Nothing to withdraw from this position." />;
  }

  const order: Order = {
    type: "withdraw",
    protocol: "morpho",
    token: position.assetAddress as `0x${string}`,
    vaultAddress: position.vaultAddress as `0x${string}`,
    amount: amountBase,
    chainId,
    decimals: position.assetDecimals,
    symbol,
  };

  return (
    <>
      <OrderRow label="Vault" value={position.vaultName} />
      <OrderRow
        label="Withdrawing"
        value={`${formatBaseUnits(amountBase, position.assetDecimals)} of ${formatBaseUnits(positionAssets, position.assetDecimals)} ${symbol}`}
      />
      <ValidatedExecuteButton order={order} label="Withdraw from Morpho →" />
    </>
  );
}

/**
 * Live Lido unstake — the REQUEST half only. Locks stETH into Lido's
 * withdrawal queue (see lib/integrations/lido.ts); the queue is not instant
 * (Lido's oracle finalizes requests over time), so this alone doesn't
 * return ETH — see LidoWithdrawalsPanel for viewing status and claiming
 * once finalized. Sized off the connected wallet's real stETH balance
 * (read live), capped the same way Morpho withdraw is: an unspecified
 * amount requests the full balance; a requested amount is capped to it.
 */
export function LidoUnstakeButton({ leg, prices }: { leg: TradeLeg; prices?: PriceEntry[] }) {
  const { chain, address } = useAccount();
  const chainId = legChainId(leg, chain?.id) ?? DEFAULT_CHAIN_ID;
  const { data: balance, isLoading } = useBalance({
    address,
    token: STETH_ADDRESS,
    chainId: 1,
    query: { enabled: !!address },
  });

  if (!address) {
    return <NotWired venue="Lido" reason="Connect a wallet to unstake." />;
  }
  if (chainId !== 1) {
    return <NotWired venue="Lido" reason="Lido unstaking is only wired on Ethereum mainnet — switch networks." />;
  }
  if (isLoading) {
    return <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)" }}>Reading your stETH balance…</p>;
  }

  const positionWei = balance?.value ?? BigInt(0);
  if (positionWei <= BigInt(0)) {
    return <NotWired venue="Lido" reason="No stETH balance found to unstake." />;
  }

  // stETH tracks ETH ~1:1 — reuse the live ETH price to size a requested USD amount.
  const price = resolvePriceFromList(prices, "ETH");
  const requestedQuote = leg.sizeUsd && price ? usdToTokenAmount("ETH", leg.sizeUsd, price, 18) : null;
  const amountBase = requestedQuote && requestedQuote.amountBase < positionWei ? requestedQuote.amountBase : positionWei;

  const order: Order = {
    type: "unstake",
    protocol: "lido",
    token: STETH_ADDRESS,
    amount: amountBase,
    chainId: 1,
    decimals: 18,
    symbol: "stETH",
  };

  return (
    <>
      <OrderRow
        label="Requesting"
        value={`${formatBaseUnits(amountBase, 18)} of ${formatBaseUnits(positionWei, 18)} stETH`}
      />
      <ValidatedExecuteButton order={order} label="Request withdrawal on Lido →" />
    </>
  );
}
