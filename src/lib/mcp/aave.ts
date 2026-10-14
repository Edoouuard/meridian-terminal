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
 *            preview_action, prepare_action, get_reserve_details, get_chains
 *
 * Contract (from the published @aave/mcp source): results are wrapped as
 * `{ data: { v3, v4 }, next_actions }`; rates are percent strings with a
 * `Pct` suffix; write/preview tools take `version` + (v3) `market` pool +
 * `token` address + `chainId`, never a symbol; amounts are in main units.
 *
 * The MCP server is NON-CUSTODIAL — it builds transactions but never signs.
 * All tx data returned here must be signed client-side via wagmi.
 */

import { callMcpTool, listMcpTools, parseMcpToolResult } from "./client";
import type { McpProviderStatus } from "./types";

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

// ─── Health check ────────────────────────────────────────────────────

let lastHealthCheck: McpProviderStatus = { id: "aave", name: "Aave", healthy: false, latencyMs: null, lastChecked: 0 };

/** Healthy = MCP handshake + tools/list succeed and `get_markets` is advertised. */
export async function checkAaveHealth(): Promise<McpProviderStatus> {
  const start = Date.now();
  let healthy = false;
  try {
    const { tools } = await listMcpTools(AAVE_MCP_URL, SERVER_NAME, { timeoutMs: 8000 });
    healthy = tools.some((t) => t.name === "get_markets");
    if (!healthy) console.warn("[mcp/aave] MCP is up but does not expose get_markets");
  } catch (err) {
    console.warn("[mcp/aave] health check failed:", err);
  }
  lastHealthCheck = { id: "aave", name: "Aave", healthy, latencyMs: Date.now() - start, lastChecked: Date.now() };
  return lastHealthCheck;
}

/** Cached Aave health (no network call). */
export function getAaveStatus(): McpProviderStatus {
  return lastHealthCheck;
}

// ─── Response helpers ────────────────────────────────────────────────

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const toNum = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};

/**
 * Aave MCP wraps every result as `{ data, next_actions }`, and multi-version
 * reads as `{ data: { v3: {...}, v4: {...} } }`. Return the v3 payload.
 * Pure — exported for tests.
 */
export function aaveV3Payload(result: unknown): Rec | null {
  const parsed = parseMcpToolResult<unknown>(result);
  if (!isRec(parsed)) return null;
  const data = isRec(parsed.data) ? parsed.data : parsed;
  if (isRec(data.v3)) return "error" in data.v3 ? null : data.v3;
  return data;
}

interface V3MarketRow {
  market: string;
  chainId: number;
  reserves: Rec[];
}

/** Normalize get_markets (v3) into reserves. APYs arrive as percent strings ('3.32') → fraction. Pure. */
export function normalizeAaveMarkets(result: unknown, chainId?: number): (AaveReserve & { market: string; chainId: number })[] {
  const v3 = aaveV3Payload(result);
  const markets = Array.isArray(v3?.markets) ? (v3!.markets as V3MarketRow[]) : [];
  const out: (AaveReserve & { market: string; chainId: number })[] = [];
  for (const m of markets) {
    if (!isRec(m) || (chainId !== undefined && m.chainId !== chainId)) continue;
    for (const r of Array.isArray(m.reserves) ? m.reserves : []) {
      if (!isRec(r)) continue;
      out.push({
        market: String(m.market ?? ""),
        chainId: toNum(m.chainId),
        symbol: String(r.symbol ?? "?"),
        underlyingAsset: String(r.underlyingToken ?? ""),
        supplyAPY: toNum(r.supplyApyPct) / 100,
        borrowAPY: toNum(r.borrowApyPct) / 100,
        totalSupply: toNum(r.totalSuppliedUsd),
        totalBorrow: 0,
        availableLiquidity: isRec(r.availableLiquidity) ? toNum(r.availableLiquidity.value) : 0,
        ltv: 0, // not part of get_markets; use get_reserve_details if ever needed
        liquidationThreshold: 0,
      });
    }
  }
  return out;
}

/** Normalize get_user_positions (v3: flat supplies/borrows) into per-chain positions. Pure. */
export function normalizeAavePositions(result: unknown): AavePosition[] {
  const v3 = aaveV3Payload(result);
  if (!v3) return [];
  const byChain = new Map<number, AavePosition>();
  const get = (chainId: number) => {
    let p = byChain.get(chainId);
    if (!p) {
      p = {
        chainId,
        chain: CHAIN_NAMES[chainId] ?? `Chain ${chainId}`,
        totalCollateralUsd: 0,
        totalDebtUsd: 0,
        availableBorrowsUsd: 0,
        healthFactor: null,
        supplies: [],
        borrows: [],
      };
      byChain.set(chainId, p);
    }
    return p;
  };
  for (const s of Array.isArray(v3.supplies) ? v3.supplies : []) {
    if (!isRec(s)) continue;
    const p = get(toNum(s.chainId));
    const usd = toNum(s.balanceUsd);
    p.supplies.push({ symbol: String(s.symbol ?? "?"), balanceUsd: usd, apy: toNum(s.apyPct) / 100 });
    if (s.isCollateral === true) p.totalCollateralUsd += usd;
  }
  for (const b of Array.isArray(v3.borrows) ? v3.borrows : []) {
    if (!isRec(b)) continue;
    const p = get(toNum(b.chainId));
    const usd = toNum(b.debtUsd);
    p.borrows.push({ symbol: String(b.symbol ?? "?"), balanceUsd: usd, apy: toNum(b.apyPct) / 100 });
    p.totalDebtUsd += usd;
  }
  return [...byChain.values()];
}

// ─── Read operations ─────────────────────────────────────────────────

/**
 * Fetch all Aave v3 reserves with live rates for a given chain (`get_markets`).
 */
export async function fetchAaveReserves(chainId: number, symbols?: string[]): Promise<AaveReserve[]> {
  try {
    const result = await callMcpTool(AAVE_MCP_URL, SERVER_NAME, "get_markets", {
      version: "v3",
      chainId,
      ...(symbols?.length ? { symbols } : {}),
    });
    return normalizeAaveMarkets(result, chainId);
  } catch (err) {
    console.warn("[mcp/aave] fetchAaveReserves failed:", err);
    return [];
  }
}

/**
 * Fetch a user's Aave v3 positions across all chains (or a specific chain).
 * Uses `get_user_positions`.
 */
export async function fetchAavePositions(
  userAddress: string,
  chainId?: number,
): Promise<AavePosition[]> {
  try {
    const args: Record<string, unknown> = { user: userAddress, version: "v3" };
    if (chainId) args.chainId = chainId;
    const result = await callMcpTool(AAVE_MCP_URL, SERVER_NAME, "get_user_positions", args, 20_000);
    return normalizeAavePositions(result);
  } catch (err) {
    console.warn("[mcp/aave] fetchAavePositions failed:", err);
    return [];
  }
}

/**
 * Resolve a v3 reserve selector (market pool + underlying token) from a
 * symbol or token address — Aave's write/preview tools need both and refuse
 * symbols.
 */
async function resolveV3Reserve(chainId: number, asset: string): Promise<{ market: string; token: string } | null> {
  const isAddress = /^0x[0-9a-fA-F]{40}$/.test(asset);
  const reserves = await fetchAaveReserves(chainId, isAddress ? undefined : [asset]);
  const match = reserves.find((r) =>
    isAddress
      ? r.underlyingAsset.toLowerCase() === asset.toLowerCase()
      : r.symbol.toUpperCase() === asset.toUpperCase(),
  ) as (AaveReserve & { market: string }) | undefined;
  return match?.market && match.underlyingAsset ? { market: match.market, token: match.underlyingAsset } : null;
}

/**
 * Preview how an action would affect the user's health factor (`preview_action`, v3).
 * `amount` is in main units (e.g. "10.5"), as Aave's tool requires.
 */
export async function previewAaveAction(
  userAddress: string,
  chainId: number,
  action: "supply" | "borrow" | "withdraw" | "repay",
  asset: string,
  amount: string,
): Promise<AaveActionPreview | null> {
  try {
    const reserve = await resolveV3Reserve(chainId, asset);
    if (!reserve) {
      console.warn(`[mcp/aave] previewAaveAction: no v3 reserve for ${asset} on chain ${chainId}`);
      return null;
    }
    const result = await callMcpTool(AAVE_MCP_URL, SERVER_NAME, "preview_action", {
      version: "v3",
      action,
      sender: userAddress,
      amount,
      market: reserve.market,
      token: reserve.token,
      chainId,
    });
    const v3 = aaveV3Payload(result);
    if (!v3) return null;
    const hf = (v: unknown): number | null => {
      const raw = isRec(v) ? v.value ?? v.formatted : v;
      const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
      return Number.isFinite(n) ? n : null;
    };
    const before = hf(v3.healthFactorBefore);
    const after = hf(v3.healthFactorAfter);
    return { healthFactorBefore: before, healthFactorAfter: after, willLiquidate: after !== null && after < 1 };
  } catch (err) {
    console.warn("[mcp/aave] previewAaveAction failed:", err);
    return null;
  }
}

// ─── Write operations (unsigned tx building) ─────────────────────────

/**
 * Fetch live APY rates for yield context (used by the strategy engine).
 * Returns a formatted summary string for the LLM. Chains are queried in
 * parallel (sequential calls blew through serverless time limits).
 */
export async function fetchAaveYieldSummary(chainIds: number[]): Promise<string> {
  return aaveYieldSummary(await fetchAaveReservesByChain(chainIds));
}

/** Live reserves for several chains at once (a chain whose call fails comes back empty). */
export async function fetchAaveReservesByChain(chainIds: number[]): Promise<{ chainId: number; reserves: AaveReserve[] }[]> {
  return Promise.all(chainIds.map(async (chainId) => ({ chainId, reserves: await fetchAaveReserves(chainId) })));
}

/** The planner's Aave section from already-fetched reserves. */
export function aaveYieldSummary(perChain: { chainId: number; reserves: AaveReserve[] }[]): string {
  const lines: string[] = [];

  for (const { chainId, reserves } of perChain) {
    const top = reserves
      .filter((r) => r.supplyAPY > 0)
      .sort((a, b) => b.supplyAPY - a.supplyAPY)
      .slice(0, 10);
    if (top.length === 0) continue;

    const chainName = CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;
    lines.push(`\n### Aave v3 on ${chainName} (live from Aave MCP)`);
    for (const r of top) {
      const size = r.totalSupply > 0 ? ` | Supplied $${(r.totalSupply / 1e6).toFixed(1)}M` : "";
      lines.push(
        `- ${r.symbol}: Supply ${(r.supplyAPY * 100).toFixed(2)}% APY | Borrow ${(r.borrowAPY * 100).toFixed(2)}% APY${size}`,
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
