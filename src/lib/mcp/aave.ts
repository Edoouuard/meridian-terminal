/**
 * mcp/aave.ts — Aave MCP integration.
 *
 * Connects to Aave's official MCP server (mcp.aave.com) for:
 * - Multi-chain position reads (supply, borrow, health factor, rewards)
 * - Live reserve data (APY, caps, risk parameters)
 * - Transaction building (supply, borrow, repay, withdraw — unsigned)
 * - Health factor simulation (preview_action)
 *
 * The MCP server is NON-CUSTODIAL — it builds transactions but never signs.
 * All tx data returned here must be signed client-side via wagmi.
 *
 * Fallback: if the MCP server is unreachable, functions return null/empty
 * so the app falls back to its existing hardcoded ABI paths.
 */

import { callMcpTool } from "./client";

const AAVE_MCP_URL = process.env.AAVE_MCP_URL || "https://mcp.aave.com/sse";
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
 * Fetch all Aave reserves (markets) with live rates for a given chain.
 * Returns empty array on MCP failure (app falls back to DefiLlama data).
 */
export async function fetchAaveReserves(chainId: number): Promise<AaveReserve[]> {
  try {
    const result = await callMcpTool(AAVE_MCP_URL, SERVER_NAME, "get_reserves", {
      chainId,
    });
    return parseToolResult<AaveReserve[]>(result) ?? [];
  } catch (err) {
    console.warn("[mcp/aave] fetchAaveReserves failed:", err);
    return [];
  }
}

/**
 * Fetch a user's Aave positions across all chains (or a specific chain).
 * Returns empty array on MCP failure.
 */
export async function fetchAavePositions(
  userAddress: string,
  chainId?: number,
): Promise<AavePosition[]> {
  try {
    const args: Record<string, unknown> = { userAddress };
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
 * Returns null on MCP failure.
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
      userAddress,
      chainId,
      action,
      asset,
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
 * Returns null on failure — the app falls back to its local ABI builder.
 */
export async function buildAaveTransaction(
  userAddress: string,
  chainId: number,
  action: "supply" | "borrow" | "withdraw" | "repay",
  asset: string,
  amount: string,
): Promise<AaveTxData | null> {
  try {
    const toolName = `prepare_${action}`;
    const result = await callMcpTool(AAVE_MCP_URL, SERVER_NAME, toolName, {
      userAddress,
      chainId,
      asset,
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
  1: "Ethereum",
  10: "Optimism",
  137: "Polygon",
  42161: "Arbitrum",
  43114: "Avalanche",
  8453: "Base",
  100: "Gnosis",
  534352: "Scroll",
  56: "BNB Chain",
  324: "zkSync Era",
  59144: "Linea",
  5000: "Mantle",
  1088: "Metis",
  250: "Fantom",
  146: "Sonic",
  42220: "Celo",
};

/** Parse MCP tool result content into typed data. */
function parseToolResult<T>(content: unknown): T | null {
  if (!content) return null;
  // MCP returns content as an array of content blocks
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && "type" in block) {
        if (block.type === "text" && "text" in block) {
          try {
            return JSON.parse(block.text as string) as T;
          } catch {
            return null;
          }
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
