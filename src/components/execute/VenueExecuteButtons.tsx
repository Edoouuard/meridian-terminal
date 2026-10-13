"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { zeroAddress } from "viem";
import { useAccount, useBalance, useReadContracts } from "wagmi";
import { findToken, DEFAULT_CHAIN_ID } from "@/lib/assetMap";
import { CHAIN_LABEL, STETH_ADDRESS, SUPPORTED_CHAINS } from "@/lib/onchain";
import type { Order } from "@/lib/execution";
import type { TradeLeg } from "@/lib/tradePlan";
import { legChainId } from "@/lib/chains";
import { useIndexedPositions } from "@/hooks/useIndexedPositions";
import { useVaultRisk } from "@/hooks/useVaultRisk";
import { MIN_VAULT_TVL_USD } from "@/lib/vaultPolicy";
import { MIN_MORPHO_RISK_SCORE } from "@/lib/integrations/morpho";
import { PENDLE_CHAINS, isEthMarket, pickPendleMarket, type PendleBuyQuote, type PendleMarket } from "@/lib/integrations/pendle";
import { QUOTER_V2_QUOTE_READ_ABI, QUOTE_FEE_TIERS, UNISWAP_QUOTER_V2_BY_CHAIN, applySlippage, parseSwapAsset, pickBestFeeQuote } from "@/lib/integrations/uniswap";
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
  const price = tokenIn ? resolvePriceFromList(prices, tokenIn.symbol) : null;
  const inQuote = tokenIn ? usdToTokenAmount(tokenIn.symbol, leg.sizeUsd, price, tokenIn.decimals) : null;

  // Quote every fee tier and keep the best pool: the deepest pool differs by
  // pair and chain (e.g. USDC/WETH only has a 0.05% pool on Avalanche).
  const quoterAddress = UNISWAP_QUOTER_V2_BY_CHAIN[chainId];
  const quoteEnabled = !!(tokenIn && tokenOut && inQuote && quoterAddress);
  const { data: tierQuotes, isLoading: quoting } = useReadContracts({
    contracts: QUOTE_FEE_TIERS.map((fee) => ({
      address: quoterAddress,
      abi: QUOTER_V2_QUOTE_READ_ABI,
      functionName: "quoteExactInputSingle" as const,
      args: [{ tokenIn: tokenIn?.address ?? zeroAddress, tokenOut: tokenOut?.address ?? zeroAddress, amountIn: inQuote?.amountBase ?? BigInt(0), fee, sqrtPriceLimitX96: BigInt(0) }] as const,
      chainId: chainId as (typeof SUPPORTED_CHAINS)[number]["id"],
    })),
    allowFailure: true,
    query: { enabled: quoteEnabled },
  });
  const best = tierQuotes
    ? pickBestFeeQuote(tierQuotes.map((r, i) => ({ fee: QUOTE_FEE_TIERS[i], amountOut: r.status === "success" ? r.result[0] : undefined })))
    : null;

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
  if (quoting || !tierQuotes) {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)" }}>Fetching live Uniswap quote…</p>
    );
  }

  if (!best) {
    return <NotWired venue="Uniswap" reason={`No Uniswap v3 pool quotes ${tokenIn.symbol} → ${tokenOut.symbol} on ${CHAIN_LABEL[chainId] ?? `chain ${chainId}`} right now.`} />;
  }
  const { fee, amountOut } = best;
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

/**
 * Pendle fixed yield: buy the PT of a live market and hold it to maturity.
 * The market is the one the plan names (PT-sUSDe…) or, failing that, the best
 * fixed APY among Pendle's curated ("prime") markets of the leg's kind, with
 * ≥ $1M liquidity and > 14 days left (lib/integrations/pendle.ts). The router
 * call is quoted live by Pendle's API, then signed through the same validated
 * flow as everything else — its target is re-checked against Pendle's router.
 */
export function PendleExecuteButton({ leg, prices }: { leg: TradeLeg; prices?: PriceEntry[] }) {
  const { address, chain } = useAccount();
  const chainId = legChainId(leg, chain?.id) ?? DEFAULT_CHAIN_ID;
  const chainName = CHAIN_LABEL[chainId] ?? `chain ${chainId}`;
  const supported = (PENDLE_CHAINS as readonly number[]).includes(chainId);
  const [quote, setQuote] = useState<{ order: Order; ptOut?: string } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const { data: markets, isLoading } = useQuery<PendleMarket[]>({
    queryKey: ["pendle-markets", chainId],
    queryFn: async () => {
      const res = await fetch(`/api/pendle?chainId=${chainId}`);
      if (!res.ok) throw new Error("pendle markets fetch failed");
      return res.json();
    },
    enabled: supported,
    staleTime: 5 * 60_000,
  });

  if (!supported) {
    return <NotWired venue="Pendle" reason={`Pendle PT is wired on Ethereum, Arbitrum and Base — not ${chainName}.`} />;
  }
  if (isLoading || !markets) {
    return <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)" }}>Loading live Pendle markets on {chainName}…</p>;
  }
  const market = pickPendleMarket(markets, leg.asset);
  if (!market) {
    return <NotWired venue="Pendle" reason={`No Pendle market for "${leg.asset}" on ${chainName} with ≥ $1M liquidity and more than 14 days to expiry.`} />;
  }
  const spend = findToken(isEthMarket(market) ? "WETH" : "USDC", chainId);
  const price = spend ? resolvePriceFromList(prices, spend.symbol) : null;
  const amount = spend ? usdToTokenAmount(spend.symbol, leg.sizeUsd, price, spend.decimals) : null;
  if (!spend || !amount) {
    return <NotWired venue="Pendle" reason="No live price for the input token — cannot size this order safely." />;
  }
  const expiry = new Date(market.expiry).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

  async function fetchQuote() {
    if (!address || !spend || !amount || !market) return;
    setQuoting(true);
    setQuoteError(null);
    try {
      const res = await fetch("/api/pendle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chainId, pt: market.pt, tokenIn: spend.address, amountIn: amount.amountBase.toString(), receiver: address }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Pendle quote failed");
      const q = body as PendleBuyQuote;
      setQuote({
        ptOut: q.ptOut,
        order: {
          type: "swap",
          protocol: "pendle",
          token: spend.address,
          symbol: spend.symbol,
          amount: amount.amountBase,
          chainId,
          decimals: spend.decimals,
          routerTx: { to: q.tx.to, data: q.tx.data, value: q.tx.value ? BigInt(q.tx.value) : undefined },
        },
      });
    } catch (err) {
      setQuoteError(err instanceof Error ? err.message : "Pendle quote failed");
    } finally {
      setQuoting(false);
    }
  }

  return (
    <>
      <OrderRow label="Market" value={`PT-${market.name} · ${chainName}`} />
      <OrderRow label="Fixed APY" value={`${market.impliedApyPct.toFixed(2)}% until ${expiry}`} valueColor="var(--color-accent-700)" />
      <OrderRow label="Liquidity" value={`$${Math.round(market.liquidityUsd).toLocaleString()}${market.isPrime ? " · Pendle prime" : ""}`} />
      {quote ? (
        <ValidatedExecuteButton order={quote.order} label={`Buy PT-${market.name} →`} />
      ) : !address ? (
        <NotWired venue="Pendle" reason="Connect a wallet to get a quote." />
      ) : (
        <button className="btn btn-primary" style={{ fontSize: 13, marginTop: 6, cursor: "pointer" }} disabled={quoting} onClick={fetchQuote}>
          {quoting ? "Quoting on Pendle…" : `Get quote: ${amount.amount} ${spend.symbol} → PT-${market.name}`}
        </button>
      )}
      {quoteError && <p style={{ margin: "4px 0 0", fontSize: 11, color: "var(--risk-bad, #c0392b)" }}>{quoteError}</p>}
    </>
  );
}
