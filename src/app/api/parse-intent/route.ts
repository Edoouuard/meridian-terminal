import { deployableUsd, isLockedVenue } from "@/lib/budgetFit";
import { FEATURES } from "@/lib/features";
import { enforceExplicitOrder, parseExplicitPerpOrder } from "@/lib/explicitOrder";
import { NextRequest, NextResponse } from "next/server";
import { ACTIVE_CHAIN_IDS, CHAIN_LABEL } from "@/lib/onchain";
import { routingChainNames } from "@/lib/mcp/routerAllowlist";
import { strategistDoctrine } from "@/lib/planner/strategist";
import { cleanClarify } from "@/lib/planner/clarify";
import { capabilitiesSection } from "@/lib/planner/capabilities";
import { policySection, SIZING_POLICY } from "@/lib/planner/policy";
import { enforceConformance, namedVenues, type Objective } from "@/lib/planner/schema";
import type { VenueBalances } from "@/lib/planner/economics";
import type { MarketSnapshot } from "@/lib/planner/markets";
import { completionText } from "@/lib/planner/completion";
import { capitalShare, sizeQuestion } from "@/lib/planner/sizing";
import { buildPairStrategy, mentionedBases, pairAssetQuestion, parsePairRequest } from "@/lib/planner/pair";
import { cleanHistory, conversationSection, effectiveRequest } from "@/lib/planner/conversation";
import { marketBase } from "@/lib/perpVenues";
import { parseAmount } from "@/lib/tradePlan";
import { ANSWER_SYSTEM, cleanAnswer, marketSection, wantsAnswer, type PriceRow } from "@/lib/planner/answer";
import { chartsSection, fetchDefiCharts, pickCharts, priceMovesChart, type MarketChart } from "@/lib/planner/marketCharts";
import type { NewsItem } from "@/lib/news";
import { EXPLAIN_SYSTEM, explainPayload, mergeExplanations, type Explanation } from "@/lib/planner/explain";
import { hyperliquidMarginUsd, validateAndFixStrategy } from "@/lib/strategyIntegrity";

const OBJECTIVES = new Set(["explicit_order", "farming", "neutral_carry", "yield", "hedge", "directional", "move"]);

/**
 * POST /api/parse-intent
 *
 * Takes a raw thesis string and returns 1 to 3 plans (or one clarifying
 * question) via OpenRouter, checked against the planner contract
 * (lib/planner: doctrine, capabilities, policy, schema). This is Meridian's
 * "brain" — the agentic layer that understands free-form intent and maps
 * it to executable, multi-leg strategies across all wired protocols.
 *
 * OpenRouter lets us pick the best model per cost/quality tradeoff:
 *   - Default: google/gemini-2.5-flash (fast, cheap, good at structured JSON)
 *   - Can be overridden via OPENROUTER_MODEL env var (the proposal pass)
 *   - OPENROUTER_EXPLAIN_MODEL sets the explain pass (defaults to OPENROUTER_MODEL):
 *     a strong model can propose while a fast one writes the text
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "google/gemini-2.5-flash";

/** Appended while perps are feature-flagged off (lib/features.ts): steer to executable spot strategies. */
const PERPS_DISABLED_NOTE = `

## CURRENT LIMITATION — PERPS DISABLED
Perpetual futures (Hyperliquid, Extended, Ondo, Lighter) cannot be executed in Meridian right now — but depositing USDC into a Hyperliquid account can (side "Deposit", protocol "Hyperliquid"). Build every strategy from spot legs only (lending, borrowing, staking, swaps, bridges, vaults). Never put a Long or Short leg in a strategy.
For a hedge, a beta-neutral or delta-neutral goal, use the spot-only version: the "Beta-neutral ETH carry" (supply USDC on Aave, borrow WETH, swap it to an LST on Uniswap, supply the LST on Aave) from the live data. Mention once in variantNote that the perp version (spot in a vault + short perp) comes when perps are enabled.`;

/** Chains the chat may target, and the subset funds can be bridged between (lib/onchain ACTIVE_CHAIN_IDS, mcp/routerAllowlist). */
const ACTIVE_CHAINS = ACTIVE_CHAIN_IDS.map((id) => CHAIN_LABEL[id]).join(", ");
const BRIDGE_CHAINS = routingChainNames();

/**
 * Technical reference appended to the strategist doctrine (lib/planner/STRATEGIST.md):
 * venues, structural rules, leg format and output schema. The doctrine owns the
 * reasoning (read data, decode intent, ask or build, rank); this owns the format.
 */
const SYSTEM_PROMPT = `# Technical reference

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
- **Aave v3**: supply, borrow, repay, withdraw. Multi-chain. Check live data for current APY per asset/chain. Borrowing is executable: a Borrow leg needs collateral supplied first in the same strategy (or already in the user's Aave account); keep borrows at or under 45% of the collateral.
- **Compound III**: supply, borrow, repay, withdraw. USDC market.
- **Morpho**: vault supply/withdraw (ERC-4626). Check Philidor risk scores in live data.
- **Spark** (SparkLend, Aave v3 fork): supply, borrow, repay, withdraw on Ethereum only. Protocol "Spark".
- **Fluid**, **Spark Savings**, **Sky**, **Ethena**, **Yearn**, **Curve Savings**, **Curve LlamaLend**: verified savings and lending vaults, see "Savings vaults" below.

### Liquid Staking
- **Lido**: stake ETH → stETH on Ethereum. Check live data for current staking APY. Liquid and composable.
- **Other LSTs and liquid restaking tokens by swap** (ether.fi weETH, Kelp rsETH, Renzo ezETH, Rocket Pool rETH, Coinbase cbETH, Lido wstETH on L2s): bought on Uniswap — side "Swap", asset "WETH → weETH" (or rsETH, ezETH, rETH, cbETH, wstETH), protocol "Uniswap", on a chain where the token is listed (wstETH: Ethereum, Base, Arbitrum, Optimism, Polygon; weETH: Base, Arbitrum; rsETH: Arbitrum, Base (as wrsETH); ezETH: Base; rETH: Ethereum, Arbitrum, Optimism; cbETH: Ethereum, Base). Restaking tokens (rsETH, ezETH) add EigenLayer restaking rewards and risk to the staking yield: say so. The token then earns its staking yield just by being held; quote that yield from the live staking list. Cheaper than Ethereum L1 on Base/Arbitrum.

### Perpetual Futures
- **Hyperliquid**: on-chain orderbook, up to 50x leverage. Check live funding rates in the data.
- **Hyperliquid stock, index & commodity perps (HIP-3)**: Tesla, Nvidia, the S&P 500, gold, oil… are traded as perps with USDC margin, from the same Hyperliquid account as crypto perps. For a view on a stock, an index or a commodity ("short Tesla", "long gold", "hedge my portfolio with the S&P 500"), use side "Long" or "Short", protocol "Hyperliquid", chain "Arbitrum", and asset = the EXACT market name from the live "Stock, index & commodity perps" list followed by " PERP" (e.g. "xyz:TSLA PERP", "xyz:SP500 PERP", "xyz:GOLD PERP"). Never invent a market that isn't in that list; quote its live price and funding. Respect its max leverage. These markets trade around the clock but follow the underlying's price: say so in the risk note.
- **Extended**: StarkEx L2, up to 20x leverage. Active points program. Meridian signs Extended orders once the user has connected Extended. When the Extended account lacks margin and the wallet holds native USDC on Arbitrum, put a Deposit leg first (side "Deposit", protocol "Extended", asset "USDC", chain "Arbitrum", sizeUsd = the missing margin + $1, at least $10): Meridian deposits through Extended's bridge. When the user asks for Extended, the plan uses Extended even if the account is not connected or can't be funded: the server marks it blocked with what unblocks it. A Hyperliquid version is only an alternative, never the requested plan.
- **TxFlow**: its own L1 with an order book, USDC margin, hourly funding (see the live "TxFlow perps" list). Executable: the first trade asks one wallet signature to approve Meridian's TxFlow trading key (it can trade, never withdraw); no connection step. Assets by the EXACT market name + " PERP" ("ETH-USDC PERP"). When the TxFlow account lacks margin, put a Deposit leg first (side "Deposit", protocol "TxFlow", asset "USDC", chain "Arbitrum", sizeUsd = the missing margin + $1, at least $5): native USDC on Arbitrum goes to TxFlow's bridge. A withdrawal is side "Withdraw", protocol "TxFlow", asset "USDC" ($1 fee, minimum $2). Meridian doesn't place stop-loss / take-profit orders on TxFlow yet: say so when the user asks for one. When the user asks for TxFlow, the plan uses TxFlow; another venue is only an alternative.
- **Ondo**: via LI.FI relay.
- **Lighter**: zk-rollup. Check live data for LLP vault APR if available.
Choose the perp venue based on: the user's goal (points? liquidity? fees?), NOT a default preference.

### Protocol Vaults
- **HLP (Hyperliquid)**: market-making vault. Check live APR in data. Executable: side "Deposit", protocol "Hyperliquid", asset "HLP", sizeUsd = the USDC put in, chain "Arbitrum". It draws on USDC already in the user's Hyperliquid account (see HYPERLIQUID ACCOUNT); when there isn't enough, a Hyperliquid deposit leg (below) comes first. Locked 4 days; returns come from market making and can be negative — say both.
- **HYPE staking (Hyperliquid)**: executable: side "Stake", protocol "Hyperliquid", asset "HYPE", sizeUsd = the USD value staked. It stakes HYPE held in the user's Hyperliquid spot balance (two wallet signatures, delegated to the most staked validator charging ≤ 5%); unstaking takes 7 days — say so. HYPE held elsewhere must reach Hyperliquid spot first (say so; a Buy leg on Hyperliquid spot works when the user holds USDC there).
- **LLP (Lighter)**: liquidity pool vault. Check live APR in data.
Use these when user wants passive yield with protocol exposure.

### Spot / Swaps
- **Uniswap v3**: any ERC20 pair. Live quoting + slippage protection.
- Same-chain swaps are executed on Uniswap v3 only (best fee tier, live quote): protocol "Uniswap". Never use "LI.FI" for a swap leg — it isn't executable on the same chain.

### Cross-chain Bridge
- **deBridge**: bridge a token between ${BRIDGE_CHAINS} (the only chains whose routers Meridian has verified — never propose a bridge leg from or to another chain). Use side "Bridge" with protocol "deBridge". The routing layer compares deBridge DLN and LI.FI and picks the best rate automatically. Estimated delivery: 1-3 minutes.

### Not Yet Live (mark "not yet live" in note if used)
- **Pendle**: fixed yield by buying PT, held to expiry. ONLY use markets listed under "Pendle fixed yield" in the live data, on the chain shown (Ethereum, Arbitrum or Base): side "Supply", asset "PT-<name>" exactly as listed, protocol "Pendle". Bought with USDC (WETH for ETH markets). The list holds only Pendle "prime" (curated) markets and major-stablecoin markets (USDC, USDT, DAI, USDS, USDe and their savings versions, GHO, PYUSD); never propose a Pendle market that isn't listed. If no listed market fits, say so and use another venue. The rate is fixed only if held to expiry; say so.
- **Hyperliquid deposit**: fund the user's Hyperliquid account: side "Deposit", protocol "Hyperliquid", asset "USDC", chain "Arbitrum". Native USDC on Arbitrum only, minimum $5 (smaller deposits are lost); if the USDC is elsewhere, Meridian adds the bridge itself. If the user has no stablecoins at all, fund the margin by converting a token they hold on the way: a Bridge leg with fromAsset = that token, asset "USDC", toChain "Arbitrum" (never bridge a volatile token as itself). Margin already in the user's Hyperliquid account (see HYPERLIQUID ACCOUNT) needs no deposit. Funds arrive in ~1 minute. Use it when the user wants HLP, Hyperliquid trading or HYPE exposure; HLP deposits and HYPE staking then run from Meridian (above).
- **HyperEVM** (Hyperliquid's EVM chain): a Bridge leg can move funds there (toChain "HyperEVM"; USDC arrives as USDT0 or the route's token). HyperEVM protocols (HyperLend, Kinetiq kHYPE, Felix…) appear under the comparison-only lists: mention them, never put them in a leg. There is no DEX Meridian can sign on HyperEVM: never put a Swap leg there. To SELL UETH, UBTC or USOL (held on HyperEVM or already in the user's Hyperliquid spot balance) for USDC, use ONE leg, never a bridge: side "Sell", protocol "Hyperliquid", asset "UETH", chain "HyperEVM", sizeUsd = the USD value sold (the whole holding when the user says "my UETH"). Meridian moves the tokens from HyperEVM into the user's Hyperliquid spot balance and sells them on Hyperliquid's UETH/USDC order book; the USDC lands in the Hyperliquid account (usable as perp margin). Only when the user wants the money on another chain do HyperEVM tokens (UETH = ETH, UBTC = BTC, USDT0, WHYPE) leave with a Bridge leg that converts on the way (fromAsset "UETH", asset "USDC", chain "HyperEVM", toChain "Arbitrum"); a Bridge from HyperEVM always names fromAsset. For a hedge, UETH/UBTC already ARE the long side: keep them and only short the same notional, rather than selling them.
- **Savings vaults (verified ERC-4626)**: side "Supply", protocol exactly "Fluid", "Sky", "Spark Savings", "Ethena", "Yearn", "Curve Savings" or "Curve LlamaLend", asset = the token deposited, on a chain where the "Best … yields Meridian EXECUTES" list shows that protocol:
  - Fluid: USDC or USDT on Ethereum and Arbitrum, USDC on Base, WETH and GHO on Ethereum. Instant exit.
  - Sky: USDS → sUSDS (Sky Savings Rate) or DAI → sDAI (DAI Savings Rate) on Ethereum. Instant exit. The user must already hold USDS or DAI.
  - Curve Savings: crvUSD → scrvUSD on Ethereum (a share of crvUSD borrow fees). Instant exit.
  - Curve LlamaLend: lend crvUSD on Ethereum (the sfrxUSD-collateral market). Exit instant while the market has unborrowed crvUSD; the depositor earns the base rate (CRV rewards need gauge staking, which Meridian doesn't do — quote the base rate).
  - crvUSD: if the user holds none, a Swap leg USDC → crvUSD on Uniswap (Ethereum) comes first.
  - Spark Savings: USDC, USDT or WETH on Ethereum (spUSDC, spUSDT, spETH); USDC → sUSDC on Base and Arbitrum. Instant exit.
  - Yearn (v3 multi-strategy vaults): USDC, WETH or USDS on Ethereum (yvUSDC-1, yvWETH-1, yvUSDS-1). Instant exit, vault liquidity permitting; carries the risk of the strategies the vault allocates to.
  - Ethena: USDe → sUSDe on Ethereum. Exit takes a 7-day cooldown — say so; higher yield, carries Ethena's basis-trade and depeg risk.
  Quote the rate from the live list in the note. Never propose a protocol from the "comparison only" lists in a leg.
- **EigenLayer**: restake stETH on Ethereum only: side "Restake", asset "stETH", protocol "EigenLayer" (pair it with a Lido stake leg when the user holds ETH). A deposit alone earns no operator rewards until delegated to an operator in the EigenLayer app, and withdrawals take ~14 days — say both in the note.

## Composed strategies (REQUIRED when the goal allows)

When the goal is yield, income, a hedge or neutrality and the user did not fix the mechanism, consider composed, multi-leg strategies built only from the executable venues and live rates below, and include one when it beats a plain deposit by a margin the numbers show. Recipes:
- **Beta-neutral ETH carry (spot only, executable now)**: Supply USDC on Aave → Borrow WETH on Aave → Swap "WETH → <LST>" on Uniswap → Supply <LST> on Aave. The WETH debt (short ETH) offsets the LST (long ETH), so the value barely moves with ETH; it earns the USDC rate plus staking minus the WETH borrow rate on the borrowed part. Use ONLY a chain and LST listed under "Beta-neutral ETH carry" in the live data, its exact sizes (borrow share of the USDC) and its exact net APY. If its row says NOT worth it now, don't propose it, or say so.
- **LST + short perp (when perps are available, only if ETH funding in the live data is positive)**: all spot legs on Arbitrum. (1) Deposit USDC on Hyperliquid (chain "Arbitrum") — the margin, sizeUsd = N / L; (2) Swap "USDC → wstETH" (or weETH) on Uniswap, chain "Arbitrum" — size N; (3) Short "ETH PERP" on Hyperliquid, size N, leverage L (1-3). With capital C: N = C × L / (L + 1) (e.g. C $3,000 at 2x → $1,000 margin, $2,000 wstETH, $2,000 short). It earns the LST staking yield plus the funding rate on N, ETH-neutral. Never use Lido (Ethereum only) or a different chain for the long side of this recipe.
- **Neutral on Hyperliquid with the money already there (when the portfolio shows a HYPERLIQUID ACCOUNT balance and the wallet holds less)**: two legs, nothing leaves the account. (1) Buy the spot asset on Hyperliquid: side "Buy", asset "UETH" (ETH) or "UBTC" (BTC), protocol "Hyperliquid", chain "Arbitrum", size N; (2) Short "ETH PERP" (or "BTC PERP") on Hyperliquid, size N, leverage L (1-3). Sizing: on a unified account the spot USDC IS the perp collateral, so with free USDC C: N = C × L / (L + 1) reduced by the policy buffer and reserve; on a non-unified account, spot and perps balances are separate: N is capped by each. It earns the funding rate on N, ETH-neutral (UETH earns no staking yield). Every Hyperliquid order is at least $10. Prefer this over any recipe that needs wallet funds the user doesn't have.
- **Fixed + variable barbell**: part in a Pendle PT (fixed rate locked to expiry), part in an instant-exit vault (Fluid, Spark Savings, Morpho) for liquidity.
- **Restaking stack**: Stake ETH on Lido → Restake the stETH on EigenLayer (Ethereum).
- **Diversified stable basket**: split stables across 2-3 executable venues/chains from the live list to spread protocol risk.
Each composed strategy states in "summary" how the legs fit together and the blended APY computed from the live rates.
When you return several plans, they differ in mechanism unless the user fixed it: never the same recipe twice on two chains or two LSTs.
Never add Bridge legs or stablecoin swaps to move or convert the user's funds (Meridian adds them itself), and never swap before a Pendle leg (Pendle buys with USDC or WETH directly).

## CRITICAL: Strategy Structural Integrity Rules

These rules are ABSOLUTE. A strategy that violates any of them is WRONG and must be fixed before output.

### Rule 1: Delta-neutral / beta-neutral strategies MUST have BOTH legs on the SAME asset
A strategy described as "delta-neutral", "beta-neutral", "market-neutral", or "no directional risk" MUST include:
- A LONG leg (spot buy, stake, LST, or long perp) AND a SHORT leg on the SAME underlying asset, with EQUAL notional sizes. The short leg is a short perp, or a Borrow of that asset on Aave (borrowing WETH is short ETH; wstETH/weETH/rETH/cbETH count as ETH).
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

**FUNDS MOVE AUTOMATICALLY between ${BRIDGE_CHAINS}.** After you answer, Meridian checks each leg against the wallet and adds the bridge and stablecoin-swap steps it needs (e.g. USDT on Arbitrum → USDC on Base), keeping a leg where the funds are when bridging wouldn't pay for itself. So for stablecoin yield, pick the best venue across those chains by live APY and TVL — not just the chain the funds sit on — and don't add your own bridge or swap legs for funding. Stablecoins (USDC, USDT, DAI) are interchangeable for funding; volatile assets are never converted. 
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
- No leverage given: the sizing policy default; the user's leverage is a hard constraint.
- 1x leverage on a perp is valid and common for basis trades.

## Strategy Design

1. **1 to 3 plans** — only plans that differ in a way the user allowed (doctrine section 6); a single exact plan beats artificial variations.
2. **Protocol selection from live data**: pick the protocol that currently offers the best rate for the user's goal. If Morpho has higher APY than Aave for USDC right now, say so. If a vault has exceptional yield, include it.
3. **Multi-leg composition**: 1-5 legs per strategy. Each leg = one on-chain action. Verify structural integrity rules above.
4. **Size**: the user's amount if given; otherwise the sizing policy applied to the free amount (wallet not connected: a $10,000 hypothetical, said so).
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
- [ ] Does each strategy's "apy" match the rates in its leg notes, and is "exit" honest about lock-ups and queues?
- [ ] Several plans: do they differ in a way the user allowed (not the same recipe on another chain or LST)?

## Leg Format (STRICT)

side: exactly one of: "Supply", "Borrow", "Repay", "Withdraw", "Long", "Short", "Swap", "Stake", "Bridge", "Transfer", "Restake", "Buy", "Deposit", "Sell" (Deposit only for the Hyperliquid deposit; Sell only for selling UETH/UBTC/USOL on Hyperliquid spot)
asset: token symbol. Perps: "ETH PERP" (optional "stopLossPct" / "takeProfitPct" numbers on the perp leg); Hyperliquid stocks "xyz:AMD PERP"; Extended markets by their exact name + " PERP" ("ETH-USD PERP", "AMD_24_5-USD PERP"); TxFlow markets by their exact name + " PERP" ("ETH-USDC PERP"). Swaps: "USDC → ETH". Staking: output token "stETH".
protocol: exactly one of: "Aave", "Compound", "Spark", "Lido", "Hyperliquid", "Extended", "TxFlow", "Ondo", "Lighter", "Uniswap", "Morpho", "Pendle", "EigenLayer", "Fluid", "Sky", "Spark Savings", "Ethena", "Yearn", "Curve Savings", "Curve LlamaLend", "Wallet", "deBridge" (same-chain swaps use "Uniswap"; LI.FI same-chain swaps are not executable)
sizeUsd: integer USD value.
leverage: only for Long/Short legs. Integer.
to: only for a Transfer leg: the recipient address (0x…) or .eth name, copied exactly from the user's message. No recipient in the message → no Transfer leg; ask for one in the understanding.
sizeToken: only when the user gave an exact token quantity ("send 0.5 ETH"): that quantity as a decimal string, e.g. "0.5". sizeUsd stays the USD estimate.
note: MUST include the exact live rate from data (e.g. "Currently 4.23% APY", "Funding +12.3% annualized").

## Chain of each leg (REQUIRED)
Every leg MUST set "chain" to the chain where that leg executes, using one of: ${ACTIVE_CHAINS} — Meridian executes on no other chain; if the user asks for another one, say so in the understanding and use the closest of these. If the user names one of these chains, use it. For a Bridge leg, "chain" is the SOURCE chain and "toChain" (REQUIRED on Bridge legs) is the DESTINATION chain, e.g. { "side": "Bridge", "asset": "USDC", "protocol": "deBridge", "chain": "Arbitrum", "toChain": "Base", "sizeUsd": 100 }. The transaction is built on exactly this chain, so it must match the strategy name and summary.

## Output Format

Return ONLY valid JSON (no markdown, no text before/after). "decision" is "clarify" or "build" (doctrine section 2), or "answer" when the user asks a question to be answered in words, with no trade to plan (an explanation, a view, how something works). Never ask whether they want a plan or an overview: answer.

Answer (strategies empty; every point carries a figure from the live data, never invented):
{
  "decision": "answer",
  "understanding": "The question in one short sentence.",
  "answer": { "headline": "One line that answers it", "points": ["3 to 5 short points"], "takeaway": "What it means for the user", "followUps": ["A request Meridian can run next"] },
  "strategies": []
}

Clarify (one question, strategies empty):
{
  "decision": "clarify",
  "objective": "farming",
  "understanding": "The goal with its hard constraints, and what is missing.",
  "clarify": { "question": "Short question, in English", "why": "What in the data makes it necessary", "options": ["Answer that keeps the request", "Other complete answer"] },
  "strategies": []
}

Build (1 to 3 plans):
{
  "decision": "build",
  "objective": "explicit_order | farming | neutral_carry | yield | hedge | directional | move",
  "understanding": "The goal in the user's terms with every hard constraint; what blocks it, if anything.",
  "strategies": [
    {
      "kind": "requested",
      "status": "executable",
      "blockers": [],
      "changes": [],
      "name": "Short name, max 4 words",
      "risk": "conservative | moderate | aggressive",
      "apy": 4.8,
      "exit": "Instant",
      "fit": "One line: who this suits",
      "risks": ["Short risk 1", "Short risk 2"],
      "variantNote": "The single most important caveat",
      "summary": "What it does, the figures that justify it now, the yearly result in dollars as a projection.",
      "economics": null,
      "figures": [
        { "label": "ETH funding (Hyperliquid)", "value": "+11.0%/yr", "kind": "observed", "source": "Perp Funding Rates: ETH" }
      ],
      "legs": [
        { "side": "Buy", "asset": "UETH", "protocol": "Hyperliquid", "chain": "Arbitrum", "sizeUsd": 31, "note": "…" }
      ]
    }
  ]
}

Field rules:
- "kind": "requested" when every hard constraint is met, else "alternative" with every change in "changes" ("venue: Extended → Hyperliquid"). The server re-checks this against the request and reclassifies a plan that breaks a constraint.
- "status": "blocked" when something prevents execution now, with each reason in "blockers"; the server also blocks Extended legs from the Extended account state.
- "economics": leave it null for plans on Hyperliquid / Extended / TxFlow: the server sizes and prices them leg by leg from the market data. For spot DeFi plans, give { "capitalCommittedUsd", "annualizedGrossCarryUsd", "entryExitCostUsd", "holdingDays" } from the data; null where unknown. Never "annualizedReturnOnCapitalPct": the server computes it.
- "sizeUsd": the USD size you intend per leg; the server converts it to a base quantity valid on the market (both markets for a pair). Unknown free amount → null (the plan is blocked).
- "figures": the key observed numbers with their source. The server replaces them for venue plans.
- "apy": blended expected APY in percent from the live data, for yield plans only; omit it for directional trades and pairs (use "economics").
- "exit": how and how fast the user gets their money back: "Instant", "~1-5 days (Lido withdrawal queue)", "Locked until 26 Mar 2027 (or sell PT at market)".
- "risks": 2 to 4 short items, specific to the plan. No generic filler.
- Keep every text field to one short sentence: a second pass writes the final text from the validated plans. Your answer must fit in about 1,500 tokens.
- Don't set "recommended": the server recommends the best executable requested plan.`;

/** Fetch live yield context from our own aggregator route (server-side internal call): the text for the model, the quotes for the checks. */
async function fetchYieldContext(baseUrl: string, cookie: string | null): Promise<{ summary: string; markets?: MarketSnapshot }> {
  try {
    const res = await fetch(`${baseUrl}/api/yield-context`, {
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
      // The beta gate (src/proxy.ts) guards every API route: pass the tester's cookie along.
      headers: cookie ? { cookie } : undefined,
    });
    if (!res.ok) {
      console.error("[parse-intent] yield-context failed:", res.status);
      return { summary: "" };
    }
    const data = await res.json();
    const markets = data.markets && Array.isArray(data.markets.quotes) && data.markets.quotes.length > 0 ? (data.markets as MarketSnapshot) : undefined;
    return { summary: data.summary ?? "", markets };
  } catch {
    return { summary: "" };
  }
}

/** Live prices and headlines for a market answer; an unavailable source comes back empty. */
async function fetchMarketPulse(baseUrl: string, cookie: string | null): Promise<{ prices: PriceRow[]; news: NewsItem[] }> {
  const get = async (path: string) => {
    try {
      const res = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(8000), cache: "no-store", headers: cookie ? { cookie } : undefined });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };
  const [prices, news] = await Promise.all([get("/api/prices"), get("/api/news")]);
  return { prices: Array.isArray(prices) ? (prices as PriceRow[]) : [], news: Array.isArray(news?.items) ? (news.items as NewsItem[]) : [] };
}

/** Answer pass: the market read, from the live data. */
const ANSWER_MAX_TOKENS = 4096;
const ANSWER_TIMEOUT_MS = 60_000;

/**
 * One chat completion as text; throws on a transport or HTTP error, on an
 * error OpenRouter returns with HTTP 200, and on an empty answer (with the
 * finish reason, e.g. "length" when the output budget ran out).
 */
async function complete(apiKey: string, model: string, messages: { role: string; content: string }[], maxTokens: number, timeoutMs: number): Promise<string> {
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://meridian-terminal.vercel.app",
      "X-Title": "Meridian Terminal",
    },
    // Reasoning models (Haiku 5.5) otherwise think until max_tokens and return no text: keep the thinking short and out of the answer.
    body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0.3, reasoning: { effort: "low", exclude: true }, messages }),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw Object.assign(new Error(`OpenRouter error ${response.status}`), { status: response.status, detail: errText.slice(0, 500) });
  }
  const completion = await response.json().catch(() => null);
  const apiError = (completion as { error?: { message?: unknown; code?: unknown } } | null)?.error;
  if (apiError) {
    throw Object.assign(new Error(`OpenRouter error: ${typeof apiError.message === "string" ? apiError.message.slice(0, 200) : "unknown"}`), { status: 502, detail: JSON.stringify(apiError).slice(0, 500) });
  }
  const text = completionText(completion);
  if (!text.trim()) {
    const choice = (completion as { choices?: { finish_reason?: unknown }[] } | null)?.choices?.[0];
    throw Object.assign(new Error("Empty response from model"), { status: 502, detail: JSON.stringify({ model, finish: choice?.finish_reason ?? null, usage: (completion as { usage?: unknown } | null)?.usage ?? null }).slice(0, 500) });
  }
  return text;
}

/** complete(), retried once on the default model when the configured one fails for a reason other than a timeout. */
async function completeWithFallback(apiKey: string, model: string, messages: { role: string; content: string }[], maxTokens: number, timeoutMs: number): Promise<{ text: string; model: string }> {
  try {
    return { text: await complete(apiKey, model, messages, maxTokens, timeoutMs), model };
  } catch (err) {
    const e = err as Error & { detail?: string };
    if (model === DEFAULT_MODEL || e.name === "TimeoutError") throw err;
    console.error(`[parse-intent] ${model} failed (${e.message}), retrying on ${DEFAULT_MODEL}`, e.detail ?? "");
    return { text: await complete(apiKey, DEFAULT_MODEL, messages, maxTokens, Math.min(timeoutMs, 40_000)), model: DEFAULT_MODEL };
  }
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const m = raw.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}

/** What the planner may do on Extended, from the user's Extended account state. */
function extendedAccountLine(ext: PortfolioSnapshot["extended"]): string {
  if (!ext?.connected) {
    return "EXTENDED ACCOUNT: not connected. An Extended leg can't run yet: connecting takes three wallet signatures (Tools → Extended); Meridian can then deposit USDC from Arbitrum.";
  }
  if (ext.network && ext.network !== "mainnet") return `EXTENDED ACCOUNT: connected on ${ext.network} only (test funds); real Extended legs need the mainnet account.`;
  if (ext.availableUsd === undefined) return "EXTENDED ACCOUNT: connected on mainnet; its balance couldn't be read just now (assume it may be empty and say so).";
  if (ext.availableUsd < 1) return "EXTENDED ACCOUNT: connected on mainnet with no USDC. An Extended leg needs a Deposit leg to Extended first (from native USDC on Arbitrum).";
  return `EXTENDED ACCOUNT: connected on mainnet, $${Math.round(ext.availableUsd).toLocaleString()} USDC free as margin (equity $${Math.round(ext.equityUsd ?? 0).toLocaleString()}). Extended legs up to that margin run now.`;
}

/** What the planner may do on TxFlow, from the wallet's TxFlow account (read by address, no connection step). */
function txflowAccountLine(tx: PortfolioSnapshot["txflow"]): string {
  if (tx === undefined || tx === null) return "TXFLOW ACCOUNT: balance unknown right now (not read): don't size TxFlow legs from a guess; a TxFlow plan is blocked until it is read.";
  if (tx.availableUsd < 1) return "TXFLOW ACCOUNT: no USDC. A TxFlow leg needs a Deposit leg to TxFlow first (side \"Deposit\", protocol \"TxFlow\", asset \"USDC\", chain \"Arbitrum\", from native USDC on Arbitrum, minimum $5). The first TxFlow trade asks one wallet signature to approve Meridian's trading key.";
  return `TXFLOW ACCOUNT: $${Math.round(tx.availableUsd).toLocaleString()} USDC free as margin (equity $${Math.round(tx.equityUsd).toLocaleString()}). TxFlow legs up to that margin run now.`;
}

/** Format a portfolio snapshot into a human-readable string for the LLM. */
function formatPortfolioContext(portfolio: PortfolioSnapshot | undefined): string {
  if (!portfolio) return "";
  // Recomputed from the holdings when they're sent: only wallet tokens and free Hyperliquid spot can fund a strategy.
  const freeBalance = Math.round(portfolio.assets?.length ? deployableUsd(portfolio.assets) : (portfolio.freeBalanceUsd ?? 0));
  const hlMargin = hyperliquidMarginUsd(portfolio);
  // Money in the Hyperliquid account funds Hyperliquid positions (perps and the spot side of a neutral one) directly.
  const capital = freeBalance + Math.round(hlMargin);
  const lines: string[] = ["## USER'S CURRENT PORTFOLIO (live, read from wallet)"];
  lines.push(`Total net value: $${Math.round(portfolio.netUsd).toLocaleString()}`);
  lines.push(`FREE BALANCE (idle tokens in wallet, available to deploy): $${freeBalance.toLocaleString()}`);
  if (hlMargin >= 1) {
    lines.push(`CAPITAL FOR HYPERLIQUID POSITIONS: $${capital.toLocaleString()} (wallet + the Hyperliquid account). Size Hyperliquid strategies from this, not from the wallet alone.`);
  }

  // Gas budget guidance based on what can be deployed
  if (capital < 50) {
    lines.push(`⚠️ VERY LOW CAPITAL — for on-chain legs, only minimal strategies on L2 chains (Base, Arbitrum, Polygon); Hyperliquid and Extended orders pay no gas. Don't mention chains to the user for a perp-only plan.`);
  } else if (capital < 100) {
    lines.push(`⚠️ LOW CAPITAL — prefer L2 chains (Base, Arbitrum). Ethereum L1 gas ($5-15/tx) would be 5-15% of deployable capital.`);
  } else if (capital < 500) {
    lines.push(`💡 MODERATE CAPITAL — prefer L2 chains. Ethereum L1 is acceptable only for simple 1-2 tx strategies.`);
  }
  if (portfolio.netDeltaEthTotal !== null && portfolio.netDeltaEthTotal !== undefined) {
    lines.push(`Net ETH delta (spot + perps): ${portfolio.netDeltaEthTotal.toFixed(4)} ETH`);
  }

  if (hlMargin >= 1) {
    lines.push(`HYPERLIQUID ACCOUNT: $${Math.round(hlMargin).toLocaleString()} of stablecoins already in the user's Hyperliquid account, usable right now as perp margin and to buy UETH/UBTC on Hyperliquid spot (the long side of a neutral position there, see the recipe). A Long/Short on Hyperliquid needs NO Deposit leg up to that margin; add a Deposit only for margin beyond it. To use it anywhere else (lending, vaults, another chain), the FIRST leg is a withdrawal: side "Withdraw", protocol "Hyperliquid", asset "USDC", chain "Arbitrum", sizeUsd ≤ that amount — it lands as USDC on Arbitrum in ~5 min minus a $1 fee; Meridian adds any bridge after it. Never plan a leg elsewhere that spends this USDC without that withdrawal.`);
  }

  if (portfolio.hyperliquid) {
    const h = portfolio.hyperliquid;
    lines.push(
      `HYPERLIQUID ACCOUNT BALANCES (observed): collateral $${h.collateralUsd.toFixed(2)}, margin in use $${h.marginUsedUsd.toFixed(2)}, FREE MARGIN $${h.freeMarginUsd.toFixed(2)} (what new positions and spot buys can use), ${h.unified ? "unified account (spot USDC is the perp collateral)" : `standard account (spot USDC $${h.spotUsdcUsd.toFixed(2)} is separate from perps)`}.`,
    );
  } else {
    lines.push("HYPERLIQUID ACCOUNT BALANCES: unknown (not read) — don't size Hyperliquid legs from a guess.");
  }
  lines.push(extendedAccountLine(portfolio.extended));
  lines.push(txflowAccountLine(portfolio.txflow));

  if (portfolio.assets && portfolio.assets.length > 0) {
    lines.push("\n### Wallet Holdings");
    for (const a of portfolio.assets) {
      if (a.usd < 1) continue;
      lines.push(`- ${a.balance.toFixed(4)} ${a.symbol} ($${Math.round(a.usd)}) on ${a.venue} · ${a.chain}${isLockedVenue(a.venue) ? " — LOCKED (staked / in a vault): not part of the free balance, never size a leg from it" : ""}`);
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
  extended?: { connected: boolean; network?: string; equityUsd?: number; availableUsd?: number };
  txflow?: { equityUsd: number; availableUsd: number } | null;
  hyperliquid?: { unified: boolean; collateralUsd: number; marginUsedUsd: number; freeMarginUsd: number; spotUsdcUsd: number } | null;
}

/**
 * Two model calls (propose, then explain) plus the live-data read. A strong
 * proposal model can take over a minute; Fluid compute allows up to 300s on
 * every plan, so the budgets below (with one fallback-model retry) fit in 190s.
 */
export const maxDuration = 190;

const MAX_THESIS_CHARS = 2000;
/** Proposal pass; with the explain pass after it, the whole call stays under maxDuration. */
const PROPOSE_TIMEOUT_MS = 100_000;
/** The proposal is structure only (~1,500 tokens of JSON); the rest is room for a reasoning model's short thinking. */
const PROPOSE_MAX_TOKENS = 8192;
const EXPLAIN_MAX_TOKENS = 4096;
/** Explain pass: past this the deterministic summaries are used. */
const EXPLAIN_TIMEOUT_MS = 25_000;

export async function POST(req: NextRequest) {
  try {
    const { thesis, portfolio, clarified, answeredQuestion, history: rawHistory } = await req.json();
    if (!thesis || typeof thesis !== "string" || thesis.trim().length === 0) {
      return NextResponse.json({ error: "thesis is required" }, { status: 400 });
    }
    if (thesis.length > MAX_THESIS_CHARS) {
      return NextResponse.json({ error: `Keep the request under ${MAX_THESIS_CHARS} characters.` }, { status: 400 });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "OPENROUTER_API_KEY not configured — add it to .env.local" },
        { status: 500 },
      );
    }

    const model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
    const explainModel = process.env.OPENROUTER_EXPLAIN_MODEL || model;

    // Fetch live yield data in parallel with nothing else — it's the only async dep
    const proto = req.headers.get("x-forwarded-proto") ?? "https";
    const host = req.headers.get("host") ?? "localhost:3000";
    const baseUrl = `${proto}://${host}`;
    const yieldContext = await fetchYieldContext(baseUrl, req.headers.get("cookie"));
    const portfolioContext = formatPortfolioContext(portfolio as PortfolioSnapshot | undefined);
    const snapshot = portfolio as PortfolioSnapshot | undefined;

    // A follow-up ("why not long Hyperliquid and short Extended?") applies to the last request that named an asset:
    // the server's checks read both together, and the model sees the conversation.
    const history = cleanHistory(rawHistory);
    const request = effectiveRequest(thesis.trim(), history, yieldContext.markets);
    const answered = typeof answeredQuestion === "string" ? answeredQuestion : undefined;

    // A question for a view, not a trade ("what do you think about the market?", "overview only, no plan"): answered in words.
    if (wantsAnswer(request)) {
      const [pulse, defi] = await Promise.all([fetchMarketPulse(baseUrl, req.headers.get("cookie")), fetchDefiCharts()]);
      const moves = priceMovesChart(pulse.prices);
      const available: MarketChart[] = [...(moves ? [moves] : []), ...defi];
      const sections = [marketSection(pulse.prices, pulse.news), chartsSection(defi)];
      if (yieldContext.summary) sections.push(yieldContext.summary);
      if (portfolioContext) sections.push(portfolioContext);
      const convo = conversationSection(history);
      if (convo) sections.push(convo);
      sections.push(`User question: ${request}`);
      try {
        const { text: raw } = await completeWithFallback(
          apiKey,
          model,
          [
            { role: "system", content: ANSWER_SYSTEM },
            { role: "user", content: sections.join("\n\n---\n\n") },
          ],
          ANSWER_MAX_TOKENS,
          ANSWER_TIMEOUT_MS,
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let out: any = null;
        try {
          out = extractJson(raw);
        } catch {
          out = null;
        }
        const answer = cleanAnswer(out?.answer);
        if (!answer) {
          console.error("[parse-intent] answer malformed", { sample: raw.slice(0, 300) });
          return NextResponse.json({ error: "The market answer came back malformed" }, { status: 500 });
        }
        const charts = pickCharts(out?.answer?.charts, available);
        return NextResponse.json({ decision: "answer", understanding: typeof out.understanding === "string" ? out.understanding : "", answer: { ...answer, charts }, strategies: [] });
      } catch (err) {
        const e = err as Error & { detail?: string };
        console.error("[parse-intent] answer failed:", e.message, e.detail ?? "");
        return NextResponse.json({ error: e.message }, { status: 502 });
      }
    }

    // Questions the server asks itself, before any plan: which asset for a two-venue neutral position, then how much capital.
    const pairReq = FEATURES.perps ? parsePairRequest(request, yieldContext.markets, { extendedConnected: !!snapshot?.extended?.connected && snapshot.extended.network !== "testnet" }) : null;
    if (pairReq && !pairReq.base) {
      const q = pairAssetQuestion(yieldContext.markets, pairReq.venues);
      if (q && answered !== q.question) {
        const [va, vb] = pairReq.venues ?? ["Hyperliquid", "Extended"];
        return NextResponse.json({ decision: "clarify", understanding: `A neutral position between ${va} and ${vb}: the asset is missing.`, clarify: q, strategies: [] });
      }
    }
    const asked = snapshot && FEATURES.perps
      ? sizeQuestion({
          thesis: request,
          answeredQuestion: answered,
          hyperliquidFreeUsd: snapshot.hyperliquid ? snapshot.hyperliquid.freeMarginUsd : null,
          extendedFreeUsd: snapshot.extended?.connected ? (snapshot.extended.availableUsd ?? null) : null,
          txflowFreeUsd: snapshot.txflow ? snapshot.txflow.availableUsd : null,
        })
      : null;
    if (asked) return NextResponse.json({ decision: "clarify", understanding: asked.understanding, clarify: asked.clarify, strategies: [] });

    // Build the user message with live yield data + portfolio injected
    const sections: string[] = [];
    if (portfolioContext) sections.push(portfolioContext);
    if (yieldContext.summary) sections.push(yieldContext.summary);
    else sections.push("## LIVE DATA UNAVAILABLE\nThe live rates could not be loaded for this request. Do not quote any APY or rate: omit \"apy\", and say in each summary that rates will be shown live before signing.");
    const convo = conversationSection(history);
    if (convo) sections.push(convo);
    sections.push(request === thesis.trim() ? `User thesis: ${thesis.trim()}` : `User message: ${thesis.trim()}\nResolved with the conversation (plan this): ${request}`);
    if (clarified) {
      sections.push(
        `The user answered your question${typeof answeredQuestion === "string" ? ` ("${answeredQuestion.slice(0, 300)}")` : ""}; their answer ends the thesis. That question is resolved: never ask it again. Build, unless the answer reveals a different blocker that needs a different question.`,
      );
    }
    const userMessage = sections.join("\n\n---\n\n");

    // The two-venue neutral position on a named asset is built by the server (lib/planner/pair.ts), not proposed by the model.
    const serverPair = pairReq?.base && yieldContext.markets ? buildPairStrategy({ ...pairReq, base: pairReq.base }, yieldContext.markets) : null;
    // A dollar size is the position per leg (as for a single order); without one the server sizes from the free margin below.
    const pairSize = parseAmount(request);
    if (serverPair && pairSize !== undefined) serverPair.legs = serverPair.legs.map((l) => ({ ...l, sizeUsd: pairSize }));

    // Pipeline step 1: the model reads the data and proposes structures (or one question).
    let text: string;
    let usedModel = model;
    if (serverPair) {
      const goal = /\b(volume|farm\w*|points?)\b/i.test(request) ? "farming" : "neutral_carry";
      text = JSON.stringify({
        decision: "build",
        objective: goal,
        understanding: `Neutral position on ${pairReq!.base}: long on one venue, short the same quantity on the other, between ${(pairReq!.venues ?? ["Hyperliquid", "Extended"]).join(" and ")}.`,
        strategies: [serverPair],
      });
    } else try {
      ({ text, model: usedModel } = await completeWithFallback(
        apiKey,
        model,
        [
          { role: "system", content: [strategistDoctrine(), capabilitiesSection(), policySection(), FEATURES.perps ? SYSTEM_PROMPT : SYSTEM_PROMPT + PERPS_DISABLED_NOTE].join("\n\n---\n\n") },
          { role: "user", content: userMessage },
        ],
        PROPOSE_MAX_TOKENS,
        PROPOSE_TIMEOUT_MS,
      ));
    } catch (err) {
      const e = err as Error & { status?: number; detail?: string };
      console.error(`[parse-intent] propose failed:`, e.message, e.detail ?? "");
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    if (!text) {
      console.error("[parse-intent] empty response", { model: usedModel });
      return NextResponse.json({ error: "Empty response from model" }, { status: 500 });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let parsed: any;
    try {
      parsed = extractJson(text);
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object") {
      console.error("[parse-intent] no JSON in response:", text.slice(0, 500));
      return NextResponse.json({ error: "Failed to parse model response" }, { status: 500 });
    }
    // An explicit order ("short ETH 2x, SL 20%") is strategy 1, whatever the model proposed — only on a market a venue lists.
    const parsedOrder = FEATURES.perps ? parseExplicitPerpOrder(request) : null;
    const listed = (asset: string) => !yieldContext.markets || yieldContext.markets.quotes.some((q) => q.kind === "perp" && q.base.toUpperCase() === marketBase(asset)) || mentionedBases(asset, yieldContext.markets).length > 0;
    const explicit = parsedOrder && listed(parsedOrder.asset) ? parsedOrder : null;
    if (!Array.isArray(parsed.strategies)) parsed.strategies = [];

    // One clarifying question instead of plans (doctrine section 2) — never
    // over an explicit order, and never the question the user just resolved.
    const clarify = cleanClarify(parsed.clarify);
    const sameQuestion = (q: string) => typeof answeredQuestion === "string" && q.trim().toLowerCase() === answeredQuestion.trim().toLowerCase();
    if (clarify && parsed.strategies.length === 0 && !explicit && !sameQuestion(clarify.question)) {
      return NextResponse.json({ decision: "clarify", understanding: typeof parsed.understanding === "string" ? parsed.understanding : "", clarify, strategies: [] });
    }
    // A question the model chose to answer in words ("explain funding rates").
    const modelAnswer = cleanAnswer(parsed.answer);
    if (modelAnswer && parsed.strategies.length === 0 && !explicit) {
      return NextResponse.json({ decision: "answer", understanding: typeof parsed.understanding === "string" ? parsed.understanding : "", answer: modelAnswer, strategies: [] });
    }
    if (parsed.strategies.length === 0 && !explicit) {
      // Diagnostics only: the shape the model returned, never the user's text.
      console.error("[parse-intent] no strategies", {
        model,
        keys: Object.keys(parsed),
        decision: parsed.decision,
        clarifyRejected: parsed.clarify ? (clarify ? "same question as the one answered" : "malformed (needs a question and 2-4 options)") : undefined,
        sample: text.slice(0, 300),
      });
      return NextResponse.json({ error: "No strategies in response" }, { status: 500 });
    }

    // Deterministic checks on what the model proposed: the user's order first,
    // structure and budget, venue minimums, then the planner contract
    // (requested vs alternative, blocked, economics, recommendation).
    const wallet = { assets: snapshot?.assets };
    let strategies = enforceExplicitOrder(parsed.strategies, explicit, wallet.assets, snapshot?.extended?.availableUsd, snapshot?.txflow ? snapshot.txflow.availableUsd : undefined);
    strategies = strategies.map((st: Parameters<typeof validateAndFixStrategy>[0]) => validateAndFixStrategy(st, wallet));
    const objective = OBJECTIVES.has(parsed.objective) ? (parsed.objective as Objective) : explicit ? "explicit_order" : undefined;

    // Steps 2-3: the server validates (capabilities, sizing, economics from
    // the market quotes and the balances) and ranks. A balance the client
    // didn't read is unknown (null), never zero.
    const ext = snapshot?.extended;
    const balances: VenueBalances = {
      hyperliquidFreeUsd: snapshot?.hyperliquid ? snapshot.hyperliquid.freeMarginUsd : null,
      extendedFreeUsd: ext?.connected ? (ext.availableUsd ?? null) : 0,
      txflowFreeUsd: snapshot?.txflow ? snapshot.txflow.availableUsd : null,
      walletDeployableUsd: snapshot?.assets?.length ? deployableUsd(snapshot.assets) : 0,
    };
    const conformance = enforceConformance(strategies, objective, {
      order: explicit,
      namedVenues: namedVenues(request),
      extended: ext,
      markets: yieldContext.markets,
      balances,
      // No dollar size: the share the user chose (or the policy's), applied by the server to the free margin.
      sizeShare: parseAmount(request) === undefined && !explicit?.sizeUsd ? (capitalShare(request) ?? SIZING_POLICY.maxUtilization) : undefined,
      now: Date.now(),
    });
    if (conformance.notes.length) console.info("[parse-intent] conformance:", conformance.notes.join(" | "));
    if (conformance.strategies.length === 0) {
      console.error("[parse-intent] no plan left after checks", { model, proposed: strategies.length, notes: conformance.notes });
      return NextResponse.json({ error: "No plan met the request's constraints" }, { status: 500 });
    }

    // Step 4: the model explains the validated plans without changing them.
    // Text with a number the plan doesn't contain is replaced by a template.
    let understanding: string = typeof parsed.understanding === "string" ? parsed.understanding : "";
    let explanations: Explanation[] | undefined;
    try {
      // No model fallback here: a failed explanation falls back to the deterministic summaries.
      const explainText = await complete(
        apiKey,
        explainModel,
        [
          { role: "system", content: EXPLAIN_SYSTEM },
          { role: "user", content: JSON.stringify(explainPayload(request, understanding, conformance.strategies, conformance.recommended)) },
        ],
        EXPLAIN_MAX_TOKENS,
        EXPLAIN_TIMEOUT_MS,
      );
      const x = extractJson(explainText) as { understanding?: unknown; plans?: unknown } | null;
      if (x && Array.isArray(x.plans)) explanations = x.plans as Explanation[];
      if (x && typeof x.understanding === "string" && x.understanding.trim()) understanding = x.understanding.trim();
    } catch (err) {
      console.error("[parse-intent] explain failed, using templates:", err instanceof Error ? err.message : err);
    }
    const merged = mergeExplanations(conformance.strategies, explanations, request);
    if (merged.rejected.length) console.info("[parse-intent] explanations replaced by templates (ungrounded numbers):", merged.rejected.join(", "));

    return NextResponse.json({
      decision: "build",
      objective,
      understanding,
      strategies: merged.plans,
      recommended: conformance.recommended,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[parse-intent] error:", message, err instanceof Error ? err.stack?.split("\n").slice(0, 4).join(" | ") : "");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
