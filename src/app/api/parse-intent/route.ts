import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/parse-intent
 *
 * Takes a raw thesis string and returns 3 structured DeFi strategies
 * (conservative / moderate / aggressive) via OpenRouter. This is Meridian's
 * "brain" — the agentic layer that understands free-form intent and maps
 * it to executable, multi-leg strategies across all wired protocols.
 *
 * OpenRouter lets us pick the best model per cost/quality tradeoff:
 *   - Default: google/gemini-2.5-flash (fast, cheap, good at structured JSON)
 *   - Can be overridden via OPENROUTER_MODEL env var
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "google/gemini-2.5-flash";

const SYSTEM_PROMPT = `You are Meridian's DeFi strategy engine. You receive a user's investment thesis and LIVE MARKET DATA, and produce 3 executable strategies.

## CRITICAL: USE LIVE DATA ONLY

The user message contains LIVE YIELD DATA fetched seconds ago from protocol APIs. This includes real-time APYs, funding rates, vault yields, risk scores, and TVL.

You MUST:
- Use ONLY the rates from the live data. Never invent, estimate, or recall rates from memory.
- Quote the exact live APY/APR in every leg note and summary (e.g. "Currently 4.23% APY").
- Compare opportunities from the live data to pick the best ones for each strategy.
- If an asset/protocol the user wants isn't in the live data, say so honestly in the note.

You MUST NOT:
- Use approximate rates like "~5%" or "~3-4%". Use the exact number from the live data.
- Assume any rate is stable. Mention in variantNote that rates are variable and current as of now.

## Your Process (MANDATORY)

Before generating strategies, analyze:
1. WHAT does the user want? (yield, exposure, hedge, points, income, protection?)
2. WHAT asset(s) and chain(s)?
3. WHAT is their risk appetite from their language?
4. WHAT time horizon?
5. ANALYZE THE USER'S PORTFOLIO: What do they already hold? What positions are open? What is their current exposure? Use this to SIZE strategies appropriately and AVOID redundant actions.
6. SCAN the live data: which protocols currently offer the best rates for this goal?
7. COMPARE: for yield, rank all available options from the live data. For exposure, check funding rates. For staking, compare all staking providers.
8. COMPOSE 3 genuinely different approaches using the best live opportunities.

## Portfolio-Aware Strategy Design (CRITICAL)

When the user's portfolio is provided:
- **SIZE FROM FREE BALANCE**: The portfolio includes a "FREE BALANCE" — this is the idle capital available to deploy. ALWAYS size strategy legs to fit within this free balance. NEVER suggest deploying more than the user has available. Conservative should use 30-50%, moderate 50-70%, aggressive 70-90% of free balance.
- **Reference existing holdings by exact amounts**: If the user holds 5.2 ETH ($12,500), reference those exact numbers. "Deploy 3 of your 5.2 ETH ($7,200) into Lido staking".
- **Build ON TOP of existing positions**: If they already supply USDC on Aave, suggest strategies that complement it. Don't duplicate what's already deployed.
- **Use existing tokens directly**: If user holds ETH and wants a delta-neutral, use their ETH directly (no swap needed). If they hold USDC and want ETH exposure, the first leg is a swap.
- **Identify risks in existing positions**: Low health factor, over-concentration, unhedged exposure — mention it in variantNote.
- **Show the full trade path**: Detail EVERY trade step by step with exact amounts from the portfolio. Example: "You hold 5.2 ETH ($12,500) → Stake 3 ETH on Lido ($7,200) → Short 3 ETH PERP on Hyperliquid ($7,200, 1x)".
- **If wallet is not connected** (no portfolio data at all): Use $10,000 as a hypothetical budget on L2 chains (Base, Arbitrum) and detail from scratch. Mention this is a hypothetical example.
- **If wallet IS connected but free balance is very low** (under $10): Do NOT invent a $10,000 budget. Be honest: "You have $X available. Consider depositing more funds before deploying a strategy." You can still suggest what they COULD do once funded.
- **If wallet IS connected with a real balance**: Size EVERYTHING from the actual free balance. No exceptions.

## Available Protocols on Meridian

### Lending / Yield
- **Aave v3**: supply, borrow, repay, withdraw. Multi-chain. Check live data for current APY per asset/chain.
- **Compound III**: supply, borrow, repay, withdraw. USDC market.
- **Morpho**: vault supply/withdraw (ERC-4626). Check Philidor risk scores in live data.
- **Spark**, **Fluid**: if they appear in live data, they are available.

### Liquid Staking
- **Lido**: stake ETH → stETH. Check live data for current staking APY. Liquid and composable.
- Other staking providers in live data (Rocket Pool, ether.fi, etc.): mention for comparison but Lido is the only one with live execution on Meridian.

### Perpetual Futures
- **Hyperliquid**: on-chain orderbook, up to 50x leverage. Check live funding rates in the data.
- **Extended**: StarkEx L2, up to 20x leverage. Active points program.
- **Ondo**: via LI.FI relay.
- **Lighter**: zk-rollup. Check live data for LLP vault APR if available.
Choose the perp venue based on: the user's goal (points? liquidity? fees?), NOT a default preference.

### Protocol Vaults
- **HLP (Hyperliquid)**: market-making vault. Check live APR in data.
- **LLP (Lighter)**: liquidity pool vault. Check live APR in data.
Use these when user wants passive yield with protocol exposure.

### Spot / Swaps
- **Uniswap v3**: any ERC20 pair. Live quoting + slippage protection.
- **LI.FI**: DEX aggregator comparing 30+ DEXes (1inch, Paraswap, 0x, CowSwap, etc.) for the best swap rate. Same-chain swaps only. Use protocol "LI.FI" for aggregated swaps.

### Cross-chain Bridge
- **deBridge**: bridge any token between chains (Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, BNB Chain, etc.). Use side "Bridge" with protocol "deBridge". The routing layer compares deBridge DLN and LI.FI and picks the best rate automatically. Estimated delivery: 1-3 minutes.

### Not Yet Live (mark "not yet live" in note if used)
- **Pendle**: fixed yield via PT tokens
- **EigenLayer**: restaking

## CRITICAL: Strategy Structural Integrity Rules

These rules are ABSOLUTE. A strategy that violates any of them is WRONG and must be fixed before output.

### Rule 1: Delta-neutral / beta-neutral strategies MUST have BOTH legs on the SAME asset
A strategy described as "delta-neutral", "beta-neutral", "market-neutral", or "no directional risk" MUST include:
- A LONG leg (spot buy, stake, or long perp) AND a SHORT leg (short perp) on the SAME underlying asset, with EQUAL notional sizes.
- Example: Swap USDC → ETH ($10,000) + Stake ETH on Lido ($10,000) + Short $10,000 ETH PERP on Hyperliquid.
- CRITICAL: Supplying a STABLECOIN (USDC, DAI, USDT) to a lending protocol is NOT a long position on any volatile asset. "Supply USDC on Morpho + Short ETH PERP" is a NAKED SHORT, not delta-neutral.
- A single short perp WITHOUT an offsetting long ON THE SAME ASSET is a DIRECTIONAL SHORT, not delta-neutral. NEVER label it neutral.
- The long and short legs SHOULD be on different venues when possible (e.g. spot on-chain + perp on Hyperliquid).
- Ideal delta-neutral for airdrop farming: Buy spot asset → optionally stake for yield (Lido/Aave) → short same asset perp on venue with points/funding.

### Rule 2: Funding rate harvesting requires spot + perp on the SAME asset
Earning funding rates (basis trade / cash-and-carry) requires:
- LONG the underlying spot asset (buy ETH, stake ETH for stETH, supply ETH to Aave, etc.) — NOT a stablecoin.
- SHORT the perpetual ON THE SAME ASSET on a venue with positive funding.
- Both legs at the SAME notional size to be delta-neutral.
- A short perp alone does NOT "harvest funding" — it is a naked short with full directional risk.
- "Supply USDC" + "Short ETH PERP" is NOT funding harvesting — the USDC does not offset the ETH short.

### Rule 3: Hedge strategies require an existing or new long exposure
A "hedge" is meaningless without something to hedge. Either:
- Reference the user's existing position (if mentioned) and add a SHORT perp to offset it.
- Or build a new position (e.g. supply ETH to Aave for yield) PLUS a short perp to hedge the price risk.
- A standalone short with no long side is NOT a hedge — it is a directional short bet.

### Rule 4: Every leg must be independently executable
Each leg must map to exactly one on-chain action. Do not combine multiple actions into one leg.
- "Buy ETH and stake it" = 2 legs: Swap USDC→ETH + Stake ETH on Lido.
- "Supply USDC and borrow ETH" = 2 legs: Supply USDC on Aave + Borrow ETH on Aave.

### Rule 5: Size consistency and portfolio-based sizing
When a strategy has offsetting legs (long + short for neutrality), both legs MUST have the same sizeUsd.
When the user's portfolio is provided, ALWAYS size legs based on their FREE BALANCE (idle wallet tokens), NOT the total portfolio value. A user with $50k total but only $8k free should get legs sized from that $8k.
When the user gives a total budget, split it sensibly across legs (e.g. $10k total = $10k long + $10k short for neutral, or $7k supply + $3k borrow for a leveraged yield play).

### Rule 7: Gas cost awareness and chain selection (CRITICAL)
Transaction fees MUST be factored into strategy viability. Approximate gas costs per transaction:
- **Ethereum L1**: $2-15 per tx (swap ~$8-15, supply/stake ~$3-8, approve ~$2-4)
- **Base / Arbitrum / Optimism**: $0.01-0.10 per tx
- **Polygon**: $0.01-0.05 per tx
- **BNB Chain**: $0.10-0.50 per tx

RULES:
- If the user's FREE BALANCE is under $100: ONLY suggest L2 chains (Base, Arbitrum, Optimism, Polygon). NEVER suggest Ethereum L1 — the gas fees would eat 10-50% of their capital.
- If the user's FREE BALANCE is under $500: Prefer L2 chains. Only suggest Ethereum L1 if the strategy is simple (1-2 tx max) and the yield justifies the gas cost.
- If the user's FREE BALANCE is under $50: Strategies must be MINIMAL — 1-2 legs max, on the cheapest chains (Base, Polygon). Be honest that limited capital restricts options.
- Total estimated gas cost for ALL legs of a strategy should be under 5% of the deployed capital. If a 4-leg strategy on Ethereum costs ~$40 in gas but the user only has $200, that's 20% — UNACCEPTABLE. Move to L2 or reduce legs.
- ALWAYS mention the chain in each leg's note (e.g. "on Base" or "on Arbitrum") so the user knows where to execute.
- When the live data shows the same protocol on multiple chains (e.g. Aave on Ethereum vs Aave on Base), prefer the cheaper chain if APY difference is small (< 1%).

### Rule 8: Minimum viable strategy
- NEVER suggest a strategy where any single leg's sizeUsd is less than $5. It's not worth the gas.
- If the user's free balance is $0 or near-zero, say so honestly: "Your wallet has no deployable capital. Deposit funds first."
- Do NOT invent strategies on $10,000 default budget when the user's wallet shows $30 free. Use THEIR actual balance.

### Rule 6: Leverage coherence
- Spot positions (Supply, Stake, Buy, Swap) NEVER have leverage — omit the field.
- Only Long/Short perp legs have leverage.
- Conservative: 1-2x. Moderate: 2-5x. Aggressive: 5-15x.
- 1x leverage on a perp is valid and common for basis trades.

## Strategy Design

1. **3 genuinely different strategies** — different mechanisms, not just different leverage on the same idea.
2. **Protocol selection from live data**: pick the protocol that currently offers the best rate for the user's goal. If Morpho has higher APY than Aave for USDC right now, say so. If a vault has exceptional yield, include it.
3. **Multi-leg composition**: 1-5 legs per strategy. Each leg = one on-chain action. Verify structural integrity rules above.
4. **Size**: use user's amount if given, otherwise $10,000.
5. **Leverage**: see Rule 6 above.
6. **summary**: 2-3 sentences with EXACT rates from live data. Why this approach, what's the expected outcome.
7. **variantNote**: name the specific risk (liquidation price, funding rate direction, smart contract risk, rate variability, etc.).
8. **Descriptive names** that differentiate strategies.

## Self-Check Before Output (MANDATORY)

Before returning your JSON, verify each strategy against this checklist:
- [ ] If the name or summary says "neutral" / "hedge" / "basis" / "cash-and-carry": does it have BOTH a long AND a short leg?
- [ ] If a leg says "Short" with no offsetting "Long": is the strategy honestly labeled as directional/bearish?
- [ ] Do offsetting legs have the same sizeUsd?
- [ ] Does every leg have a valid side from the allowed list?
- [ ] Are spot legs (Supply/Stake/Swap/Buy) free of leverage fields?
- [ ] Does every summary quote exact rates from the live data?

## Leg Format (STRICT)

side: exactly one of: "Supply", "Borrow", "Repay", "Withdraw", "Long", "Short", "Swap", "Stake", "Bridge", "Transfer", "Restake", "Buy"
asset: token symbol. Perps: "ETH PERP". Swaps: "USDC → ETH". Staking: output token "stETH".
protocol: exactly one of: "Aave", "Compound", "Lido", "Hyperliquid", "Extended", "Ondo", "Lighter", "Uniswap", "LI.FI", "Morpho", "Pendle", "EigenLayer", "Wallet", "deBridge"
sizeUsd: integer USD value.
leverage: only for Long/Short legs. Integer.
note: MUST include the exact live rate from data (e.g. "Currently 4.23% APY", "Funding +12.3% annualized").

## Output Format

Return ONLY valid JSON (no markdown, no text before/after):
{
  "understanding": "One sentence restating the user's goal",
  "strategies": [
    {
      "name": "Descriptive Name",
      "risk": "conservative",
      "variantNote": "Specific risk of this strategy",
      "summary": "2-3 sentences with exact live rates and expected outcome.",
      "legs": [
        { "side": "Supply", "asset": "USDC", "protocol": "Aave", "sizeUsd": 10000, "note": "Currently X.XX% APY on Ethereum" }
      ]
    },
    { "name": "...", "risk": "moderate", "variantNote": "...", "summary": "...", "legs": [...] },
    { "name": "...", "risk": "aggressive", "variantNote": "...", "summary": "...", "legs": [...] }
  ]
}`;

/** Fetch live yield context from our own aggregator route (server-side internal call). */
async function fetchYieldContext(baseUrl: string): Promise<string> {
  try {
    const res = await fetch(`${baseUrl}/api/yield-context`, {
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });
    if (!res.ok) return "";
    const data = await res.json();
    return data.summary ?? "";
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/*  Post-LLM structural validator                                      */
/* ------------------------------------------------------------------ */

interface LLMLeg {
  side: string;
  asset: string;
  protocol: string;
  sizeUsd?: number;
  leverage?: number;
  note?: string;
}

interface LLMStrategy {
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

/** Does this leg give actual long exposure on a volatile asset? Stablecoin supply/swap does NOT count. */
function isRealLongExposure(leg: LLMLeg): boolean {
  const side = leg.side.toLowerCase();
  if (!LONG_SIDES.has(side)) return false;
  const underlying = legUnderlying(leg);
  // Supplying/swapping a stablecoin (USDC, DAI, ...) is yield, not directional exposure.
  if (STABLECOINS.has(underlying.toLowerCase())) return false;
  return true;
}

/**
 * Validate a single LLM-produced strategy for structural coherence.
 * Fixes what can be fixed; relabels what can't.
 */
function validateAndFixStrategy(strategy: LLMStrategy): LLMStrategy {
  const legs = strategy.legs ?? [];
  const nameAndSummary = `${strategy.name} ${strategy.summary}`;
  const claimsNeutral = NEUTRAL_KEYWORDS.test(nameAndSummary);

  if (!claimsNeutral) {
    // Not claiming neutrality — just ensure spot legs don't carry leverage.
    return { ...strategy, legs: legs.map(fixSpotLeverage) };
  }

  // Strategy claims to be neutral: check it has both sides ON THE SAME ASSET.
  // "Supply USDC" is NOT long exposure on ETH — only a real long (spot buy,
  // stake, supply of the SAME volatile asset) counts as the offsetting leg.
  const shortLegs = legs.filter((l) => SHORT_SIDES.has(l.side.toLowerCase()));
  const shortAssets = new Set(shortLegs.map(legUnderlying));

  // A real long must be on one of the short-leg underlyings (or a derivative like stETH for ETH).
  const realLongs = legs.filter((l) => {
    if (!isRealLongExposure(l)) return false;
    const underlying = legUnderlying(l);
    // Direct match: long ETH offsets short ETH
    if (shortAssets.has(underlying)) return true;
    // Derivative match: stETH / wstETH / cbETH / rETH count as ETH exposure
    if (/^(ST|WST|CB|R)ETH$/i.test(underlying) && shortAssets.has("ETH")) return true;
    return false;
  });

  const hasMatchingLong = realLongs.length > 0;
  const hasShort = shortLegs.length > 0;

  if (hasMatchingLong && hasShort) {
    // Both sides present on the same asset — ensure matching sizes and fix spot leverage.
    return { ...strategy, legs: balanceNeutralSizes(legs).map(fixSpotLeverage) };
  }

  // Missing the offsetting long — add a spot buy for each unique shorted asset.
  if (hasShort && !hasMatchingLong) {
    const addedLegs: LLMLeg[] = [];
    for (const asset of shortAssets) {
      const matchingShorts = shortLegs.filter((l) => legUnderlying(l) === asset);
      const totalShortSize = matchingShorts.reduce((s, l) => s + (l.sizeUsd ?? 10000), 0);
      addedLegs.push({
        side: "Swap",
        asset: `USDC → ${asset}`,
        protocol: "Uniswap",
        sizeUsd: totalShortSize,
        note: `Spot long ${asset} to offset short perp — required for delta neutrality.`,
      });
    }
    const fixedLegs = [...addedLegs, ...legs].map(fixSpotLeverage);
    const assetList = [...shortAssets].join(", ");
    return {
      ...strategy,
      legs: fixedLegs,
      summary: `${strategy.summary} Includes spot ${assetList} purchase(s) to maintain delta neutrality.`,
    };
  }

  if (!hasShort) {
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

/** Format a portfolio snapshot into a human-readable string for the LLM. */
function formatPortfolioContext(portfolio: PortfolioSnapshot | undefined): string {
  if (!portfolio) return "";
  const freeBalance = Math.round(portfolio.freeBalanceUsd ?? 0);
  const lines: string[] = ["## USER'S CURRENT PORTFOLIO (live, read from wallet)"];
  lines.push(`Total net value: $${Math.round(portfolio.netUsd).toLocaleString()}`);
  lines.push(`FREE BALANCE (idle tokens in wallet, available to deploy): $${freeBalance.toLocaleString()}`);

  // Gas budget guidance based on free balance
  if (freeBalance < 50) {
    lines.push(`⚠️ VERY LOW CAPITAL — only suggest minimal strategies on L2 chains (Base, Arbitrum, Polygon). Ethereum L1 gas would consume most of the balance.`);
  } else if (freeBalance < 100) {
    lines.push(`⚠️ LOW CAPITAL — prefer L2 chains (Base, Arbitrum). Ethereum L1 gas ($5-15/tx) would be 5-15% of deployable capital.`);
  } else if (freeBalance < 500) {
    lines.push(`💡 MODERATE CAPITAL — prefer L2 chains. Ethereum L1 is acceptable only for simple 1-2 tx strategies.`);
  }
  if (portfolio.netDeltaEthTotal !== null && portfolio.netDeltaEthTotal !== undefined) {
    lines.push(`Net ETH delta (spot + perps): ${portfolio.netDeltaEthTotal.toFixed(4)} ETH`);
  }

  if (portfolio.assets && portfolio.assets.length > 0) {
    lines.push("\n### Wallet Holdings");
    for (const a of portfolio.assets) {
      if (a.usd < 1) continue;
      lines.push(`- ${a.balance.toFixed(4)} ${a.symbol} ($${Math.round(a.usd)}) on ${a.venue} · ${a.chain}`);
    }
  }

  if (portfolio.lendingPositions && portfolio.lendingPositions.length > 0) {
    lines.push("\n### Lending/Borrowing Positions");
    for (const p of portfolio.lendingPositions) {
      const parts = [`${p.protocol} on ${p.chain}`];
      if (p.collateralUsd > 0) parts.push(`collateral $${Math.round(p.collateralUsd)}`);
      if (p.debtUsd > 0) parts.push(`debt $${Math.round(p.debtUsd)}`);
      if (p.healthFactor !== null) parts.push(`HF ${p.healthFactor.toFixed(2)}`);
      lines.push(`- ${parts.join(" · ")}`);
    }
  }

  if (portfolio.perps && portfolio.perps.length > 0) {
    lines.push("\n### Open Perp Positions (Hyperliquid)");
    for (const p of portfolio.perps) {
      const dir = p.size >= 0 ? "Long" : "Short";
      lines.push(`- ${dir} ${Math.abs(p.size).toFixed(4)} ${p.coin} ($${Math.round(Math.abs(p.notional))}) · PnL $${p.unrealizedPnl.toFixed(2)}`);
    }
  }

  if (portfolio.assets?.length === 0 && portfolio.lendingPositions?.length === 0 && portfolio.perps?.length === 0) {
    lines.push("Portfolio is empty — no holdings detected.");
  }

  return lines.join("\n");
}

interface PortfolioSnapshot {
  netUsd: number;
  freeBalanceUsd?: number;
  assets?: { symbol: string; venue: string; chain: string; balance: number; usd: number }[];
  lendingPositions?: { protocol: string; chain: string; collateralUsd: number; debtUsd: number; healthFactor: number | null }[];
  perps?: { coin: string; size: number; notional: number; unrealizedPnl: number }[];
  netDeltaEthTotal?: number | null;
}

export async function POST(req: NextRequest) {
  try {
    const { thesis, portfolio } = await req.json();
    if (!thesis || typeof thesis !== "string" || thesis.trim().length === 0) {
      return NextResponse.json({ error: "thesis is required" }, { status: 400 });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "OPENROUTER_API_KEY not configured — add it to .env.local" },
        { status: 500 },
      );
    }

    const model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;

    // Fetch live yield data in parallel with nothing else — it's the only async dep
    const proto = req.headers.get("x-forwarded-proto") ?? "https";
    const host = req.headers.get("host") ?? "localhost:3000";
    const baseUrl = `${proto}://${host}`;
    const yieldContext = await fetchYieldContext(baseUrl);
    const portfolioContext = formatPortfolioContext(portfolio as PortfolioSnapshot | undefined);

    // Build the user message with live yield data + portfolio injected
    const sections: string[] = [];
    if (portfolioContext) sections.push(portfolioContext);
    if (yieldContext) sections.push(yieldContext);
    sections.push(`User thesis: ${thesis.trim()}`);
    const userMessage = sections.join("\n\n---\n\n");

    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://meridian-terminal.vercel.app",
        "X-Title": "Meridian Terminal",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        temperature: 0.4,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.error(`[parse-intent] OpenRouter ${response.status}:`, errText.slice(0, 500));
      return NextResponse.json(
        { error: `OpenRouter error ${response.status}` },
        { status: 502 },
      );
    }

    const completion = await response.json();
    const text: string = completion.choices?.[0]?.message?.content ?? "";

    if (!text) {
      return NextResponse.json({ error: "Empty response from model" }, { status: 500 });
    }

    // Extract JSON — handle bare JSON or wrapped in code fences
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = fenced ? fenced[1] : text;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[parse-intent] no JSON in response:", text.slice(0, 500));
      return NextResponse.json({ error: "Failed to parse model response" }, { status: 500 });
    }

    const parsed = JSON.parse(jsonMatch[0]);

    if (!parsed.strategies || !Array.isArray(parsed.strategies) || parsed.strategies.length === 0) {
      return NextResponse.json({ error: "No strategies in response" }, { status: 500 });
    }

    // Post-LLM structural validation: catch strategies that are logically
    // incoherent (e.g. labeled "neutral" but only have one directional leg).
    parsed.strategies = parsed.strategies.map(validateAndFixStrategy);

    return NextResponse.json(parsed);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[parse-intent] error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
