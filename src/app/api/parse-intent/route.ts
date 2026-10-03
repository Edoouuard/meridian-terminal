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
5. SCAN the live data: which protocols currently offer the best rates for this goal?
6. COMPARE: for yield, rank all available options from the live data. For exposure, check funding rates. For staking, compare all staking providers.
7. COMPOSE 3 genuinely different approaches using the best live opportunities.

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

### Not Yet Live (mark "not yet live" in note if used)
- **Pendle**: fixed yield via PT tokens
- **EigenLayer**: restaking

## Strategy Design

1. **3 genuinely different strategies** — different mechanisms, not just different leverage on the same idea.
2. **Protocol selection from live data**: pick the protocol that currently offers the best rate for the user's goal. If Morpho has higher APY than Aave for USDC right now, say so. If a vault has exceptional yield, include it.
3. **Multi-leg composition**: 1-5 legs per strategy. Each leg = one on-chain action.
4. **Size**: use user's amount if given, otherwise $10,000.
5. **Leverage**: conservative 1-3x, moderate 3-6x, aggressive 6-15x. Adapt to context.
6. **summary**: 2-3 sentences with EXACT rates from live data. Why this approach, what's the expected outcome.
7. **variantNote**: name the specific risk (liquidation price, funding rate direction, smart contract risk, rate variability, etc.).
8. **Descriptive names** that differentiate strategies.

## Leg Format (STRICT)

side: exactly one of: "Supply", "Borrow", "Repay", "Withdraw", "Long", "Short", "Swap", "Stake", "Bridge", "Transfer", "Restake", "Buy"
asset: token symbol. Perps: "ETH PERP". Swaps: "USDC → ETH". Staking: output token "stETH".
protocol: exactly one of: "Aave", "Compound", "Lido", "Hyperliquid", "Extended", "Ondo", "Lighter", "Uniswap", "Morpho", "Pendle", "EigenLayer", "Wallet"
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

export async function POST(req: NextRequest) {
  try {
    const { thesis } = await req.json();
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

    // Build the user message with live yield data injected
    const userMessage = yieldContext
      ? `${yieldContext}\n\n---\n\nUser thesis: ${thesis.trim()}`
      : thesis.trim();

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

    return NextResponse.json(parsed);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[parse-intent] error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
