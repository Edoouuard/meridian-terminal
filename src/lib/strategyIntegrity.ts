/**
 * strategyIntegrity.ts — post-LLM structural checks on a planned strategy.
 *
 * The planner sometimes labels a strategy "neutral" or "hedged" without the
 * legs that make it so. This fixes what can be fixed (adds the missing spot
 * long, matches perp sizes, strips leverage from spot legs) and relabels what
 * can't. A short side is a short perp or a borrow of the volatile asset — the
 * spot-only hedge Meridian can execute while perps are paused.
 */

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
}

export interface LLMStrategy {
  name: string;
  risk: string;
  variantNote: string;
  summary: string;
  legs: LLMLeg[];
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
const ETH_LIKE = /^(ETH|WETH|STETH|WSTETH|CBETH|RETH|WEETH|EZETH|RSETH|OSETH|METH|SFRXETH)$/;
const BTC_LIKE = /^(BTC|WBTC|CBBTC|TBTC|LBTC)$/;

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
export function validateAndFixStrategy(strategy: LLMStrategy): LLMStrategy {
  const legs = dropFundingMoves(strategy.legs ?? []);
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

  const hasMatchingLong = realLongs.length > 0;
  const hasShort = shortLegs.length > 0;
  const borrowHedged = shortLegs.some((l) => l.side.toLowerCase() === "borrow");

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
    const fixedLegs = fitPerpHedgeToBudget([...addedLegs, ...rest], legs).map(fixSpotLeverage);
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

  // Group by underlying asset and balance each pair independently.
  const shortAssets = new Set(shorts.map(legUnderlying));

  return legs.map((l) => {
    const side = l.side.toLowerCase();
    const underlying = legUnderlying(l);

    // Only balance legs whose underlying matches a shorted asset.
    if (!shortAssets.has(underlying) && !(
      /^(ST|WST|CB|R)ETH$/i.test(underlying) && shortAssets.has("ETH")
    )) return l;

    const effectiveAsset = /^(ST|WST|CB|R)ETH$/i.test(underlying) ? "ETH" : underlying;
    const assetShorts = shorts.filter((s) => legUnderlying(s) === effectiveAsset);
    const assetLongs = legs.filter((ll) => {
      if (!isRealLongExposure(ll)) return false;
      const u = legUnderlying(ll);
      return u === effectiveAsset || (/^(ST|WST|CB|R)ETH$/i.test(u) && effectiveAsset === "ETH");
    });
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
