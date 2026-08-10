/**
 * hyperliquid-live.ts — live network layer for Hyperliquid perp orders.
 *
 * This module performs the actual reads and the (testnet-first) submission that
 * the pure `hyperliquid.ts` adapter shapes. It only SIGNS when the caller
 * supplies a `sign` function (wired to the connected wallet), and it only
 * SUBMITS after the caller invokes `executeHyperliquidPerp` — never implicitly.
 *
 * Safety: `testnet` defaults to true so a stray run never touches mainnet /
 * real funds. Pass `testnet:false` explicitly (and confirm in the UI) to target
 * https://api.hyperliquid.xyz.
 */

import type { Address } from "viem";
import {
  assetIndexFromUniverse,
  buildExchangeRequest,
  buildTypedData,
  validateOrder,
  HYPERLIQUID_EXCHANGE_URL,
  HYPERLIQUID_INFO_URL,
  HYPERLIQUID_TESTNET_EXCHANGE_URL,
  HYPERLIQUID_TESTNET_INFO_URL,
} from "./hyperliquid";
import type { PerpOrder, PerpSignFunction } from "./types";

export interface HyperliquidEnv {
  infoUrl: string;
  exchangeUrl: string;
  testnet: boolean;
}

/**
 * Global MAINNET gate for the live Hyperliquid layer.
 *
 * TESTNET-FIRST by default. Only when `NEXT_PUBLIC_HL_MAINNET === "true"` (set
 * in the deployment / .env) does this module route order submission AND account
 * reads to the REAL Hyperliquid mainnet (https://api.hyperliquid.xyz).
 *
 * ⚠️ MAINNET TRADES REAL FUNDS. Mainnet perp orders are irreversible and move
 * real money on chain. There is no warning, cancellation, or safety net. Ensure
 * the flag is OFF (or unset) for any development, test, or demo run.
 */
export const HL_ENV: "testnet" | "mainnet" =
  process.env.NEXT_PUBLIC_HL_MAINNET === "true" ? "mainnet" : "testnet";

/** Boolean mainnet marker the UI can display. True ONLY when the flag is set. */
export const HL_MAINNET: boolean = HL_ENV === "mainnet";

/** Human-readable mainnet marker string the UI can render ("MAINNET" when live). */
export const HL_ENV_LABEL: "MAINNET" | "TESTNET" = HL_MAINNET ? "MAINNET" : "TESTNET";

/**
 * Resolve the live Hyperliquid base URLs (info reads + exchange order submit).
 * The global `NEXT_PUBLIC_HL_MAINNET` flag is the master switch: when it is set
 * we route to mainnet REGARDLESS of `testnet`. When it is unset (default) we
 * honor the explicit `testnet` argument — and since callers default that to
 * true, the module stays on testnet unless the flag is deliberately enabled.
 */
export function hyperliquidEnv(testnet: boolean): HyperliquidEnv {
  const mainnet = HL_MAINNET || !testnet;
  return {
    infoUrl: mainnet ? HYPERLIQUID_INFO_URL : HYPERLIQUID_TESTNET_INFO_URL,
    exchangeUrl: mainnet ? HYPERLIQUID_EXCHANGE_URL : HYPERLIQUID_TESTNET_EXCHANGE_URL,
    testnet: !mainnet,
  };
}

interface MetaAsset {
  name?: string;
  index?: number;
}

/** Fetch the Hyperliquid asset universe (`{"type":"meta"}`) — array position is the asset index. */
export async function fetchUniverse(env: HyperliquidEnv): Promise<MetaAsset[]> {
  const res = await fetch(env.infoUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "meta" }),
  });
  if (!res.ok) throw new Error(`Hyperliquid meta request failed: ${res.status}`);
  const data = (await res.json()) as { universe?: MetaAsset[] };
  return data.universe ?? [];
}

/** Fetch the current mid price for a coin from the L2 order book. Returns null if unavailable. */
export async function fetchMidPrice(symbol: string, env: HyperliquidEnv): Promise<number | null> {
  const coin = (symbol || "").toUpperCase().replace(/-PERP$/, "");
  const res = await fetch(env.infoUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "l2Book", coin }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    levels?: Array<Array<{ px?: string }>>;
  };
  const levels = data.levels ?? [];
  const bids = levels[0];
  const asks = levels[1];
  const bid = parseFloat(bids?.[0]?.px ?? "");
  const ask = parseFloat(asks?.[0]?.px ?? "");
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
  return (bid + ask) / 2;
}

/**
 * Submit a signed order payload to the Hyperliquid exchange API.
 * Returns the raw JSON response (status ok / error) without throwing on a
 * venue-level rejection.
 */
export async function submitToExchange(
  req: { action: object; nonce: number; signature: [string, string]; connectionId: string },
  env: HyperliquidEnv,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(env.exchangeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }
  return { status: res.status, body };
}

export interface ExecuteHyperliquidParams {
  symbol: string;
  isBuy: boolean;
  sizeUsd: number;
  leverage?: number;
  signer: Address;
  sign: PerpSignFunction;
  testnet?: boolean;
  /**
   * Explicit coin quantity in coin units (e.g. 0.2392 ETH). When supplied and
   * positive it is used EXACTLY as the order's `sizePerp` (the actual fill), so
   * the caller's quoted amount is authoritative rather than re-derived. Without
   * it the layer derives the quantity from `sizeUsd` / the live mid price.
   */
  coinQty?: number;
  /** true = only reduce an existing position (close). */
  reduceOnly?: boolean;
}

export interface ExecuteHyperliquidResult {
  ok: boolean;
  testnet: boolean;
  symbol: string;
  marketPrice: number | null;
  order: PerpOrder;
  response?: unknown;
  error?: string;
}

/**
 * Execute a Hyperliquid perp order end to end: fetch live asset index + price,
 * build + validate the order, sign it with the caller-supplied wallet `sign`,
 * and submit to the exchange API. TESTNET by default.
 */
export async function executeHyperliquidPerp(
  params: ExecuteHyperliquidParams,
): Promise<ExecuteHyperliquidResult> {
  const testnet = params.testnet !== false;
  const env = hyperliquidEnv(testnet);
  const symbol = (params.symbol || "").toUpperCase().replace(/-PERP$/, "");

  const universe = await fetchUniverse(env);
  const assetIndex = assetIndexFromUniverse(universe, symbol);

  // Safety: the execution amount must be validated positive BEFORE any build/sign.
  // The caller's explicit coinQty is authoritative; otherwise sizeUsd must be > 0.
  if (params.coinQty !== undefined && !(Number.isFinite(params.coinQty) && params.coinQty > 0)) {
    return {
      ok: false,
      testnet: env.testnet,
      symbol,
      marketPrice: null,
      order: null as unknown as PerpOrder,
      error: `Refusing to execute: coin quantity for ${symbol} must be positive. No order was built or signed.`,
    };
  }
  if (
    params.coinQty === undefined &&
    !(Number.isFinite(params.sizeUsd) && params.sizeUsd > 0)
  ) {
    return {
      ok: false,
      testnet: env.testnet,
      symbol,
      marketPrice: null,
      order: null as unknown as PerpOrder,
      error: `Refusing to execute: notional size for ${symbol} must be positive. No order was built or signed.`,
    };
  }

  const price = await fetchMidPrice(symbol, env);
  if (price === null) {
    return {
      ok: false,
      testnet: env.testnet,
      symbol,
      marketPrice: null,
      order: null as unknown as PerpOrder,
      error: `Could not fetch a live price for ${symbol} on ${env.testnet ? "Hyperliquid testnet" : "Hyperliquid"}. No order was built or signed.`,
    };
  }

  const order: PerpOrder = {
    venue: "hyperliquid",
    market: symbol,
    symbol,
    isBuy: params.isBuy,
    sizeUsd: params.coinQty && params.coinQty > 0 ? params.coinQty * price : params.sizeUsd,
    sizePerp: params.coinQty && params.coinQty > 0 ? BigInt(Math.round(params.coinQty * 100_000_000)) : undefined,
    reduceOnly: params.reduceOnly ?? false,
    leverage: params.leverage ?? 1,
    price: BigInt(Math.round(price * 1_000_000)), // micro-units
    signer: params.signer,
    assetIndex,
  };

  // validate before signing (throws on bad size/leverage)
  const v = validateOrder(order);
  if (!v.ok) throw new Error(v.error);
  const typed = buildTypedData(order);
  // sign only because the caller passed a sign fn — never implicit
  const signature = await params.sign(typed);
  const signed = { order, signature, expiresAt: Date.now() + 60_000 };
  const req = buildExchangeRequest(signed);
  const { status, body } = await submitToExchange(req, env);

  const ok = status >= 200 && status < 300 && !String(JSON.stringify(body)).includes('"isError"') && !String(JSON.stringify(body)).includes('"type":"err"');
  return { ok, testnet: env.testnet, symbol, marketPrice: price, order, response: body, error: ok ? undefined : `Hyperliquid rejected the order (HTTP ${status}).` };
}

/** Which venues the live layer can actually route/submit for right now. */
export const LIVE_EXECUTABLE_VENUES = new Set(["hyperliquid", "Hyperliquid"]);

/** A parsed Hyperliquid position as shown to the user. */
export interface HlPosition {
  coin: string;
  /** Coin quantity; positive = long, negative = short. */
  size: number;
  entryPx: number;
  notional: number;
  unrealizedPnl: number;
  leverage: number;
}

/** The user's Hyperliquid account snapshot. */
export interface HlAccount {
  accountValue: number;
  totalMarginUsed: number;
  withdrawable: number;
  positions: HlPosition[];
}

interface RawPosition {
  position?: {
    coin?: string;
    szi?: string;
    entryPx?: string;
    positionValue?: string;
    unrealizedPnl?: string;
    notional?: string;
    leverage?: { value?: number | string };
  };
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

function parseClearinghouseState(data: {
  clearinghouseState?: {
    marginSummary?: Record<string, number>;
    withdrawable?: string;
    assetPositions?: RawPosition[];
  };
}): HlAccount {
  const ch = data?.clearinghouseState ?? {};
  const positions = (ch.assetPositions ?? [])
    .map((ap) => ap.position)
    .filter((p): p is NonNullable<typeof p> => !!p)
    .map((p) => ({
      coin: p.coin ?? "",
      size: num(p.szi),
      entryPx: num(p.entryPx),
      notional: num(p.notional ?? p.positionValue),
      unrealizedPnl: num(p.unrealizedPnl),
      leverage: num(p.leverage?.value ?? 1),
    }))
    .filter((p) => Math.abs(p.size) > 0.00000001);
  const totalMargin = num(ch.marginSummary?.totalMarginUsed);
  return {
    accountValue: num(ch.marginSummary?.accountValue),
    totalMarginUsed: totalMargin,
    withdrawable: num(ch.withdrawable),
    positions,
  };
}

/** Fetch a wallet's Hyperliquid account snapshot (positions, margin, pnl). Read-only. */
export async function fetchClearinghouseState(
  address: string,
  env: HyperliquidEnv,
): Promise<HlAccount> {
  const res = await fetch(env.infoUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "clearinghouseState", user: address }),
  });
  if (!res.ok) throw new Error(`Hyperliquid clearinghouseState failed: ${res.status}`);
  const data = (await res.json()) as Parameters<typeof parseClearinghouseState>[0];
  return parseClearinghouseState(data);
}

export interface HlOpenOrder {
  coin: string;
  side: string;
  size: number;
  limitPx: number;
  reduceOnly: boolean;
  oid: number;
}

/** Fetch a wallet's open orders on the venue. Read-only. */
export async function fetchOpenOrders(
  address: string,
  env: HyperliquidEnv,
): Promise<HlOpenOrder[]> {
  const res = await fetch(env.infoUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "openOrders", user: address }),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as Array<{
    coin?: string;
    side?: string;
    sz?: string;
    limitPx?: string;
    reduceOnly?: boolean;
    oid?: number;
  }>;
  return data.map((o) => ({
    coin: o.coin ?? "",
    side: o.side ?? "",
    size: num(o.sz),
    limitPx: num(o.limitPx),
    reduceOnly: !!o.reduceOnly,
    oid: o.oid ?? 0,
  }));
}
