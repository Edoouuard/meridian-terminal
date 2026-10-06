/**
 * mcp/aave.ts — Aave MCP integration.
 *
 * Connects to Aave's official MCP server (mcp.aave.com) for:
 * - Multi-chain market data (APY, caps, risk parameters)
 * - User positions (supply, borrow, health factor)
 * - Transaction building (prepare_action — unsigned)
 * - Health factor simulation (preview_action)
 *
 * Endpoint: https://mcp.aave.com (Streamable HTTP, no /sse suffix).
 *
 * Key tools: get_markets, get_user_positions, get_user_summary,
 *            preview_action, prepare_action, get_reserve_details,
 *            get_wallet_balances, get_chains
 *
 * The MCP server is NON-CUSTODIAL — it builds transactions but never signs.
 * All tx data returned here must be signed client-side via wagmi.
 */

import { callMcpTool } from "./client";

const AAVE_MCP_URL = process.env.AAVE_MCP_URL || "https://mcp.aave.com";
const SERVER_NAME = "aave";

// ─── Types ───────────────────────────────────────────────────────────

export interface AaveReserve {
  symbol: string;
  underlyingAsset: string;
  supplyAPY: number;
  borrowAPY: number;
  totalSupply: number;
  totalBorrow: number;
  availableLiquidity: number;
  ltv: number;
  liquidationThreshold: number;
}

export interface AavePosition {
  chainId: number;
  chain: string;
  totalCollateralUsd: number;
  totalDebtUsd: number;
  availableBorrowsUsd: number;
  healthFactor: number | null;
  supplies: { symbol: string; balanceUsd: number; apy: number }[];
  borrows: { symbol: string; balanceUsd: number; apy: number }[];
}

export interface AaveActionPreview {
  healthFactorBefore: number | null;
  healthFactorAfter: number | null;
  willLiquidate: boolean;
}

export interface AaveTxData {
  to: string;
  data: string;
  value?: string;
  chainId: number;
}

// ─── Read operations ─────────────────────────────────────────────────

/**
 * Fetch all Aave markets with live rates for a given chain.
 * Uses the new `get_markets` tool (replaces `get_reserves`).
 */
export async function fetchAaveReserves(chainId: number): Promise<AaveReserve[]> {
  try {
    const result = await callMcpTool(AAVE_MCP_URL, SERVER_NAME, "get_markets", {
      chainId,
    });
    // get_markets returns a different shape — normalize to AaveReserve[]
    const parsed = parseToolResult<{
      reserves?: AaveReserve[];
      markets?: AaveReserve[];
    } | AaveReserve[]>(result);

    if (!parsed) return [];
    if (Array.isArray(parsed)) return parsed;
    return parsed.reserves ?? parsed.markets ?? [];
  } catch (err) {
    console.warn("[mcp/aave] fetchAaveReserves failed:", err);
    return [];
  }
}

/**
 * Fetch a user's Aave positions across all chains (or a specific chain).
 * Uses `get_user_positions` tool.
 */
export async function fetchAavePositions(
  userAddress: string,
  chainId?: number,
): Promise<AavePosition[]> {
  try {
    const args: Record<string, unknown> = { user: userAddress };
    if (chainId) args.chainId = chainId;
    const result = await callMcpTool(AAVE_MCP_URL, SERVER_NAME, "get_user_positions", args);
    return parseToolResult<AavePosition[]>(result) ?? [];
  } catch (err) {
    console.warn("[mcp/aave] fetchAavePositions failed:", err);
    return [];
  }
}

/**
 * Preview how an action would affect the user's health factor.
 * Uses `preview_action` tool.
 */
export async function previewAaveAction(
  userAddress: string,
  chainId: number,
  action: "supply" | "borrow" | "withdraw" | "repay",
  asset: string,
  amount: string,
): Promise<AaveActionPreview | null> {
  try {
    const result = await callMcpTool(AAVE_MCP_URL, SERVER_NAME, "preview_action", {
      sender: userAddress,
      chainId,
      action,
      token: asset,
      amount,
    });
    return parseToolResult<AaveActionPreview>(result);
  } catch (err) {
    console.warn("[mcp/aave] previewAaveAction failed:", err);
    return null;
  }
}

// ─── Write operations (unsigned tx building) ─────────────────────────

/**
 * Build an unsigned Aave transaction via the MCP server.
 * Uses the unified `prepare_action` tool (replaces prepare_supply/borrow/etc).
 */
export async function buildAaveTransaction(
  userAddress: string,
  chainId: number,
  action: "supply" | "borrow" | "withdraw" | "repay",
  asset: string,
  amount: string,
): Promise<AaveTxData | null> {
  try {
    const result = await callMcpTool(AAVE_MCP_URL, SERVER_NAME, "prepare_action", {
      sender: userAddress,
      chainId,
      action,
      token: asset,
      amount,
    });
    return parseToolResult<AaveTxData>(result);
  } catch (err) {
    console.warn(`[mcp/aave] buildAaveTransaction(${action}) failed:`, err);
    return null;
  }
}

/**
 * Fetch live APY rates for yield context (used by the strategy engine).
 * Returns a formatted summary string for the LLM.
 */
export async function fetchAaveYieldSummary(chainIds: number[]): Promise<string> {
  const lines: string[] = [];

  for (const chainId of chainIds) {
    const reserves = await fetchAaveReserves(chainId);
    if (reserves.length === 0) continue;

    // Sort by supply APY descending, take top 10
    const top = reserves
      .filter((r) => r.supplyAPY > 0)
      .sort((a, b) => b.supplyAPY - a.supplyAPY)
      .slice(0, 10);

    if (top.length === 0) continue;

    const chainName = CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;
    lines.push(`\n### Aave v3 on ${chainName} (live from Aave MCP)`);
    for (const r of top) {
      lines.push(
        `- ${r.symbol}: Supply ${(r.supplyAPY * 100).toFixed(2)}% APY | Borrow ${(r.borrowAPY * 100).toFixed(2)}% APY | LTV ${(r.ltv * 100).toFixed(0)}%`,
      );
    }
  }

  return lines.join("\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum", 10: "Optimism", 137: "Polygon", 42161: "Arbitrum",
  43114: "Avalanche", 8453: "Base", 100: "Gnosis", 534352: "Scroll",
  56: "BNB Chain", 324: "zkSync Era", 59144: "Linea", 5000: "Mantle",
  1088: "Metis", 250: "Fantom", 146: "Sonic", 42220: "Celo",
};

function parseToolResult<T>(content: unknown): T | null {
  if (!content) return null;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && "type" in block) {
        if (block.type === "text" && "text" in block) {
          try { return JSON.parse(block.text as string) as T; } catch { return null; }
        }
      }
    }
    return null;
  }
  if (typeof content === "string") {
    try { return JSON.parse(content) as T; } catch { return null; }
  }
  return content as T;
}
