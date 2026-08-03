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

export function hyperliquidEnv(testnet: boolean): HyperliquidEnv {
  return {
    infoUrl: testnet ? HYPERLIQUID_TESTNET_INFO_URL : HYPERLIQUID_INFO_URL,
    exchangeUrl: testnet ? HYPERLIQUID_TESTNET_EXCHANGE_URL : HYPERLIQUID_EXCHANGE_URL,
    testnet,
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
  const price = await fetchMidPrice(symbol, env);
  if (price === null) {
    return {
      ok: false,
      testnet,
      symbol,
      marketPrice: null,
      order: null as unknown as PerpOrder,
      error: `Could not fetch a live price for ${symbol} on ${testnet ? "Hyperliquid testnet" : "Hyperliquid"}. No order was built or signed.`,
    };
  }

  const order: PerpOrder = {
    venue: "hyperliquid",
    market: symbol,
    symbol,
    isBuy: params.isBuy,
    sizeUsd: params.sizeUsd,
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
  return { ok, testnet, symbol, marketPrice: price, order, response: body, error: ok ? undefined : `Hyperliquid rejected the order (HTTP ${status}).` };
}

/** Which venues the live layer can actually route/submit for right now. */
export const LIVE_EXECUTABLE_VENUES = new Set(["hyperliquid", "Hyperliquid"]);
