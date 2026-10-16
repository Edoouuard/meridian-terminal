/**
 * strategyIntegrity.ts — post-LLM structural checks on a planned strategy.
 *
 * The planner sometimes labels a strategy "neutral" or "hedged" without the
 * legs that make it so. This fixes what can be fixed (adds the missing spot
 * long, matches perp sizes, strips leverage from spot legs) and relabels what
 * can't. A short side is a short perp or a borrow of the volatile asset — the
 * spot-only hedge Meridian can execute while perps are paused.
 */

import { chainIdFromName } from "@/lib/chains";
import { findToken } from "@/lib/assetMap";
import { deployableUsd, fitLegsToBudget, freshCapitalUsd, hyperliquidMarginOnlyUsd, isHlSpotBuyLeg } from "@/lib/budgetFit";
import { HL_MIN_ORDER_USD } from "@/lib/integrations/hyperliquidTrade";
import { HL_WITHDRAW_FEE_USD } from "@/lib/integrations/hyperliquidExchange";
import { UNISWAP_SWAP_ROUTER02_BY_CHAIN } from "@/lib/integrations/uniswap";

export interface LLMLeg {
  side: string;
  asset: string;
  protocol: string;
  sizeUsd?: number;
  leverage?: number;
  note?: string;
  chain?: string;
  toChain?: string;
  fromAsset?: string;
  /** Perp legs: stop-loss / take-profit in % of price from the entry. */
  stopLossPct?: number;
  takeProfitPct?: number;
}

export interface LLMStrategy {
  name: string;
  risk: string;
  variantNote: string;
  summary: string;
  legs: LLMLeg[];
  /** What the validator changed to fit the wallet, shown with the plan. */
  fundingNotes?: string[];
  apy?: number;
  exit?: string;
  fit?: string;
  risks?: string[];
}

const NEUTRAL_KEYWORDS = /neutral|hedge|basis|cash\.and\.carry|funding.*harvest|no directional|market\.neutral/i;
const SHORT_SIDES = new Set(["short"]);
const LONG_SIDES = new Set(["long", "buy", "supply", "stake", "swap"]);
const SPOT_SIDES = new Set(["supply", "stake", "swap", "buy", "bridge", "transfer", "borrow", "repay", "withdraw", "restake"]);
/** Stablecoins — supplying/swapping these does NOT give long exposure on a volatile asset. */
const STABLECOINS = new Set(["usdc", "usdt", "dai", "frax", "lusd", "gusd", "tusd", "susd", "pyusd", "eusd", "usdp", "busd"]);

/** Extract the bare underlying asset from a leg (strip PERP suffix, take swap destination). */
function legUnderlying(leg: LLMLeg): string {
  const raw = (leg.asset ?? "").trim();
  // Swap format: "USDC → ETH" → "ETH"
  const arrowMatch = raw.match(/→\s*(.+)$/);
  if (arrowMatch) return arrowMatch[1].trim().toUpperCase();
  // Perp format: "ETH PERP" → "ETH"
  return raw.replace(/\s*(PERP|perpetual)\s*$/i, "").trim().toUpperCase();
}

/** Wrapped and liquid-staked versions carry the same price exposure as their base asset. */
const ETH_LIKE = /^(ETH|WETH|UETH|STETH|WSTETH|CBETH|RETH|WEETH|EZETH|RSETH|OSETH|METH|SFRXETH)$/;
const BTC_LIKE = /^(BTC|WBTC|UBTC|CBBTC|TBTC|LBTC)$/;

/** The asset a leg's price exposure is on: ETH for wstETH, BTC for WBTC. */
function exposureAsset(underlying: string): string {
  const u = underlying.toUpperCase();
  if (ETH_LIKE.test(u)) return "ETH";
  if (BTC_LIKE.test(u)) return "BTC";
  return u;
}

/**
 * Does this leg short a volatile asset? A short perp does, and so does
 * borrowing one: the debt grows with its price. Borrowing a stablecoin
 * doesn't.
 */
function isShortExposure(leg: LLMLeg): boolean {
  const side = leg.side.toLowerCase();
  if (side === "short") return true;
  return side === "borrow" && !STABLECOINS.has(legUnderlying(leg).toLowerCase());
}

/** Does this leg give actual long exposure on a volatile asset? Stablecoin supply/swap does NOT count. */
function isRealLongExposure(leg: LLMLeg): boolean {
  const side = leg.side.toLowerCase();
  if (!LONG_SIDES.has(side)) return false;
  const underlying = legUnderlying(leg);
  // Supplying/swapping a stablecoin (USDC, DAI, ...) is yield, not directional exposure.
  if (STABLECOINS.has(underlying.toLowerCase())) return false;
  return true;
}

/** Chains with a Uniswap router Meridian signs swaps on. */
const SWAP_CHAIN_IDS = new Set(Object.keys(UNISWAP_SWAP_ROUTER02_BY_CHAIN).map(Number));

/**
 * A Swap on a chain with no DEX Meridian can sign on (HyperEVM) can't run.
 * Selling a token there means taking it off the chain anyway, so it becomes a
 * swapping bridge: the token is sold and delivered as the swap's output on
 * the chain where the strategy uses it next (Arbitrum when nothing says).
 * "Swap UETH → USDC on HyperEVM" + legs on Arbitrum → "Bridge UETH → USDC,
 * HyperEVM → Arbitrum", one route.
 */
export function routeSwapsWithoutDex(legs: LLMLeg[]): LLMLeg[] {
  return legs.map((l, i) => {
    if (l.side.trim().toLowerCase() !== "swap") return l;
    const chainId = chainIdFromName(l.chain);
    if (chainId === undefined || SWAP_CHAIN_IDS.has(chainId)) return l;
    const [from, to] = l.asset.split("→").map((x) => x.trim());
    if (!from || !to) return l;
    const next = legs.slice(i + 1).find((n) => {
      const id = chainIdFromName(n.chain);
      return id !== undefined && id !== chainId;
    });
    // Nothing needs the proceeds on another chain: sell on Hyperliquid's own order book.
    if (!next && chainId === HYPEREVM_CHAIN_ID && HL_SPOT_TOKENS.test(from) && STABLECOINS.has(to.toLowerCase())) {
      return hyperliquidSellLeg(from, l.sizeUsd);
    }
    const toChain = next?.chain ?? "Arbitrum";
    return {
      side: "Bridge",
      fromAsset: from,
      asset: to,
      protocol: "deBridge",
      chain: l.chain,
      toChain,
      sizeUsd: l.sizeUsd,
      note: `No DEX Meridian can sign on ${l.chain}: this sells your ${from} and delivers ${to} on ${toChain} in one route.`,
    };
  });
}

const HYPEREVM_CHAIN_ID = 999;
/** HyperEVM tokens with a USDC spot market on Hyperliquid, reachable through their HyperCore system address. */
export const HL_SPOT_TOKENS = /^(UETH|UBTC)$/i;

/** Sell a HyperEVM token on Hyperliquid spot (components/execute/HyperliquidSpotSellButton). */
export function hyperliquidSellLeg(token: string, sizeUsd?: number): LLMLeg {
  return {
    side: "Sell",
    asset: token.toUpperCase(),
    protocol: "Hyperliquid",
    chain: "HyperEVM",
    sizeUsd,
    note: `Moves your ${token.toUpperCase()} from HyperEVM into your Hyperliquid spot balance and sells it for USDC on Hyperliquid's order book; the USDC stays in your Hyperliquid account.`,
  };
}

/**
 * A Bridge that names only what it delivers (asset "USDC" from HyperEVM) when
 * the source chain doesn't track that token can't run: the route has nothing
 * to spend. The token it really spends is the one the note names, or else the
 * largest one the wallet holds on that chain.
 */
export function inferBridgeSource(legs: LLMLeg[], ctx?: WalletContext): LLMLeg[] {
  return legs.map((l) => {
    if (l.side.trim().toLowerCase() !== "bridge" || l.fromAsset) return l;
    const from = chainIdFromName(l.chain);
    if (from === undefined || findToken(l.asset, from)) return l;
    const named = (l.note ?? "").match(/\b[A-Za-z][A-Za-z0-9]{1,9}\b/g)?.find((w) => w.toUpperCase() !== l.asset.toUpperCase() && findToken(w, from));
    const held = (ctx?.assets ?? [])
      .filter((a) => a.venue === "Wallet" && chainIdFromName(a.chain) === from && a.usd > 1 && findToken(a.symbol, from))
      .sort((a, b) => b.usd - a.usd)[0]?.symbol;
    const source = named ?? held;
    return source ? { ...l, fromAsset: findToken(source, from)!.symbol } : l;
  });
}

/** Tokens the funding planner (lib/fundingPlanner.ts) bridges and converts on its own. */
const FUNDING_TOKENS = new Set(["USDC", "USDT", "DAI", "WETH", "ETH"]);

const isMove = (l: LLMLeg) => /^(bridge|swap|transfer)$/i.test(l.side.trim());

/**
 * Strip the moves the planner adds to get funds into place, which Meridian's
 * funding planner adds back from the real balances (and only when they pay):
 *   - a Bridge of a stablecoin or ETH, in a strategy that does more than move funds;
 *   - a Swap right before a Pendle leg on the same chain into something other
 *     than USDC/WETH: the Pendle order buys the PT with USDC or WETH directly,
 *     so swapping into USDS first would leave it with nothing to spend.
 * A strategy that is only moves ("bridge my USDC to Base") is left alone.
 */
export function dropFundingMoves(legs: LLMLeg[]): LLMLeg[] {
  if (!legs.some((l) => !isMove(l))) return legs;
  return legs.filter((l, i) => {
    const side = l.side.trim().toLowerCase();
    if (side === "bridge") {
      const token = (l.fromAsset ?? l.asset).trim().toUpperCase();
      return !FUNDING_TOKENS.has(token);
    }
    if (side === "swap") {
      const out = l.asset.split("→")[1]?.trim().toUpperCase();
      const next = legs[i + 1];
      const feedsPendle = !!next && /pendle/i.test(next.protocol) && (next.chain ?? "") === (l.chain ?? "");
      return !(feedsPendle && out && out !== "USDC" && out !== "WETH");
    }
    return true;
  });
}

/**
 * Validate a single LLM-produced strategy for structural coherence.
 * Fixes what can be fixed; relabels what can't.
 */
/** What the user already holds, as the planner saw it (lib/useLivePortfolio assets). */
export interface WalletContext {
  assets?: { symbol: string; venue: string; chain: string; usd: number }[];
}

const isHyperliquidAccount = (venue: string) => /^hyperliquid (perps|spot)$/i.test(venue.trim());
const HL_MARGIN_SYMBOLS = /^(USDC|USDT|USDT0|USDH|USDE)$/i;

/** Stablecoins already in the user's Hyperliquid account: margin that needs no deposit. */
export function hyperliquidMarginUsd(ctx?: WalletContext): number {
  return (ctx?.assets ?? []).filter((a) => isHyperliquidAccount(a.venue) && HL_MARGIN_SYMBOLS.test(a.symbol)).reduce((s, a) => s + a.usd, 0);
}

/** USD of price exposure to `asset` (ETH, BTC…) the user already holds outside Hyperliquid's account: UETH, wstETH, WETH… */
function heldExposureUsd(ctx: WalletContext | undefined, asset: string): number {
  return (ctx?.assets ?? []).filter((a) => !isHyperliquidAccount(a.venue) && exposureAsset(a.symbol.toUpperCase()) === asset).reduce((s, a) => s + a.usd, 0);
}

/**
 * Hyperliquid margin the user already has covers the perp legs: no deposit
 * (or only the shortfall, never under the $5 minimum). Margin per perp leg is
 * its notional / leverage.
 */
export function fitHyperliquidDeposits(legs: LLMLeg[], ctx?: WalletContext): LLMLeg[] {
  const have = hyperliquidMarginUsd(ctx);
  if (!(have > 0)) return legs;
  const needed = legs
    .filter((l) => /^(long|short)$/i.test(l.side.trim()) && /hyperliquid/i.test(l.protocol))
    .reduce((s, l) => s + ((l.sizeUsd ?? 0) * 1.03) / Math.max(1, l.leverage ?? 1), 0);
  const isDeposit = (l: LLMLeg) => /^deposit$/i.test(l.side.trim()) && /hyperliquid/i.test(l.protocol);
  if (!legs.some(isDeposit)) return legs;
  const missing = Math.ceil(needed - have);
  if (missing <= 0) return legs.filter((l) => !isDeposit(l));
  return legs.map((l) => (isDeposit(l) ? { ...l, sizeUsd: Math.max(5, missing), note: `Tops up the $${Math.round(have)} already on Hyperliquid to the margin the position needs.` } : l));
}

/**
 * A bridge that would deliver a token the destination chain doesn't track
 * (BNB to Arbitrum) can't be used there: deliver USDC instead, swapped on the
 * way, which is what a margin deposit or a USDC step after it spends.
 */
export function deliverUsableTokens(legs: LLMLeg[]): LLMLeg[] {
  return legs.map((l) => {
    if (l.side.trim().toLowerCase() !== "bridge" || l.fromAsset) return l;
    const to = chainIdFromName(l.toChain);
    if (to === undefined || findToken(l.asset, to)) return l;
    return { ...l, fromAsset: l.asset, asset: "USDC" };
  });
}

export function validateAndFixStrategy(strategy: LLMStrategy, ctx?: WalletContext): LLMStrategy {
  const legs = (Array.isArray(strategy.legs) ? strategy.legs : []).filter((l) => l && typeof l.side === "string" && typeof l.asset === "string").map(cleanNumbers);
  return fitToBudget(withdrawFromHyperliquid(checkStructure({ ...strategy, legs }, ctx), ctx), ctx);
}

const isHlWithdraw = (l: LLMLeg) => /^withdraw$/i.test(l.side.trim()) && /hyperliquid/i.test(l.protocol);

/**
 * Stablecoins in the Hyperliquid account can fund a strategy elsewhere only
 * after a withdrawal to Arbitrum. When a strategy without perps needs more
 * than the wallet holds and that account has the difference, a Withdraw leg
 * comes first (clamped to what the account holds); the funding planner then
 * adds the bridge from Arbitrum, gated on the withdrawal's arrival.
 */
export function withdrawFromHyperliquid(strategy: LLMStrategy, ctx?: WalletContext): LLMStrategy {
  const held = hyperliquidMarginOnlyUsd(ctx?.assets);
  const clamp = (l: LLMLeg): LLMLeg => ({ ...l, asset: "USDC", chain: "Arbitrum", sizeUsd: Math.floor(Math.min(l.sizeUsd ?? held, held) * 100) / 100 });
  if (strategy.legs.some(isHlWithdraw)) return { ...strategy, legs: strategy.legs.map((l) => (isHlWithdraw(l) ? clamp(l) : l)) };
  if (held <= HL_WITHDRAW_FEE_USD + MIN_BUDGET_USD || strategy.legs.some((l) => /^(long|short)$/i.test(l.side.trim()))) return strategy;
  const missing = freshCapitalUsd(strategy.legs) - deployableUsd(ctx?.assets);
  if (!(missing > 1)) return strategy;
  const size = Math.floor(Math.min(held, missing + HL_WITHDRAW_FEE_USD) * 100) / 100;
  const leg: LLMLeg = {
    side: "Withdraw",
    asset: "USDC",
    protocol: "Hyperliquid",
    chain: "Arbitrum",
    sizeUsd: size,
    note: `Takes $${size.toFixed(2)} of USDC out of your Hyperliquid account to your address on Arbitrum (Hyperliquid's $${HL_WITHDRAW_FEE_USD} fee, ~5 min); the next steps wait for it.`,
  };
  return { ...strategy, legs: [leg, ...strategy.legs] };
}

/** The model sometimes returns numbers as strings ("5000", "$5,000"): make them numbers, or drop them. */
function cleanNumbers(l: LLMLeg): LLMLeg {
  const num = (v: unknown) => {
    const n = typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : v;
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const protocol = typeof l.protocol === "string" ? l.protocol : "";
  // Hyperliquid (Bridge2) and Extended (Rhino.fi) deposits only go from Arbitrum, whatever chain the model wrote.
  const chain = /hyperliquid|extended/i.test(protocol) && /^deposit$/i.test(l.side.trim()) ? "Arbitrum" : l.chain;
  return { ...l, protocol, chain, sizeUsd: num(l.sizeUsd), leverage: num(l.leverage), stopLossPct: num(l.stopLossPct), takeProfitPct: num(l.takeProfitPct) };
}

/** Below this, the planner already says the wallet is too thin: nothing to scale to. */
const MIN_BUDGET_USD = 5;

/** Scale the whole strategy down when it needs more fresh capital than the wallet can deploy (lib/budgetFit.ts). */
function fitToBudget(strategy: LLMStrategy, ctx?: WalletContext): LLMStrategy {
  if (!ctx?.assets?.length) return strategy;
  // What a Withdraw leg brings out of the Hyperliquid account counts too (it is fresh capital the strategy then spends).
  const withdrawn = strategy.legs.filter(isHlWithdraw).reduce((s, l) => s + Math.max(0, (l.sizeUsd ?? 0) - HL_WITHDRAW_FEE_USD), 0);
  const budget = deployableUsd(ctx.assets) + withdrawn;
  const hlMargin = hyperliquidMarginOnlyUsd(ctx.assets);
  // An empty wallet leaves nothing to scale to, unless every step runs on the Hyperliquid account's own USDC.
  const hlOnly = strategy.legs.every((l) => /hyperliquid/i.test(l.protocol) && (/^(long|short)$/i.test(l.side.trim()) || isHlSpotBuyLeg(l)));
  if (budget < MIN_BUDGET_USD && !(hlOnly && hlMargin >= MIN_BUDGET_USD)) return strategy;
  const { legs, scaled } = fitLegsToBudget(strategy.legs, hlOnly ? Math.max(0, budget) : budget, hlMargin);
  if (scaled === 1) return strategy;
  const usesHl = strategy.legs.some((l) => /hyperliquid/i.test(l.protocol) && !isHlWithdraw(l));
  const what = usesHl && hlMargin >= 1
    ? `your $${Math.floor(budget).toLocaleString("en-US")} wallet balance plus the $${Math.floor(hlMargin).toLocaleString("en-US")} in your Hyperliquid account`
    : `your $${Math.floor(budget).toLocaleString("en-US")} free balance`;
  const note = `Sized to ${what}: every step is ${Math.round(scaled * 100)}% of what was first planned (staked, HLP and vault funds aren't counted).`;
  return { ...strategy, legs, fundingNotes: [...(strategy.fundingNotes ?? []), note] };
}

function checkStructure(strategy: LLMStrategy, ctx?: WalletContext): LLMStrategy {
  const legs = fitHyperliquidDeposits(deliverUsableTokens(dropFundingMoves(routeSwapsWithoutDex(inferBridgeSource(strategy.legs ?? [], ctx)))), ctx);
  const nameAndSummary = `${strategy.name} ${strategy.summary}`;
  const claimsNeutral = NEUTRAL_KEYWORDS.test(nameAndSummary);

  if (!claimsNeutral) {
    // Not claiming neutrality — just ensure spot legs don't carry leverage.
    return { ...strategy, legs: legs.map(fixSpotLeverage) };
  }

  // Strategy claims to be neutral: check it has both sides ON THE SAME ASSET.
  // "Supply USDC" is NOT long exposure on ETH — only a real long (spot buy,
  // stake, supply of the SAME volatile asset) counts as the offsetting leg.
  // The short side is a short perp, or a borrow of the volatile asset (the
  // spot-only hedge: supply USDC, borrow WETH, hold the WETH as wstETH).
  const shortLegs = legs.filter(isShortExposure);
  const shortAssets = new Set(shortLegs.map((l) => exposureAsset(legUnderlying(l))));
  const realLongs = legs.filter((l) => isRealLongExposure(l) && shortAssets.has(exposureAsset(legUnderlying(l))));

  const hasShort = shortLegs.length > 0;
  const borrowHedged = shortLegs.some((l) => l.side.toLowerCase() === "borrow");
  // What the wallet already holds counts as the long: shorting the ETH value
  // of a UETH or wstETH holding is the hedge itself, nothing to buy.
  const heldCoversShorts =
    hasShort &&
    [...shortAssets].every((asset) => {
      const shortUsd = shortLegs.filter((l) => exposureAsset(legUnderlying(l)) === asset).reduce((s, l) => s + (l.sizeUsd ?? 0), 0);
      return shortUsd > 0 && heldExposureUsd(ctx, asset) >= shortUsd * 0.9;
    });
  if (heldCoversShorts && realLongs.length === 0) return { ...strategy, legs: legs.map(fixSpotLeverage) };
  const hasMatchingLong = realLongs.length > 0;

  if (hasMatchingLong && hasShort) {
    // Both sides present on the same asset. A perp hedge gets matching sizes;
    // a borrow hedge is left as planned: its long side is a chain of legs on
    // the same funds (swap, then supply), which a per-leg rescale would double count.
    const balanced = borrowHedged ? legs : balanceNeutralSizes(legs);
    return { ...strategy, legs: balanced.map(fixSpotLeverage) };
  }

  // Missing the offsetting long — add a spot buy for each unique shorted asset.
  // It's paid for by the strategy's own stablecoin supply when there is one
  // ("supply USDC on Morpho + short ETH" becomes "buy wstETH + short ETH"), so
  // the plan doesn't grow past the budget; it runs on the perp's chain, and an
  // ETH long is held as wstETH so it earns staking yield.
  if (hasShort && !hasMatchingLong && !borrowHedged) {
    const onHl = hyperliquidNeutral(strategy, legs, shortLegs, ctx);
    if (onHl) return onHl;
    let rest = legs.slice();
    const addedLegs: LLMLeg[] = [];
    for (const asset of shortAssets) {
      const matchingShorts = shortLegs.filter((l) => exposureAsset(legUnderlying(l)) === asset);
      const totalShortSize = matchingShorts.reduce((s, l) => s + (l.sizeUsd ?? 10000), 0);
      const chain = matchingShorts[0]?.chain ?? "Arbitrum";
      const token = asset === "ETH" ? "wstETH" : asset;
      let toFund = totalShortSize;
      rest = rest.flatMap((l) => {
        const isStableSupply = l.side.toLowerCase() === "supply" && STABLECOINS.has(legUnderlying(l).toLowerCase());
        if (!isStableSupply || toFund <= 0) return [l];
        const take = Math.min(toFund, l.sizeUsd ?? 0);
        toFund -= take;
        const left = (l.sizeUsd ?? 0) - take;
        return left >= 5 ? [{ ...l, sizeUsd: left }] : [];
      });
      addedLegs.push({
        side: "Swap",
        asset: `USDC → ${token}`,
        protocol: "Uniswap",
        chain,
        sizeUsd: totalShortSize,
        note: `Spot long ${asset} (held as ${token}) to offset the short perp — required for neutrality.`,
      });
    }
    // The spot buy goes right before the first short: after the steps that bring the USDC it spends.
    const at = rest.findIndex(isShortExposure);
    const ordered = at < 0 ? [...addedLegs, ...rest] : [...rest.slice(0, at), ...addedLegs, ...rest.slice(at)];
    const fixedLegs = fitPerpHedgeToBudget(ordered, legs).map(fixSpotLeverage);
    const assetList = [...shortAssets].join(", ");
    return {
      ...strategy,
      legs: fixedLegs,
      summary: `${strategy.summary} Meridian added the spot ${assetList} long the short needs to be neutral, paid from the stablecoin leg.`,
    };
  }

  if (!hasShort) {
    // Only stablecoins: no price exposure to hedge, so "neutral" is true.
    if (!legs.some(isRealLongExposure)) return { ...strategy, legs: legs.map(fixSpotLeverage) };
    // No short legs — relabel as directional.
    return {
      ...strategy,
      name: strategy.name.replace(NEUTRAL_KEYWORDS, "Directional").trim(),
      summary: strategy.summary.replace(NEUTRAL_KEYWORDS, "directional"),
      legs: legs.map(fixSpotLeverage),
    };
  }

  return { ...strategy, legs: legs.map(fixSpotLeverage) };
}

/** Hyperliquid spot token holding the long side of a shorted asset, when there is one. */
const HL_SPOT_FOR: Record<string, string> = { ETH: "UETH", BTC: "UBTC", SOL: "USOL" };

/**
 * A Hyperliquid short whose money is already in the Hyperliquid account: the
 * long side is bought on Hyperliquid spot (UETH for ETH) with that USDC, so
 * nothing leaves the account and no wallet funds are needed. The notional is
 * what the account carries at the short's leverage: N spot + N / L margin
 * (with fees and the IOC slippage reserve) — at most the short planned.
 * Null when the shorts aren't on Hyperliquid, the wallet (or a stablecoin leg)
 * is the planned source of funds, or the asset has no Hyperliquid spot token.
 */
function hyperliquidNeutral(strategy: LLMStrategy, legs: LLMLeg[], shortLegs: LLMLeg[], ctx?: WalletContext): LLMStrategy | null {
  if (shortLegs.length !== 1 || shortLegs[0].side.toLowerCase() !== "short" || !/hyperliquid/i.test(shortLegs[0].protocol)) return null;
  const short = shortLegs[0];
  const asset = exposureAsset(legUnderlying(short));
  const token = HL_SPOT_FOR[asset];
  const margin = hyperliquidMarginUsd(ctx);
  const isStableSupply = (l: LLMLeg) => l.side.toLowerCase() === "supply" && STABLECOINS.has(legUnderlying(l).toLowerCase());
  if (!token || margin < 2 * HL_MIN_ORDER_USD || legs.some(isStableSupply) || deployableUsd(ctx?.assets) > margin) return null;
  const lev = Math.max(1, short.leverage ?? 1);
  const deposits = legs.filter((l) => /^deposit$/i.test(l.side.trim()) && /hyperliquid/i.test(l.protocol)).reduce((s, l) => s + (l.sizeUsd ?? 0), 0);
  const capital = margin + deposits;
  const fit = Math.floor((capital / (1 + 1.03 / lev)) * 0.98);
  const notional = Math.min(short.sizeUsd ?? fit, fit);
  const buy: LLMLeg = {
    side: "Buy",
    asset: token,
    protocol: "Hyperliquid",
    chain: "Arbitrum",
    sizeUsd: notional,
    note: `Spot long ${asset} bought on Hyperliquid (${token}) with the USDC already in your Hyperliquid account; it offsets the short.`,
  };
  const out: LLMLeg[] = [];
  for (const l of legs) {
    if (l === short) out.push(buy, { ...l, sizeUsd: notional });
    else out.push(l);
  }
  return {
    ...strategy,
    legs: out.map(fixSpotLeverage),
    summary: `${strategy.summary} Meridian added the spot ${asset} long on Hyperliquid (${token}), paid from the USDC already in your Hyperliquid account.`,
  };
}

/**
 * After a spot long was added for a perp short: when the long + margin now
 * cost more than the strategy put in (the stablecoin supply it replaced plus
 * the perp margin deposit), resize to the recipe — notional N = budget × L /
 * (L + 1) for the spot long and the short, the rest as margin.
 */
function fitPerpHedgeToBudget(fixed: LLMLeg[], original: LLMLeg[]): LLMLeg[] {
  const spend = (ls: LLMLeg[]) =>
    ls.filter((l) => /^(supply|deposit|swap|stake|buy)$/i.test(l.side.trim())).reduce((s, l) => s + (l.sizeUsd ?? 0), 0);
  const budget = spend(original);
  const shorts = fixed.filter((l) => l.side.toLowerCase() === "short");
  const deposit = fixed.find((l) => l.side.toLowerCase() === "deposit" && /hyperliquid/i.test(l.protocol));
  if (!deposit || shorts.length !== 1 || !(budget > 0) || spend(fixed) <= budget * 1.01) return fixed;
  const lev = Math.max(1, shorts[0].leverage ?? 1);
  const others = spend(fixed.filter((l) => l !== deposit && !(l.side.toLowerCase() === "swap" && l.note?.startsWith("Spot long"))));
  const usable = budget - others;
  if (!(usable > 0)) return fixed;
  const notional = Math.floor((usable * lev) / (lev + 1));
  return fixed.map((l) => {
    if (l === deposit) return { ...l, sizeUsd: Math.floor(usable - notional) };
    if (l === shorts[0] || (l.side.toLowerCase() === "swap" && l.note?.startsWith("Spot long"))) return { ...l, sizeUsd: notional };
    return l;
  });
}

/** Spot/lending sides never carry leverage. */
function fixSpotLeverage(leg: LLMLeg): LLMLeg {
  if (SPOT_SIDES.has(leg.side.toLowerCase()) && leg.leverage !== undefined) {
    const { leverage: _, ...rest } = leg;
    return rest;
  }
  return leg;
}

/** Ensure offsetting long/short legs in a neutral strategy have matching total notional per asset. */
function balanceNeutralSizes(legs: LLMLeg[]): LLMLeg[] {
  const shorts = legs.filter((l) => SHORT_SIDES.has(l.side.toLowerCase()));
  if (shorts.length === 0) return legs;

  // Group by exposure (wstETH and UETH are ETH) and balance each pair independently.
  const exposure = (l: LLMLeg) => exposureAsset(legUnderlying(l));
  const shortAssets = new Set(shorts.map(exposure));

  return legs.map((l) => {
    const side = l.side.toLowerCase();
    const asset = exposure(l);
    if (!shortAssets.has(asset)) return l;

    const assetShorts = shorts.filter((s) => exposure(s) === asset);
    const assetLongs = legs.filter((ll) => isRealLongExposure(ll) && exposure(ll) === asset);
    if (assetShorts.length === 0 || assetLongs.length === 0) return l;

    const totalShort = assetShorts.reduce((s, ll) => s + (ll.sizeUsd ?? 10000), 0);
    const totalLong = assetLongs.reduce((s, ll) => s + (ll.sizeUsd ?? 10000), 0);
    const target = Math.max(totalLong, totalShort);

    if (SHORT_SIDES.has(side)) {
      const scale = totalShort > 0 ? target / totalShort : 1;
      return scale !== 1 ? { ...l, sizeUsd: Math.round((l.sizeUsd ?? 10000) * scale) } : l;
    }
    if (isRealLongExposure(l)) {
      const scale = totalLong > 0 ? target / totalLong : 1;
      return scale !== 1 ? { ...l, sizeUsd: Math.round((l.sizeUsd ?? 10000) * scale) } : l;
    }
    return l;
  });
}

/** Why a strategy can't run at its size, or null when every step clears its venue's minimum. */
export function belowMinimum(strategy: LLMStrategy): string | null {
  for (const l of strategy.legs) {
    const size = l.sizeUsd ?? 0;
    if (!(size > 0)) continue;
    const hlOrder = /hyperliquid/i.test(l.protocol) && (/^(long|short)$/i.test(l.side.trim()) || isHlSpotBuyLeg(l));
    if (hlOrder && size < HL_MIN_ORDER_USD) return `${l.side} ${l.asset} is $${size.toFixed(2)}; Hyperliquid's minimum order is $${HL_MIN_ORDER_USD}.`;
    if (size < MIN_BUDGET_USD) return `${l.side} ${l.asset} is $${size.toFixed(2)}, under the $${MIN_BUDGET_USD} worth a transaction.`;
  }
  return null;
}

/**
 * Drop strategies a step of which is under its minimum (Hyperliquid's $10
 * order, $5 elsewhere): they can't be executed as shown. An explicit order
 * (`keepFirst`) and, when none is left, every strategy stays, saying what is
 * too small, rather than vanishing.
 */
export function dropBelowMinimum(strategies: LLMStrategy[], keepFirst = false): LLMStrategy[] {
  const note = (s: LLMStrategy): LLMStrategy => {
    const why = belowMinimum(s);
    return why ? { ...s, fundingNotes: [...(s.fundingNotes ?? []), `Too small to execute: ${why}`] } : s;
  };
  const ok = strategies.filter((s, i) => (keepFirst && i === 0) || belowMinimum(s) === null);
  if (ok.length === 0) return strategies.map(note);
  return ok.map(note);
}
