/**
 * mcp/aave.ts — Aave MCP integration.
 *
 * Connects to Aave's official MCP server (mcp.aave.com) for:
 * - Multi-chain market data (APY, liquidity, frozen/cap flags)
 * - User positions (supply, borrow, health factor)
 * - Transaction building (prepare_action — unsigned)
 * - Health factor simulation (preview_action)
 *
 * Endpoint: https://mcp.aave.com (Streamable HTTP, no /sse suffix).
 *
 * Every tool answers `{ data: { v3: {...}, v4: {...} }, next_actions: [...] }`.
 * Meridian executes against Aave v3 pools only (see lib/onchain.ts), so this
 * module reads the v3 side. v3 actions are addressed by market + token + chainId.
 *
 * The MCP server is NON-CUSTODIAL — it builds transactions but never signs.
 * All tx data returned here must be signed client-side via wagmi.
 */

import { callMcpTool, parseMcpToolResult } from "./client";
import { AAVE_V3_POOL_BY_CHAIN } from "@/lib/onchain";

const AAVE_MCP_URL = process.env.AAVE_MCP_URL || "https://mcp.aave.com";
const SERVER_NAME = "aave";

// ─── Types ───────────────────────────────────────────────────────────

export interface AaveReserve {
  symbol: string;
  underlyingAsset: string;
  chainId: number;
  /** Pool address of the v3 market this reserve belongs to. */
  market: string;
  marketName: string;
  /** Supply APY in percent (4.23 = 4.23%). */
  supplyApyPct: number;
  /** Borrow APY in percent, null when the reserve can't be borrowed. */
  borrowApyPct: number | null;
  totalSuppliedUsd: number;
  availableLiquidityUsd: number | null;
  canSupply: boolean;
  canBorrow: boolean;
  isFrozen: boolean;
  isPaused: boolean;
  supplyCapReached: boolean;
  borrowCapReached: boolean;
}

export interface AavePositionItem {
  symbol: string;
  token: string;
  balance: string;
  balanceUsd: number;
  /** APY in percent. */
  apy: number;
  isCollateral?: boolean;
}

export interface AavePosition {
  chainId: number;
  chain: string;
  market: string;
  marketName: string;
  totalCollateralUsd: number;
  totalSuppliedUsd: number;
  totalDebtUsd: number;
  healthFactor: number | null;
  supplies: AavePositionItem[];
  borrows: AavePositionItem[];
}

export interface AaveActionPreview {
  healthFactorBefore: number | null;
  healthFactorAfter: number | null;
  willLiquidate: boolean;
}

export interface AaveTxData {
  to: string;
  data: string;
  value: string;
  chainId: number;
}

/** prepare_action result: the action tx, preceded by an ERC-20 approval when the allowance is short. */
export interface AaveTxPlan {
  approval: AaveTxData | null;
  tx: AaveTxData;
}

export type AaveAction = "supply" | "borrow" | "withdraw" | "repay";

// ─── Raw response shapes (mcp.aave.com) ──────────────────────────────

interface RawV3Reserve {
  symbol: string;
  underlyingToken: string;
  supplyApyPct?: string;
  borrowApyPct?: string;
  totalSuppliedUsd?: string;
  availableLiquidity?: { value: string; usd: string };
  canSupply?: boolean;
  canBorrow?: boolean;
  isFrozen?: boolean;
  isPaused?: boolean;
  supplyCapReached?: boolean;
  borrowCapReached?: boolean;
}

interface RawV3Market {
  market: string;
  chainId: number;
  name: string;
  reserves: RawV3Reserve[];
}

interface RawMarketsResponse {
  data?: { v3?: { chainsCovered?: number[]; markets?: RawV3Market[] } };
}

interface RawV3Supply {
  market: string;
  marketName: string;
  chainId: number;
  symbol: string;
  token: string;
  balance: string;
  balanceUsd: string;
  apyPct: string;
  isCollateral?: boolean;
}

interface RawV3Borrow {
  market: string;
  marketName: string;
  chainId: number;
  symbol: string;
  token: string;
  debt: string;
  debtUsd: string;
  apyPct: string;
}

interface RawPositionsResponse {
  data?: { v3?: { supplies?: RawV3Supply[]; borrows?: RawV3Borrow[] } };
}

interface RawSummaryResponse {
  data?: { v3?: { markets?: { market: string; chainId: number; healthFactor: string | null }[] } };
}

interface RawTxRequest {
  to: string;
  data: string;
  value?: string;
  chainId: number;
}

interface RawPrepareResponse {
  data?: RawTxRequest & {
    __typename?: string;
    approval?: RawTxRequest;
    originalTransaction?: RawTxRequest;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum", 10: "Optimism", 137: "Polygon", 42161: "Arbitrum",
  43114: "Avalanche", 8453: "Base", 100: "Gnosis", 534352: "Scroll",
  56: "BNB Chain", 324: "zkSync Era", 59144: "Linea", 5000: "Mantle",
  1088: "Metis", 250: "Fantom", 146: "Sonic", 42220: "Celo",
};

function num(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeReserve(m: RawV3Market, r: RawV3Reserve): AaveReserve {
  return {
    symbol: r.symbol,
    underlyingAsset: r.underlyingToken,
    chainId: m.chainId,
    market: m.market,
    marketName: m.name,
    supplyApyPct: num(r.supplyApyPct),
    borrowApyPct: numOrNull(r.borrowApyPct),
    totalSuppliedUsd: num(r.totalSuppliedUsd),
    availableLiquidityUsd: r.availableLiquidity ? num(r.availableLiquidity.usd) : null,
    canSupply: r.canSupply ?? false,
    canBorrow: r.canBorrow ?? false,
    isFrozen: r.isFrozen ?? false,
    isPaused: r.isPaused ?? false,
    supplyCapReached: r.supplyCapReached ?? false,
    borrowCapReached: r.borrowCapReached ?? false,
  };
}

/** True when the reserve sits in the pool Meridian executes Aave orders against on its chain. */
export function isAaveReserveExecutable(r: AaveReserve): boolean {
  const pool = AAVE_V3_POOL_BY_CHAIN[r.chainId];
  return !!pool && pool.toLowerCase() === r.market.toLowerCase();
}

/** True when a new deposit can actually enter this reserve right now. */
export function isAaveReserveSuppliable(r: AaveReserve): boolean {
  return r.canSupply && !r.isFrozen && !r.isPaused && !r.supplyCapReached;
}

function normalizeTx(raw: RawTxRequest | undefined): AaveTxData | null {
  if (!raw?.to || !raw.data) return null;
  return { to: raw.to, data: raw.data, value: raw.value ?? "0", chainId: raw.chainId };
}

// ─── Read operations ─────────────────────────────────────────────────

/**
 * Fetch every Aave v3 reserve (across all v3 markets) on one chain, with live rates.
 * Returns [] when the chain has no v3 market or the server is unreachable.
 */
export async function fetchAaveReserves(chainId: number): Promise<AaveReserve[]> {
  try {
    const result = await callMcpTool(AAVE_MCP_URL, SERVER_NAME, "get_markets", { chainId });
    const parsed = parseMcpToolResult<RawMarketsResponse>(result);
    const markets = parsed?.data?.v3?.markets ?? [];
    return markets
      .filter((m) => m.chainId === chainId)
      .flatMap((m) => (m.reserves ?? []).map((r) => normalizeReserve(m, r)));
  } catch (err) {
    console.warn(`[mcp/aave] fetchAaveReserves(${chainId}) failed:`, err);
    return [];
  }
}

/**
 * Resolve the v3 market + reserve for a token (address or symbol) on a chain.
 * When the token is listed in several markets (e.g. Core + Lido on Ethereum),
 * the pool Meridian executes against wins, then the deepest market.
 */
export async function resolveAaveReserve(chainId: number, token: string): Promise<AaveReserve | null> {
  const reserves = await fetchAaveReserves(chainId);
  const needle = token.trim().toLowerCase();
  const isAddress = /^0x[0-9a-f]{40}$/.test(needle);
  const matches = reserves.filter((r) =>
    isAddress ? r.underlyingAsset.toLowerCase() === needle : r.symbol.toLowerCase() === needle,
  );
  if (matches.length === 0) return null;
  return matches.sort((a, b) =>
    Number(isAaveReserveExecutable(b)) - Number(isAaveReserveExecutable(a)) || b.totalSuppliedUsd - a.totalSuppliedUsd,
  )[0];
}

/**
 * Fetch a user's Aave v3 positions on every chain the API serves (or one chain),
 * grouped per market, with each market's health factor.
 */
export async function fetchAavePositions(
  userAddress: string,
  chainId?: number,
): Promise<AavePosition[]> {
  try {
    const args: Record<string, unknown> = { user: userAddress };
    if (chainId) args.chainId = chainId;
    const [positionsResult, summaryResult] = await Promise.all([
      callMcpTool(AAVE_MCP_URL, SERVER_NAME, "get_user_positions", args),
      callMcpTool(AAVE_MCP_URL, SERVER_NAME, "get_user_summary", args).catch((err) => {
        console.warn("[mcp/aave] get_user_summary failed:", err);
        return null;
      }),
    ]);
    const positions = parseMcpToolResult<RawPositionsResponse>(positionsResult)?.data?.v3;
    const summary = summaryResult ? parseMcpToolResult<RawSummaryResponse>(summaryResult)?.data?.v3 : undefined;

    const byMarket = new Map<string, AavePosition>();
    const keyOf = (chain: number, market: string) => `${chain}:${market.toLowerCase()}`;
    const entry = (chain: number, market: string, marketName: string): AavePosition => {
      const key = keyOf(chain, market);
      let p = byMarket.get(key);
      if (!p) {
        p = {
          chainId: chain,
          chain: CHAIN_NAMES[chain] ?? `Chain ${chain}`,
          market,
          marketName,
          totalCollateralUsd: 0,
          totalSuppliedUsd: 0,
          totalDebtUsd: 0,
          healthFactor: null,
          supplies: [],
          borrows: [],
        };
        byMarket.set(key, p);
      }
      return p;
    };

    for (const s of positions?.supplies ?? []) {
      const p = entry(s.chainId, s.market, s.marketName);
      const usd = num(s.balanceUsd);
      p.supplies.push({ symbol: s.symbol, token: s.token, balance: s.balance, balanceUsd: usd, apy: num(s.apyPct), isCollateral: s.isCollateral });
      p.totalSuppliedUsd += usd;
      if (s.isCollateral) p.totalCollateralUsd += usd;
    }
    for (const b of positions?.borrows ?? []) {
      const p = entry(b.chainId, b.market, b.marketName);
      const usd = num(b.debtUsd);
      p.borrows.push({ symbol: b.symbol, token: b.token, balance: b.debt, balanceUsd: usd, apy: num(b.apyPct) });
      p.totalDebtUsd += usd;
    }
    for (const m of summary?.markets ?? []) {
      const p = byMarket.get(keyOf(m.chainId, m.market));
      if (p) p.healthFactor = numOrNull(m.healthFactor);
    }

    return [...byMarket.values()];
  } catch (err) {
    console.warn("[mcp/aave] fetchAavePositions failed:", err);
    return [];
  }
}

/**
 * Preview how an action would affect the user's health factor.
 * `asset` is the underlying token address or its symbol; `amount` is in
 * human units (e.g. "100" for 100 USDC).
 */
export async function previewAaveAction(
  userAddress: string,
  chainId: number,
  action: AaveAction,
  asset: string,
  amount: string,
): Promise<AaveActionPreview | null> {
  try {
    const reserve = await resolveAaveReserve(chainId, asset);
    if (!reserve) {
      console.warn(`[mcp/aave] previewAaveAction: no Aave v3 reserve for ${asset} on chain ${chainId}`);
      return null;
    }
    const result = await callMcpTool(AAVE_MCP_URL, SERVER_NAME, "preview_action", {
      sender: userAddress,
      chainId,
      market: reserve.market,
      token: reserve.underlyingAsset,
      action,
      amount,
    });
    const data = parseMcpToolResult<{ data?: { healthFactorBefore?: string | null; healthFactorAfter?: string | null } }>(result)?.data;
    if (!data) return null;
    const after = numOrNull(data.healthFactorAfter);
    return {
      healthFactorBefore: numOrNull(data.healthFactorBefore),
      healthFactorAfter: after,
      willLiquidate: after !== null && after < 1,
    };
  } catch (err) {
    console.warn("[mcp/aave] previewAaveAction failed:", err);
    return null;
  }
}

// ─── Write operations (unsigned tx building) ─────────────────────────

/**
 * Build an unsigned Aave v3 transaction via the MCP server's `prepare_action`.
 * When the allowance is short, the plan carries the approval to send first.
 * `asset` is the underlying token address or symbol; `amount` is in human units.
 */
export async function buildAaveTransaction(
  userAddress: string,
  chainId: number,
  action: AaveAction,
  asset: string,
  amount: string,
): Promise<AaveTxPlan | null> {
  try {
    const reserve = await resolveAaveReserve(chainId, asset);
    if (!reserve) {
      console.warn(`[mcp/aave] buildAaveTransaction: no Aave v3 reserve for ${asset} on chain ${chainId}`);
      return null;
    }
    const result = await callMcpTool(AAVE_MCP_URL, SERVER_NAME, "prepare_action", {
      sender: userAddress,
      chainId,
      market: reserve.market,
      token: reserve.underlyingAsset,
      action,
      amount,
    });
    const data = parseMcpToolResult<RawPrepareResponse>(result)?.data;
    if (!data) return null;
    if (data.originalTransaction) {
      const tx = normalizeTx(data.originalTransaction);
      return tx ? { approval: normalizeTx(data.approval), tx } : null;
    }
    const tx = normalizeTx(data);
    return tx ? { approval: null, tx } : null;
  } catch (err) {
    console.warn(`[mcp/aave] buildAaveTransaction(${action}) failed:`, err);
    return null;
  }
}

/**
 * Fetch live supply/borrow rates for the strategy engine.
 * Returns a formatted summary string for the LLM. Only reserves in the pool
 * Meridian executes Aave orders against (AAVE_V3_POOL_BY_CHAIN) are listed —
 * a rate from another market (Lido, Horizon, …) would be a rate the user
 * can't get here. Reserves that can't take a deposit right now (frozen,
 * paused, supply cap reached) are left out too.
 */
export async function fetchAaveYieldSummary(chainIds: number[]): Promise<string> {
  const perChain = await Promise.all(chainIds.map((id) => fetchAaveReserves(id)));
  const lines: string[] = [];

  chainIds.forEach((chainId, i) => {
    const top = perChain[i]
      .filter((r) => isAaveReserveExecutable(r) && isAaveReserveSuppliable(r) && r.supplyApyPct > 0)
      .sort((a, b) => b.supplyApyPct - a.supplyApyPct)
      .slice(0, 10);
    if (top.length === 0) return;

    const chainName = CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;
    lines.push(`\n### Aave v3 on ${chainName} (live from Aave MCP)`);
    for (const r of top) {
      const borrow = r.borrowApyPct !== null && r.canBorrow ? ` | Borrow ${r.borrowApyPct.toFixed(2)}% APY` : "";
      lines.push(
        `- ${r.symbol}: Supply ${r.supplyApyPct.toFixed(2)}% APY${borrow} | Supplied $${Math.round(r.totalSuppliedUsd).toLocaleString("en-US")}`,
      );
    }
  });

  return lines.join("\n");
}
