/**
 * mcp/index.ts — Unified DeFi MCP integration layer.
 *
 * Meridian connects to protocol MCP servers as a DeFi aggregation layer:
 * - Aave MCP (mcp.aave.com): lending positions, rates, tx building
 * - Hyperliquid: funding rates, perp markets, order execution
 *
 * This module provides the combined yield/market context for the strategy
 * engine and the execution layer. All data is read-only or unsigned-tx;
 * signing happens exclusively client-side via wagmi.
 */

export { getMcpClient, callMcpTool, listMcpTools } from "./client";

export {
  fetchAaveReserves,
  fetchAavePositions,
  previewAaveAction,
  buildAaveTransaction,
  fetchAaveYieldSummary,
  type AaveReserve,
  type AavePosition,
  type AaveActionPreview,
  type AaveTxData,
} from "./aave";

export {
  fetchFundingRates,
  getTopFundingOpportunities,
  formatFundingRatesForLLM,
  type HlFundingRate,
} from "./hyperliquid";

/**
 * Build the full DeFi market context for the LLM strategy engine.
 * Aggregates live data from all connected MCP servers + protocol APIs.
 */
export async function buildMcpMarketContext(): Promise<string> {
  const { fetchAaveYieldSummary } = await import("./aave");
  const { formatFundingRatesForLLM } = await import("./hyperliquid");

  const [aaveContext, fundingContext] = await Promise.all([
    fetchAaveYieldSummary([1, 8453, 42161, 10, 137, 43114, 56, 100, 534352, 324, 59144, 5000, 1088, 250, 146, 42220]).catch(() => ""),
    formatFundingRatesForLLM().catch(() => ""),
  ]);

  const sections: string[] = [];
  if (aaveContext) sections.push(aaveContext);
  if (fundingContext) sections.push(fundingContext);

  if (sections.length === 0) return "";
  return `## Live Protocol Data (from MCP servers)\n${sections.join("\n")}`;
}
