/**
 * extended-live.ts — live network layer for Extended (ex-X10) perp orders.
 *
 * Extended is a perp DEX on Starknet/StarkEx: unlike Hyperliquid's plain
 * EIP-712 order signing, Extended settles orders with a StarkEx Pedersen/
 * Poseidon-hash signature over a Stark L2 keypair (SNIP-12). That scheme
 * cannot be produced by a browser wallet (MetaMask can't sign a Stark-curve
 * message), so this module depends on `@blackcube/extended-sdk` — a
 * TypeScript implementation of that signing scheme, built on the audited
 * `@noble`/`@scure` primitives, whose README documents it as validated
 * bit-for-bit against Extended's own Rust reference implementation and
 * accepted by Extended's real testnet order engine. Meridian does not
 * reimplement Stark-curve cryptography itself.
 *
 * The connected `Signer` (API key + Stark keypair + vault id) comes from
 * `useExtendedAccount` — the user's own Extended account, connected once via
 * the credentials Extended's dashboard already gives them. This module only
 * ever PLACES an order on explicit call; it never reads, transfers, or
 * withdraws.
 */

import { Extended, type Signer as ExtendedSigner, type Network as ExtendedNetwork } from "@blackcube/extended-sdk";
import { resolvePriceFromList, type PriceEntry } from "@/lib/quote";
import { extendedRestUrls } from "@/lib/integrations/extendedProxy";
import { marketBase } from "@/lib/perpVenues";

/** SDK client bound to the connected account, talking to Extended through Meridian's relay (Extended has no CORS). */
export function extendedClient(signer: ExtendedSigner): Extended {
  return new Extended({ meridian: signer }, { default: "meridian", restUrls: extendedRestUrls() });
}

/** Extended's market convention: hyphened base-quote against USD, e.g. "SOL" -> "SOL-USD". */
export function toExtendedMarket(symbol: string): string {
  const raw = (symbol || "").trim().replace(/\s*-?PERP$/i, "");
  // Exact Extended names keep their case ("AMD_24_5-USD", "SPX500m-USD").
  if (/-USD$/i.test(raw)) return raw.replace(/-usd$/i, "-USD");
  return `${raw.toUpperCase()}-USD`;
}

/**
 * Format a positive quantity as a plain decimal string (no scientific
 * notation), trimmed of trailing zeros — the shape Extended's REST API wants
 * for `size`/`price`. Extended's own step-size validation is the real
 * precision check; this just avoids sending "1.23e-7"-style output.
 */
export function formatDecimal(n: number, maxDecimals = 8): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const fixed = n.toFixed(maxDecimals);
  const trimmed = fixed.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed || "0";
}

/**
 * Worst-case marketable limit price for an IOC "market" order: the live mid
 * shifted by a generous slippage buffer in the direction that guarantees a
 * fill. Extended's settlement signs a quote/fee amount computed FROM this
 * price, so — unlike a pure market order with no price at all — the signed
 * order actually bounds worst-case cost instead of defaulting to zero.
 */
export function worstCasePrice(mid: number, isBuy: boolean, slippageBps = 100): number {
  const factor = isBuy ? 1 + slippageBps / 10_000 : 1 - slippageBps / 10_000;
  return mid * factor;
}

/** What an order needs to know about an Extended market (public `GET /info/markets?market=`). */
export interface ExtendedMarketInfo {
  name: string;
  mark: number;
  /** Quantity step (`minOrderSizeChange`). */
  step: number;
  /** Price tick (`minPriceChange`). */
  tick: number;
  /** Minimum order quantity, in the base asset. */
  minQty: number;
  maxLeverage: number;
  /** Funding rate per hour (Extended settles hourly). */
  fundingHourly: number;
  active: boolean;
}

interface RawExtendedMarket {
  name?: string;
  active?: boolean;
  status?: string;
  marketStats?: { markPrice?: string; fundingRate?: string };
  tradingConfig?: { minOrderSize?: string; minOrderSizeChange?: string; minPriceChange?: string; maxLeverage?: string };
}

export function parseExtendedMarket(raw: RawExtendedMarket | undefined): ExtendedMarketInfo | null {
  if (!raw?.name) return null;
  const n = (v: unknown) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  const info = {
    name: raw.name,
    mark: n(raw.marketStats?.markPrice),
    step: n(raw.tradingConfig?.minOrderSizeChange),
    tick: n(raw.tradingConfig?.minPriceChange),
    minQty: n(raw.tradingConfig?.minOrderSize),
    maxLeverage: n(raw.tradingConfig?.maxLeverage) || 1,
    fundingHourly: n(raw.marketStats?.fundingRate),
    active: raw.active !== false && (raw.status ?? "ACTIVE") === "ACTIVE",
  };
  return info.mark > 0 && info.step > 0 && info.tick > 0 ? info : null;
}

export async function fetchExtendedMarket(network: ExtendedNetwork, symbol: string, fetchImpl: typeof fetch = fetch): Promise<ExtendedMarketInfo | null> {
  const market = toExtendedMarket(symbol);
  const base = `${extendedRestUrls()[network]}/info/markets`;
  const res = await fetchImpl(`${base}?market=${encodeURIComponent(market)}`);
  if (res.ok) {
    const exact = ((await res.json()) as { data?: RawExtendedMarket[] }).data?.find((m) => m.name === market);
    if (exact) return parseExtendedMarket(exact);
  }
  // Stocks and indices carry a suffix ("AMD" trades as AMD_24_5-USD): match on what the market tracks.
  const all = await fetchImpl(base);
  if (!all.ok) return null;
  const want = marketBase(symbol);
  const rows = ((await all.json()) as { data?: (RawExtendedMarket & { marketStats?: { dailyVolume?: string } })[] }).data ?? [];
  const match = rows
    .filter((m) => m.name && marketBase(m.name) === want)
    .sort((a, b) => Number(b.marketStats?.dailyVolume ?? 0) - Number(a.marketStats?.dailyVolume ?? 0))[0];
  return parseExtendedMarket(match);
}

/** Decimals of a step like "0.001" → 3. */
function decimalsOf(step: number): number {
  const s = step.toString();
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  return s.includes(".") ? s.split(".")[1].length : 0;
}

/** Quantity rounded DOWN to the market's step (never more than asked). */
export function roundQtyToStep(qty: number, step: number): string {
  const d = decimalsOf(step);
  const units = Math.floor(qty / step + 1e-9);
  return (units * step).toFixed(d);
}

/** Price rounded to the tick, away from the mark for a buy (up) and a sell (down), so the bound stays a bound. */
export function roundPriceToTick(price: number, tick: number, isBuy: boolean): string {
  const d = decimalsOf(tick);
  const units = isBuy ? Math.ceil(price / tick - 1e-9) : Math.floor(price / tick + 1e-9);
  return (units * tick).toFixed(d);
}

export interface ExecuteExtendedParams {
  signer: ExtendedSigner;
  symbol: string;
  isBuy: boolean;
  /** USD notional to size from Extended's mark price. Ignored when `qtyOverride` is set. */
  sizeUsd: number;
  /** Fallback prices, used only when Extended's market data can't be read. */
  prices?: PriceEntry[];
  reduceOnly?: boolean;
  /** Leverage to set on the market before opening (Extended keeps one leverage per market). */
  leverage?: number;
  /**
   * Exact base-asset quantity to use verbatim instead of deriving one from
   * `sizeUsd` / a live price — for closing a known position exactly (a
   * price-derived qty would drift from the real position size).
   */
  qtyOverride?: number;
}

export interface ExecuteExtendedResult {
  ok: boolean;
  network: ExtendedNetwork;
  market: string;
  qty?: string;
  /** Filled quantity and average price, once Extended reports the fill. */
  filledQty?: string;
  avgPrice?: string;
  order?: unknown;
  error?: string;
}

/** Order states Extended reports (python SDK `OrderStatus`). */
const FINAL_FAIL = new Set(["CANCELLED", "REJECTED", "EXPIRED"]);

/** Plain-language reason for an order Extended cancelled or rejected. */
export function explainExtendedReject(reason: string | undefined): string {
  switch (reason) {
    case "NO_LIQUIDITY":
      return "nothing to fill within 1% of the mark price right now, so nothing was bought or sold";
    case "NOT_ENOUGH_FUNDS":
      return "not enough margin on your Extended account; deposit on extended.exchange first";
    case "REDUCE_ONLY_FAILED":
      return "there is no position left to close";
    case "INVALID_LEVERAGE":
      return "that leverage is not allowed on this market";
    case "REDUCE_ONLY_MODE":
    case "TRADING_OFF_MODE":
    case "DISABLED_MARKET":
      return "this market only accepts closing orders right now";
    default:
      return reason ? `Extended cancelled it (${reason})` : "Extended cancelled it";
  }
}

/** Poll the order until Extended reports a fill or a final failure (IOC orders settle within a second). */
async function confirmOrder(
  signer: ExtendedSigner,
  orderId: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
): Promise<{ status: string; reason?: string; filledQty?: string; avgPrice?: string } | null> {
  const url = `${extendedRestUrls()[signer.network]}/user/orders/${orderId}`;
  for (let i = 0; i < 8; i++) {
    await sleep(500);
    try {
      const res = await fetchImpl(url, { headers: { "x-api-key": signer.apiKey } });
      if (!res.ok) continue;
      const text = await res.text();
      const o = (JSON.parse(text) as { data?: { status?: string; statusReason?: string; filledQty?: string; averagePrice?: string } }).data;
      if (!o?.status) continue;
      if (o.status === "FILLED" || FINAL_FAIL.has(o.status)) {
        return { status: o.status, reason: o.statusReason, filledQty: o.filledQty, avgPrice: o.averagePrice };
      }
    } catch {
      // keep polling
    }
  }
  return null;
}

/**
 * Execute an Extended perp order end to end: read the market from Extended
 * (mark price, size step, price tick, minimum), size the USD notional against
 * Extended's own mark, set the leverage, place a worst-case-priced IOC order
 * signed with the connected Stark key, then wait for Extended to report the
 * fill. HARD-FAIL: refuses to submit without a positive size and a price, and
 * reports a cancelled IOC as a failure (never as "submitted").
 */
export async function executeExtendedPerp(
  params: ExecuteExtendedParams,
  deps: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; client?: Extended } = {},
): Promise<ExecuteExtendedResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // What the market tracks ("AMD" for AMD_24_5-USD): used for messages and the fallback price.
  const symbol = marketBase(params.symbol || "");
  let market = toExtendedMarket(params.symbol || "");
  const network = params.signer.network;

  const hasOverride = params.qtyOverride !== undefined;
  if (!hasOverride && !(Number.isFinite(params.sizeUsd) && params.sizeUsd > 0)) {
    return { ok: false, network, market, error: `Refusing to execute: notional size for ${symbol} must be positive. No order was built or signed.` };
  }
  if (hasOverride && !(Number.isFinite(params.qtyOverride) && (params.qtyOverride as number) > 0)) {
    return { ok: false, network, market, error: `Refusing to execute: quantity for ${symbol} must be positive.` };
  }

  const info = await fetchExtendedMarket(network, params.symbol, fetchImpl).catch(() => null);
  if (info) market = info.name;
  if (info && !info.active) return { ok: false, network, market, error: `${market} is not open for trading on Extended right now.` };
  const price = info?.mark ?? resolvePriceFromList(params.prices, symbol);
  if (price === null || !(price > 0)) {
    return { ok: false, network, market, error: `No live price for ${symbol} — cannot size this order safely. No order was built or signed.` };
  }

  const rawQty = hasOverride ? (params.qtyOverride as number) : params.sizeUsd / price;
  const qtyStr = info ? roundQtyToStep(rawQty, info.step) : formatDecimal(rawQty);
  const qty = Number(qtyStr);
  if (!(Number.isFinite(qty) && qty > 0)) {
    return { ok: false, network, market, error: `Computed a non-positive size for ${symbol} — refusing to submit.` };
  }
  if (info && qty < info.minQty && !params.reduceOnly) {
    return {
      ok: false,
      network,
      market,
      error: `Extended's minimum order on ${market} is ${info.minQty} ${symbol} (≈ $${(info.minQty * price).toFixed(2)}); this order is ${qtyStr}.`,
    };
  }
  const worst = worstCasePrice(price, params.isBuy);
  const limitPrice = info ? roundPriceToTick(worst, info.tick, params.isBuy) : formatDecimal(worst, 2);

  const dex = deps.client ?? extendedClient(params.signer);
  try {
    if (!params.reduceOnly && params.leverage && params.leverage > 0) {
      const lev = Math.max(1, Math.min(Math.round(params.leverage), info?.maxLeverage ?? params.leverage));
      await dex.perp().updateLeverage({ name: market, leverage: lev });
    }
    const order = await dex.perp().place({
      name: market,
      side: params.isBuy ? "buy" : "sell",
      type: "market",
      size: qtyStr,
      price: limitPrice,
      tif: "ioc",
      reduceOnly: params.reduceOnly ?? false,
    });
    const id = (order as { id?: string }).id;
    const fill = id ? await confirmOrder(params.signer, id, fetchImpl, sleep) : null;
    if (fill && FINAL_FAIL.has(fill.status) && !(Number(fill.filledQty) > 0)) {
      return { ok: false, network, market, qty: qtyStr, order, error: `Order not filled: ${explainExtendedReject(fill.reason)}.` };
    }
    return { ok: true, network, market, qty: qtyStr, order, filledQty: fill?.filledQty, avgPrice: fill?.avgPrice };
  } catch (err) {
    return { ok: false, network, market, qty: qtyStr, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Read-only: the connected account's open perp positions on Extended. */
export async function fetchExtendedPositions(signer: ExtendedSigner) {
  return extendedClient(signer).perp().getPositions();
}

async function getPrivate(signer: ExtendedSigner, path: string, fetchImpl: typeof fetch): Promise<{ status: number; data?: unknown }> {
  const res = await fetchImpl(`${extendedRestUrls()[signer.network]}${path}`, { headers: { "x-api-key": signer.apiKey } });
  const text = await res.text();
  if (!res.ok) return { status: res.status };
  try {
    return { status: res.status, data: (JSON.parse(text.replace(/("(?:id|accountId)"\s*:\s*)(\d{16,})/g, '$1"$2"')) as { data?: unknown }).data };
  } catch {
    return { status: res.status };
  }
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export interface ExtendedBalance {
  equity: number;
  availableForTrade: number;
  unrealisedPnl: number;
  initialMargin: number;
}

/** Account equity and free margin; null when the account has never been funded (Extended answers 404). */
export async function fetchExtendedBalance(signer: ExtendedSigner, fetchImpl: typeof fetch = fetch): Promise<ExtendedBalance | null> {
  const r = await getPrivate(signer, "/user/balance", fetchImpl);
  if (r.status === 404) return null;
  if (r.status !== 200 || !r.data) throw new Error(`Extended balance unavailable (${r.status})`);
  const b = r.data as Record<string, unknown>;
  return { equity: num(b.equity), availableForTrade: num(b.availableForTrade), unrealisedPnl: num(b.unrealisedPnl), initialMargin: num(b.initialMargin) };
}

/** An open Extended position, as Extended reports it (`GET /user/positions`). */
export interface ExtendedPositionView {
  market: string;
  symbol: string;
  side: "long" | "short";
  /** Base-asset quantity, always positive. */
  size: number;
  /** Notional at mark, USD. */
  value: number;
  entry: number;
  mark: number;
  /** 0 when Extended reports none. */
  liq: number;
  leverage: number;
  unrealisedPnl: number;
  /** Realised so far on the open position: fees and funding until it is reduced. */
  realisedPnl: number;
  /** Funding received (+) or paid (−) since open, when Extended breaks it out. */
  funding: number | null;
  tp: number | null;
  sl: number | null;
  openedAt: number;
}

interface RawExtendedPosition {
  market?: string;
  side?: string;
  size?: string;
  value?: string;
  openPrice?: string;
  markPrice?: string;
  liquidationPrice?: string | null;
  leverage?: string;
  unrealisedPnl?: string;
  realisedPnl?: string;
  realisedPnlBreakdown?: { fundingFees?: string };
  tpPrice?: string | null;
  slPrice?: string | null;
  createdAt?: number;
}

export function parseExtendedPositions(data: RawExtendedPosition[] | undefined): ExtendedPositionView[] {
  return (data ?? [])
    .filter((p) => p.market && Math.abs(num(p.size)) > 0)
    .map((p) => ({
      market: p.market!,
      symbol: p.market!.replace(/-USD$/i, ""),
      side: (p.side ?? "").toUpperCase() === "SHORT" ? ("short" as const) : ("long" as const),
      size: Math.abs(num(p.size)),
      value: Math.abs(num(p.value)),
      entry: num(p.openPrice),
      mark: num(p.markPrice),
      liq: num(p.liquidationPrice),
      leverage: num(p.leverage) || 1,
      unrealisedPnl: num(p.unrealisedPnl),
      realisedPnl: num(p.realisedPnl),
      funding: p.realisedPnlBreakdown?.fundingFees !== undefined ? num(p.realisedPnlBreakdown.fundingFees) : null,
      tp: p.tpPrice ? num(p.tpPrice) : null,
      sl: p.slPrice ? num(p.slPrice) : null,
      openedAt: p.createdAt ?? 0,
    }));
}

export async function fetchExtendedPositionViews(signer: ExtendedSigner, fetchImpl: typeof fetch = fetch): Promise<ExtendedPositionView[]> {
  const r = await getPrivate(signer, "/user/positions", fetchImpl);
  if (r.status !== 200) throw new Error(`Extended positions unavailable (${r.status})`);
  return parseExtendedPositions(r.data as RawExtendedPosition[] | undefined);
}
