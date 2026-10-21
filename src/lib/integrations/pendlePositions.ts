/**
 * integrations/pendlePositions.ts — a wallet's Pendle positions (PT, YT, LP)
 * for the portfolio. Pendle's dashboard endpoint gives each position's USD
 * valuation per market across chains; the market's own contracts give the
 * token names and the maturity (readTokens → PT.symbol / decimals / expiry),
 * so what the user sees is what they hold on-chain.
 *
 * Endpoint: GET {PENDLE_API}/v1/dashboard/positions/database/{user}?filterUsd=…
 * (4 CU, no key). Shape: { positions: [{ chainId, openPositions: [{ marketId:
 * "1-0x…", pt: { balance, valuation }, yt: {…}, lp: {…} }] }] }.
 */

import { createPublicClient, fallback, formatUnits, http, isAddress, type Address } from "viem";
import { RPC_URLS } from "@/lib/rpc";

const PENDLE_API = process.env.PENDLE_API_URL || "https://api-v2.pendle.finance/core";
/** Positions worth less than this are dust: not shown. */
const MIN_USD = 1;

export type PendleTokenKind = "PT" | "YT" | "LP";

export interface PendleRawPosition {
  chainId: number;
  market: Address;
  kind: PendleTokenKind;
  /** Token balance in wei, as Pendle reports it. */
  balance: string;
  usd: number;
}

export interface PendlePosition {
  chainId: number;
  market: Address;
  kind: PendleTokenKind;
  /** Token symbol from its contract ("PT-sUSDE-27NOV2025"), or a generic label when the chain can't be read. */
  symbol: string;
  balance: number;
  usd: number;
  /** Maturity, ISO date (PT/YT/LP share the market's). */
  expiry?: string;
}

/** Open positions worth at least MIN_USD, one row per token kind. */
export function parsePendlePositions(body: unknown): PendleRawPosition[] {
  const chains = (body as { positions?: unknown } | null)?.positions;
  if (!Array.isArray(chains)) return [];
  const out: PendleRawPosition[] = [];
  for (const c of chains) {
    const chainId = Number((c as { chainId?: unknown })?.chainId);
    const open = (c as { openPositions?: unknown })?.openPositions;
    if (!Number.isFinite(chainId) || !Array.isArray(open)) continue;
    for (const p of open) {
      const marketId = String((p as { marketId?: unknown })?.marketId ?? "");
      const market = marketId.split("-")[1];
      if (!market || !isAddress(market)) continue;
      for (const kind of ["PT", "YT", "LP"] as const) {
        const pos = (p as Record<string, { balance?: unknown; valuation?: unknown } | undefined>)[kind.toLowerCase()];
        const usd = Number(pos?.valuation);
        const balance = String(pos?.balance ?? "0");
        if (!(usd >= MIN_USD) || !/^\d+$/.test(balance) || balance === "0") continue;
        out.push({ chainId, market: market as Address, kind, balance, usd });
      }
    }
  }
  return out;
}

const MARKET_ABI = [
  { type: "function", name: "readTokens", stateMutability: "view", inputs: [], outputs: [{ name: "_SY", type: "address" }, { name: "_PT", type: "address" }, { name: "_YT", type: "address" }] },
  { type: "function", name: "expiry", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
] as const;
const TOKEN_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
] as const;

export interface MarketInfo {
  ptSymbol: string;
  ytSymbol: string;
  lpSymbol: string;
  ptDecimals: number;
  ytDecimals: number;
  lpDecimals: number;
  expiry: string;
}

/** Reads a market's tokens and maturity; null when the chain can't be read. */
export async function readMarketInfo(chainId: number, market: Address): Promise<MarketInfo | null> {
  const urls = RPC_URLS[chainId];
  if (!urls?.length) return null;
  const client = createPublicClient({ transport: fallback(urls.map((u) => http(u, { timeout: 8000 }))) });
  try {
    const [, pt, yt] = await client.readContract({ address: market, abi: MARKET_ABI, functionName: "readTokens" });
    const [expiry, lpDecimals, lpSymbol, ptDecimals, ptSymbol, ytDecimals, ytSymbol] = await Promise.all([
      client.readContract({ address: market, abi: MARKET_ABI, functionName: "expiry" }),
      client.readContract({ address: market, abi: MARKET_ABI, functionName: "decimals" }),
      client.readContract({ address: market, abi: MARKET_ABI, functionName: "symbol" }),
      client.readContract({ address: pt, abi: TOKEN_ABI, functionName: "decimals" }),
      client.readContract({ address: pt, abi: TOKEN_ABI, functionName: "symbol" }),
      client.readContract({ address: yt, abi: TOKEN_ABI, functionName: "decimals" }),
      client.readContract({ address: yt, abi: TOKEN_ABI, functionName: "symbol" }),
    ]);
    return { ptSymbol, ytSymbol, lpSymbol, ptDecimals, ytDecimals, lpDecimals, expiry: new Date(Number(expiry) * 1000).toISOString() };
  } catch {
    return null;
  }
}

/** Positions with token names and maturity; a market whose chain can't be read keeps a generic label (value still counts). */
export function enrichPositions(raw: PendleRawPosition[], info: Map<string, MarketInfo | null>): PendlePosition[] {
  return raw.map((r) => {
    const m = info.get(`${r.chainId}:${r.market.toLowerCase()}`) ?? null;
    const decimals = m ? (r.kind === "PT" ? m.ptDecimals : r.kind === "YT" ? m.ytDecimals : m.lpDecimals) : 18;
    const symbol = m ? (r.kind === "PT" ? m.ptSymbol : r.kind === "YT" ? m.ytSymbol : m.lpSymbol) : `Pendle ${r.kind}`;
    return { chainId: r.chainId, market: r.market, kind: r.kind, symbol, balance: Number(formatUnits(BigInt(r.balance), decimals)), usd: r.usd, expiry: m?.expiry };
  });
}

export async function fetchPendlePositions(user: Address): Promise<PendlePosition[]> {
  const res = await fetch(`${PENDLE_API}/v1/dashboard/positions/database/${user}?filterUsd=${MIN_USD}`, { next: { revalidate: 60 }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Pendle positions: HTTP ${res.status}`);
  const raw = parsePendlePositions(await res.json());
  const markets = [...new Set(raw.map((r) => `${r.chainId}:${r.market.toLowerCase()}`))];
  const info = new Map<string, MarketInfo | null>();
  await Promise.all(
    markets.map(async (key) => {
      const [chainId, market] = key.split(":");
      info.set(key, await readMarketInfo(Number(chainId), market as Address));
    }),
  );
  return enrichPositions(raw, info);
}
