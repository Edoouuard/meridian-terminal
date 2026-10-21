/**
 * txflow-live.ts — TxFlow reads (POST /info, unauthenticated): perp markets,
 * a market's mark and funding, an account's margin and positions, the Arbitrum
 * Bridge2 address for deposits.
 *
 * In the browser every call goes through Meridian's relay (`/api/txflow/…`):
 * TxFlow's CORS policy for third-party sites isn't documented, and the relay
 * keeps one code path for reads and signed writes. On the server, TxFlow's
 * host is called directly. Responses are `{success, code, data}`; numbers are
 * strings. Parsers are pure and unit-tested.
 */

import type { Address } from "viem";
import { TXFLOW, TXFLOW_API_VERSION_HEADER, type TxflowNetwork } from "@/lib/integrations/txflowExchange";

/** Network Meridian trades on (TxFlow mainnet unless the deployment says otherwise). */
export const TXFLOW_NETWORK: TxflowNetwork = process.env.NEXT_PUBLIC_TXFLOW_NETWORK === "testnet" ? "testnet" : "mainnet";
/** USDC credited to the perp account below this isn't (docs: minimum deposit 5 USDC). */
export const TXFLOW_MIN_DEPOSIT_USD = 5;
/** Perps taker fee, base tier (VIP 0, docs "Fees & Discounts"). */
export const TXFLOW_TAKER_FEE = 0.00045;

export function txflowUrl(network: TxflowNetwork, endpoint: "info" | "exchange"): string {
  return typeof window === "undefined" ? `${TXFLOW[network].host}/${endpoint}` : `${window.location.origin}/api/txflow/${network}/${endpoint}`;
}

export async function txflowInfo<T>(network: TxflowNetwork, body: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<T> {
  const res = await fetchImpl(txflowUrl(network, "info"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-version": TXFLOW_API_VERSION_HEADER },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => null)) as { success?: boolean; data?: T; message?: string } | null;
  if (!res.ok || !json || json.success === false) throw new Error(`TxFlow ${String(body.type)}: ${json?.message ?? `HTTP ${res.status}`}`);
  return json.data as T;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/* ─── Markets ────────────────────────────────────────────────────────── */

export interface TxflowMarket {
  /** Instrument id (`a` in orders, `coin` as a string in reads). */
  index: number;
  /** "BTC-USDC" */
  name: string;
  /** "BTC" */
  base: string;
  szDecimals: number;
  priceTick: string;
  maxLeverage: number;
  onlyIsolated: boolean;
  /** Largest market order, in base units (0 = not reported). */
  maxMarketOrderSize: number;
}

interface RawPerpInstrument {
  index?: number;
  name?: string;
  baseCurrency?: string;
  szDecimals?: number;
  priceTick?: string;
  maxLeverage?: number;
  onlyIsolated?: boolean;
  maxMarketOrderSize?: number | string;
  delisted?: boolean;
  haltTrading?: boolean;
}

/** Tradable perp instruments (not delisted, not halted). */
export function parseTxflowMarkets(data: { universe?: RawPerpInstrument[] } | undefined): TxflowMarket[] {
  return (data?.universe ?? [])
    .filter((m) => !m.delisted && !m.haltTrading && Number.isInteger(m.index) && m.name && m.priceTick)
    .map((m) => ({
      index: m.index as number,
      name: m.name as string,
      base: (m.baseCurrency || (m.name as string).split("-")[0]).toUpperCase(),
      szDecimals: Number(m.szDecimals ?? 0),
      priceTick: m.priceTick as string,
      maxLeverage: num(m.maxLeverage) || 1,
      onlyIsolated: !!m.onlyIsolated,
      maxMarketOrderSize: num(m.maxMarketOrderSize),
    }));
}

/** "ETH", "eth-perp", "ETH-USDC" → the market trading that base. */
export function findTxflowMarket(markets: TxflowMarket[], symbol: string): TxflowMarket | undefined {
  const base = symbol.toUpperCase().replace(/[-\s]?PERP$/, "").replace(/-USDC?$/, "").trim();
  return markets.find((m) => m.base === base || m.name.toUpperCase() === symbol.toUpperCase());
}

const marketsCache = new Map<TxflowNetwork, { at: number; markets: TxflowMarket[] }>();

export async function fetchTxflowMarkets(network: TxflowNetwork = TXFLOW_NETWORK): Promise<TxflowMarket[]> {
  const hit = marketsCache.get(network);
  if (hit && Date.now() - hit.at < 300_000) return hit.markets;
  const markets = parseTxflowMarkets(await txflowInfo<{ universe?: RawPerpInstrument[] }>(network, { type: "perpMeta", includeDelisted: false }));
  marketsCache.set(network, { at: Date.now(), markets });
  return markets;
}

/* ─── Market context (mark, funding) ─────────────────────────────────── */

export interface TxflowMarketCtx {
  mark: number;
  oracle: number;
  /** Funding rate per hourly settlement, as a fraction (TxFlow publishes it in percent). */
  fundingHourly: number;
  dayVolumeUsd: number;
  openInterest: number;
}

interface RawAssetCtx {
  markPx?: string;
  oraclePx?: string;
  dayNtlVlm?: string;
  openInterest?: string;
  nodeCtx?: { funding?: string; markPx?: string; oraclePx?: string; midPx?: string };
}

/** `nodeCtx.funding` is in percent per hourly cycle ("0.01" = 0.01% = 0.0001). */
export function parseTxflowCtx(data: RawAssetCtx | undefined): TxflowMarketCtx | null {
  if (!data) return null;
  const mark = num(data.markPx) || num(data.nodeCtx?.markPx) || num(data.nodeCtx?.midPx);
  if (!(mark > 0)) return null;
  return {
    mark,
    oracle: num(data.oraclePx) || num(data.nodeCtx?.oraclePx),
    fundingHourly: num(data.nodeCtx?.funding) / 100,
    dayVolumeUsd: num(data.dayNtlVlm),
    openInterest: num(data.openInterest),
  };
}

export async function fetchTxflowCtx(index: number, network: TxflowNetwork = TXFLOW_NETWORK): Promise<TxflowMarketCtx | null> {
  return parseTxflowCtx(await txflowInfo<RawAssetCtx>(network, { type: "activeAssetCtx", coin: String(index) }));
}

/* ─── Account ────────────────────────────────────────────────────────── */

export interface TxflowPosition {
  index: number;
  /** Signed size in base units: > 0 long, < 0 short. */
  size: number;
  entry: number;
  mark: number;
  liq: number;
  unrealisedPnl: number;
  value: number;
  leverage: number;
  /** Funding received (+) or paid (−) since open: null, TxFlow doesn't document the sign of `cumFunding`. */
  funding: number | null;
}

export interface TxflowAccount {
  accountValue: number;
  withdrawable: number;
  marginUsed: number;
  positions: TxflowPosition[];
}

interface RawClearinghouse {
  withdrawable?: string;
  marginSummary?: { accountValue?: string; totalMarginUsed?: string };
  assetPositions?: {
    position?: {
      asset?: string | number;
      szi?: string;
      entryPx?: string;
      markPx?: string;
      liquidationPx?: string;
      unrealizedPnl?: string;
      positionValue?: string;
      leverage?: { value?: number };
    };
  }[];
}

export function parseTxflowAccount(data: RawClearinghouse | undefined): TxflowAccount {
  const positions = (data?.assetPositions ?? [])
    .map(({ position: p }) => ({
      index: num(p?.asset),
      size: num(p?.szi),
      entry: num(p?.entryPx),
      mark: num(p?.markPx),
      liq: num(p?.liquidationPx),
      unrealisedPnl: num(p?.unrealizedPnl),
      value: Math.abs(num(p?.positionValue)),
      leverage: num(p?.leverage?.value) || 1,
      funding: null,
    }))
    .filter((p) => p.size !== 0);
  return {
    accountValue: num(data?.marginSummary?.accountValue),
    withdrawable: num(data?.withdrawable),
    marginUsed: num(data?.marginSummary?.totalMarginUsed),
    positions,
  };
}

export async function fetchTxflowAccount(user: Address, network: TxflowNetwork = TXFLOW_NETWORK): Promise<TxflowAccount> {
  return parseTxflowAccount(await txflowInfo<RawClearinghouse>(network, { type: "clearinghouseState", user, accountType: "perp" }));
}

/** Arbitrum Bridge2 contract that credits a USDC transfer to the sender's TxFlow perp account. */
export async function fetchTxflowBridge(network: TxflowNetwork = TXFLOW_NETWORK): Promise<Address | null> {
  const data = await txflowInfo<{ bridge2_contract_address?: string }>(network, { type: "settings" });
  const a = data?.bridge2_contract_address;
  return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as Address) : null;
}

/* ─── Planner summary ────────────────────────────────────────────────── */

export interface TxflowMarketRow extends TxflowMarket, TxflowMarketCtx {}

const rowsCache = new Map<TxflowNetwork, { at: number; rows: TxflowMarketRow[] }>();

/** Markets with their context, most traded first (server: one activeAssetCtx read per market, capped, cached a minute). */
export async function fetchTxflowMarketRows(network: TxflowNetwork = TXFLOW_NETWORK, limit = 40): Promise<TxflowMarketRow[]> {
  const hit = rowsCache.get(network);
  if (hit && Date.now() - hit.at < 60_000) return hit.rows;
  const markets = (await fetchTxflowMarkets(network)).slice(0, limit);
  const rows = await Promise.all(
    markets.map(async (m) => {
      const ctx = await fetchTxflowCtx(m.index, network).catch(() => null);
      return ctx ? { ...m, ...ctx } : null;
    }),
  );
  const out = rows.filter((r): r is TxflowMarketRow => r !== null).sort((a, b) => b.dayVolumeUsd - a.dayVolumeUsd);
  if (out.length > 0) rowsCache.set(network, { at: Date.now(), rows: out });
  return out;
}
