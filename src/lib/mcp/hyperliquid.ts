/**
 * mcp/hyperliquid.ts — Hyperliquid MCP integration.
 *
 * Provides access to Hyperliquid's exchange data via their MCP server:
 * - Live funding rates (critical for delta-neutral strategy selection)
 * - Market data (prices, open interest, volume)
 * - Account positions and balances
 * - Order placement (unsigned — signed client-side)
 *
 * Falls back gracefully to the existing hyperliquid-live.ts on failure.
 */

import { callMcpTool } from "./client";

// Hyperliquid doesn't have a hosted MCP server — using REST API only.
// MCP fallback kept as optional env override if a community server appears.
const HL_MCP_URL = process.env.HYPERLIQUID_MCP_URL || "";
const SERVER_NAME = "hyperliquid";

// Use the public REST API as primary (more reliable than MCP SSE for serverless)
const HL_INFO_API = "https://api.hyperliquid.xyz/info";

// ─── Types ───────────────────────────────────────────────────────────

export interface HlFundingRate {
  coin: string;
  /** Current hourly funding rate (positive = longs pay shorts). */
  fundingRate: number;
  /** Annualized funding rate (hourly * 8760). */
  annualizedRate: number;
  /** Open interest in USD. */
  openInterest: number;
  /** 24h volume in USD. */
  volume24h: number;
  /** Mark price. */
  markPrice: number;
}

export interface HlMarketMeta {
  coin: string;
  maxLeverage: number;
  szDecimals: number;
}

// ─── Public API (REST-based, no MCP needed) ──────────────────────────

/**
 * Fetch all funding rates from Hyperliquid's public API.
 * This is the primary data source — reliable, fast, no auth needed.
 */
export async function fetchFundingRates(): Promise<HlFundingRate[]> {
  try {
    const [metaRes, ctxRes] = await Promise.all([
      fetch(HL_INFO_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "meta" }),
        signal: AbortSignal.timeout(8000),
      }),
      fetch(HL_INFO_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "metaAndAssetCtxs" }),
        signal: AbortSignal.timeout(8000),
      }),
    ]);

    if (!metaRes.ok || !ctxRes.ok) return [];

    const metaData = await metaRes.json();
    const ctxData = await ctxRes.json();

    const universe: { name: string; maxLeverage: number; szDecimals: number }[] =
      metaData?.universe ?? ctxData?.[0]?.universe ?? [];
    const assetCtxs: {
      funding: string;
      openInterest: string;
      dayNtlVlm: string;
      markPx: string;
    }[] = ctxData?.[1] ?? [];

    const rates: HlFundingRate[] = [];
    for (let i = 0; i < universe.length && i < assetCtxs.length; i++) {
      const coin = universe[i].name;
      const ctx = assetCtxs[i];
      const fundingRate = parseFloat(ctx.funding) || 0;
      const openInterest = parseFloat(ctx.openInterest) || 0;
      const volume24h = parseFloat(ctx.dayNtlVlm) || 0;
      const markPrice = parseFloat(ctx.markPx) || 0;

      rates.push({
        coin,
        fundingRate,
        annualizedRate: fundingRate * 8760, // hourly to annual
        openInterest: openInterest * markPrice,
        volume24h,
        markPrice,
      });
    }

    return rates.sort((a, b) => Math.abs(b.annualizedRate) - Math.abs(a.annualizedRate));
  } catch (err) {
    console.warn("[mcp/hyperliquid] fetchFundingRates failed:", err);
    return [];
  }
}

/**
 * Fetch funding rates via MCP server (fallback if REST fails or for
 * MCP-specific features like account data that needs auth).
 */
export async function fetchFundingRatesMcp(): Promise<HlFundingRate[]> {
  if (!HL_MCP_URL) return [];
  try {
    const result = await callMcpTool(HL_MCP_URL, SERVER_NAME, "get_funding_rates", {});
    if (!result) return [];
    if (Array.isArray(result)) {
      for (const block of result) {
        if (block && typeof block === "object" && "type" in block && block.type === "text") {
          const parsed = JSON.parse((block as { text: string }).text);
          return Array.isArray(parsed) ? parsed : [];
        }
      }
    }
    return [];
  } catch (err) {
    console.warn("[mcp/hyperliquid] MCP fetchFundingRates failed:", err);
    return [];
  }
}

/**
 * Get the top funding rate opportunities for the strategy engine.
 * Filters for rates > 5% annualized and sufficient liquidity.
 */
export async function getTopFundingOpportunities(limit = 15): Promise<HlFundingRate[]> {
  const rates = await fetchFundingRates();
  return rates
    .filter((r) => Math.abs(r.annualizedRate) > 0.05 && r.openInterest > 100_000)
    .slice(0, limit);
}

/**
 * Format funding rate data as a string for the LLM strategy engine.
 */
export async function formatFundingRatesForLLM(): Promise<string> {
  const rates = await getTopFundingOpportunities(20);
  if (rates.length === 0) return "";

  const lines = ["\n### Hyperliquid Funding Rates (live)"];
  lines.push("Positive = longs pay shorts (short earns). Negative = shorts pay longs (long earns).");

  for (const r of rates) {
    const dir = r.annualizedRate > 0 ? "+" : "";
    const emoji = r.annualizedRate > 0 ? "shorts earn" : "longs earn";
    lines.push(
      `- ${r.coin}: ${dir}${(r.annualizedRate * 100).toFixed(1)}% annualized (${emoji}) | OI $${formatCompact(r.openInterest)} | Price $${r.markPrice.toFixed(2)}`,
    );
  }

  return lines.join("\n");
}

function formatCompact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}
