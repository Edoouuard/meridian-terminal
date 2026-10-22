/**
 * hyperliquidTrade.ts — the live side of Hyperliquid trading: an agent key
 * the user approves once, market (IOC) orders on perps and spot, and the
 * reads they need. Signing and wire formats live in hyperliquidExchange.ts,
 * verified against the official SDK.
 *
 * The agent key is generated in the browser and kept in localStorage per
 * wallet and network. Hyperliquid lets an approved agent place and cancel
 * orders on the user's account; it can never move funds out. Approving it
 * is one wallet signature; every order after that is signed by the agent,
 * with no wallet popup (wallets can't sign Hyperliquid's chain-1337 orders).
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import {
  HL_WITHDRAW_FEE_USD,
  HYPE_WEI_DECIMALS,
  approveAgentAction,
  cDepositAction,
  tokenDelegateAction,
  vaultTransferAction,
  cancelAction,
  firstOrderError,
  isUnknownAgentError,
  l1TypedData,
  modifyAction,
  orderAction,
  orderWire,
  parseExchangeResponse,
  roundPrice,
  roundSize,
  splitSignature,
  triggerOrderWire,
  updateLeverageAction,
  usdClassTransferAction,
  withdrawAction,
  type ExchangeOutcome,
} from "@/lib/integrations/hyperliquidExchange";
import { HLP_VAULT_ADDRESS, hyperliquidEnv, type HyperliquidEnv } from "@/lib/integrations/hyperliquid-live";

export const AGENT_NAME = "meridian";
/** Market orders are IOC limits this far through the mid: they fill now or not at all. */
export const MARKET_SLIPPAGE = 0.05;

export async function infoPost<T>(env: HyperliquidEnv, body: object): Promise<T> {
  const res = await fetch(env.infoUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Hyperliquid info ${JSON.stringify(body).slice(0, 40)} failed: ${res.status}`);
  return (await res.json()) as T;
}

async function postExchange(env: HyperliquidEnv, payload: object): Promise<unknown> {
  const res = await fetch(env.exchangeUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  try {
    return await res.json();
  } catch {
    return { status: "err", response: `HTTP ${res.status}` };
  }
}

/* ─── Markets ────────────────────────────────────────────────────────── */

export interface PerpMarket {
  /** Order asset id: the universe index on the main dex, 110000 + dex slot × 10000 + index on a HIP-3 dex. */
  asset: number;
  szDecimals: number;
  maxLeverage: number;
  /** Market name as Hyperliquid lists it ("ETH", "xyz:TSLA"). */
  coin: string;
  /** "" for the main perp dex, else the HIP-3 dex name ("xyz"). */
  dex: string;
  /** Index in the dex's own universe (where its asset contexts sit). */
  index: number;
  /** Isolated margin only (many HIP-3 stock markets). */
  onlyIsolated: boolean;
}

type RawPerpMeta = { universe?: { name: string; szDecimals: number; maxLeverage: number; onlyIsolated?: boolean; isDelisted?: boolean }[]; collateralToken?: number };

/** Builder-deployed (HIP-3) perp dexes: the n-th one after the main dex starts at asset 110000 + (n − 1) × 10000. */
export function hip3AssetId(dexSlot: number, index: number): number {
  return 110000 + (dexSlot - 1) * 10000 + index;
}

/** "xyz:TSLA PERP" → { dex: "xyz", name: "TSLA" }; "ETH PERP" → { dex: undefined, name: "ETH" }. */
export function splitDexCoin(coin: string): { dex?: string; name: string } {
  const clean = coin.trim().replace(/[-\s]?PERP(ETUAL)?$/i, "").trim();
  const i = clean.indexOf(":");
  return i > 0 ? { dex: clean.slice(0, i).toLowerCase(), name: clean.slice(i + 1).toUpperCase() } : { name: clean.toUpperCase() };
}

/** Common names for HIP-3 stock, index and commodity markets. */
const HIP3_ALIASES: Record<string, string> = {
  SPX: "SP500", "S&P500": "SP500", "S&P 500": "SP500", SPY: "SP500",
  NASDAQ: "XYZ100", NDX: "XYZ100", QQQ: "XYZ100",
  OIL: "CL", WTI: "CL", CRUDE: "CL", BRENT: "BRENTOIL",
  XAU: "GOLD", XAG: "SILVER", GOOG: "GOOGL",
};

const perpDexCache = new Map<string, { at: number; names: (string | null)[] }>();

/** Perp dex names in Hyperliquid's order (slot 0 is the main dex), cached 5 minutes. */
export async function fetchPerpDexNames(env: HyperliquidEnv): Promise<(string | null)[]> {
  const hit = perpDexCache.get(env.infoUrl);
  if (hit && Date.now() - hit.at < 300_000) return hit.names;
  const raw = await infoPost<({ name: string } | null)[]>(env, { type: "perpDexs" }).catch(() => [null]);
  const names = (raw ?? [null]).map((d) => (d ? d.name : null));
  perpDexCache.set(env.infoUrl, { at: Date.now(), names });
  return names;
}

function marketFrom(meta: RawPerpMeta, wanted: string, dex: string, dexSlot: number): PerpMarket | null {
  const index = (meta.universe ?? []).findIndex((u) => u.name.toUpperCase() === wanted.toUpperCase() && !u.isDelisted);
  if (index < 0) return null;
  const u = meta.universe![index];
  return {
    asset: dex ? hip3AssetId(dexSlot, index) : index,
    szDecimals: u.szDecimals,
    maxLeverage: u.maxLeverage,
    coin: u.name,
    dex,
    index,
    onlyIsolated: !!u.onlyIsolated,
  };
}

/**
 * Resolve a perp market: the main dex first, then HIP-3 dexes collateralised
 * in USDC (stocks, indices, commodities: "TSLA", "SP500", "GOLD" or an
 * explicit "xyz:TSLA"). Dexes with another collateral (USDH, USDE, USDT0) are
 * skipped: Meridian funds perps with USDC.
 */
export async function fetchPerpMarket(env: HyperliquidEnv, coin: string): Promise<PerpMarket | null> {
  const { dex, name } = splitDexCoin(coin);
  if (!dex) {
    const main = marketFrom(await infoPost<RawPerpMeta>(env, { type: "meta" }), name, "", 0);
    if (main) return main;
  }
  const names = await fetchPerpDexNames(env);
  const target = HIP3_ALIASES[name] ?? name;
  for (let slot = 1; slot < names.length; slot++) {
    const d = names[slot];
    if (!d || (dex && d !== dex)) continue;
    const meta = await infoPost<RawPerpMeta>(env, { type: "meta", dex: d }).catch(() => null);
    if (!meta || (meta.collateralToken ?? 0) !== 0) continue;
    const m = marketFrom(meta, `${d}:${target}`, d, slot);
    if (m) return m;
  }
  return null;
}

export interface SpotMarket {
  /** 10000 + pair index: the asset id spot orders use. */
  asset: number;
  /** allMids / l2Book key ("@151", or "PURR/USDC"). */
  coin: string;
  szDecimals: number;
  tokenIndex: number;
  /** The token's HyperEVM contract, when it has one. */
  evmAddress?: Address;
}

interface SpotMetaRaw {
  tokens: { name: string; szDecimals: number; index: number; evmContract: { address: string } | null }[];
  universe: { name: string; tokens: [number, number]; index: number }[];
}

/** The base/USDC spot pair for a token (UETH, UBTC, HYPE…). */
export function spotMarketFrom(meta: SpotMetaRaw, base: string): SpotMarket | null {
  const token = meta.tokens.find((t) => t.name.toUpperCase() === base.toUpperCase());
  const usdc = meta.tokens.find((t) => t.name === "USDC");
  if (!token || !usdc) return null;
  const pair = meta.universe.find((u) => u.tokens[0] === token.index && u.tokens[1] === usdc.index);
  if (!pair) return null;
  return {
    asset: 10000 + pair.index,
    coin: pair.name,
    szDecimals: token.szDecimals,
    tokenIndex: token.index,
    evmAddress: (token.evmContract?.address as Address | undefined) ?? undefined,
  };
}

export async function fetchSpotMarket(env: HyperliquidEnv, base: string): Promise<SpotMarket | null> {
  return spotMarketFrom(await infoPost<SpotMetaRaw>(env, { type: "spotMeta" }), base);
}

export async function fetchMid(env: HyperliquidEnv, coin: string, dex = ""): Promise<number | null> {
  const mids = await infoPost<Record<string, string>>(env, dex ? { type: "allMids", dex } : { type: "allMids" });
  const v = Number(mids[coin]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** The user's spot balance of a token on HyperCore (what a spot order can sell). */
export async function fetchSpotBalance(env: HyperliquidEnv, user: Address, token: string): Promise<number> {
  const s = await infoPost<{ balances?: { coin: string; total: string; hold: string }[] }>(env, { type: "spotClearinghouseState", user });
  const b = (s.balances ?? []).find((x) => x.coin.toUpperCase() === token.toUpperCase());
  return b ? Math.max(0, Number(b.total) - Number(b.hold)) : 0;
}

/* ─── Agent ──────────────────────────────────────────────────────────── */

export interface StoredAgent {
  key: Hex;
  address: Address;
}

const agentStorageKey = (user: Address, env: HyperliquidEnv) => `meridian:hlAgent:${env.testnet ? "testnet" : "mainnet"}:${user.toLowerCase()}`;

export function loadAgent(user: Address, env: HyperliquidEnv): StoredAgent | null {
  try {
    const raw = window.localStorage.getItem(agentStorageKey(user, env));
    const a = raw ? (JSON.parse(raw) as StoredAgent) : null;
    return a?.key && a.address ? a : null;
  } catch {
    return null;
  }
}

function saveAgent(user: Address, env: HyperliquidEnv, agent: StoredAgent) {
  try {
    window.localStorage.setItem(agentStorageKey(user, env), JSON.stringify(agent));
  } catch {
    /* private mode: the agent is approved again next time */
  }
}

export function clearAgent(user: Address, env: HyperliquidEnv) {
  try {
    window.localStorage.removeItem(agentStorageKey(user, env));
  } catch {
    /* nothing stored */
  }
}

/** The wallet's EIP-712 signer (wagmi signTypedData). */
export type WalletSign = (
  typedData:
    | ReturnType<typeof approveAgentAction>["typedData"]
    | ReturnType<typeof withdrawAction>["typedData"]
    | ReturnType<typeof usdClassTransferAction>["typedData"]
    | ReturnType<typeof cDepositAction>["typedData"]
    | ReturnType<typeof tokenDelegateAction>["typedData"],
) => Promise<Hex>;

/** One wallet signature: approve a fresh agent key (replaces any earlier "meridian" agent). */
export async function approveAgent(p: { user: Address; env: HyperliquidEnv; walletSign: WalletSign; walletChainId: number }): Promise<StoredAgent> {
  const key = generatePrivateKey();
  const agent = privateKeyToAccount(key);
  const nonce = Date.now();
  const { action, typedData } = approveAgentAction({
    agentAddress: agent.address,
    agentName: AGENT_NAME,
    nonce,
    isMainnet: !p.env.testnet,
    signatureChainId: p.walletChainId,
  });
  const signature = splitSignature(await p.walletSign(typedData));
  const body = (await postExchange(p.env, { action, nonce, signature, vaultAddress: null })) as { status?: string; response?: unknown };
  if (body?.status !== "ok") {
    throw new Error(`Hyperliquid didn't approve the trading key: ${typeof body?.response === "string" ? body.response : JSON.stringify(body).slice(0, 160)}`);
  }
  const stored = { key, address: agent.address };
  saveAgent(p.user, p.env, stored);
  return stored;
}

async function sendL1(env: HyperliquidEnv, agentKey: Hex, action: object): Promise<ExchangeOutcome> {
  const nonce = Date.now();
  const sig = await privateKeyToAccount(agentKey).signTypedData(l1TypedData(action, nonce, !env.testnet) as never);
  return parseExchangeResponse(await postExchange(env, { action, nonce, signature: splitSignature(sig), vaultAddress: null }));
}

/**
 * Run L1 actions with the stored agent, approving one first if needed. When
 * Hyperliquid no longer knows the agent (revoked, other device), it is
 * approved again once and the actions are retried.
 */
export async function withAgent(
  p: { user: Address; env: HyperliquidEnv; walletSign: WalletSign; walletChainId: number; onApproving?: () => void },
  run: (agentKey: Hex) => Promise<ExchangeOutcome>,
): Promise<ExchangeOutcome> {
  let agent = loadAgent(p.user, p.env);
  if (!agent) {
    p.onApproving?.();
    agent = await approveAgent(p);
  }
  const out = await run(agent.key);
  if (!isUnknownAgentError(out.error)) return out;
  clearAgent(p.user, p.env);
  p.onApproving?.();
  agent = await approveAgent(p);
  return run(agent.key);
}

/* ─── Orders ─────────────────────────────────────────────────────────── */

export interface MarketOrderResult extends ExchangeOutcome {
  /** Mid price the order was priced from. */
  mid?: number;
  /** Size sent, in coin units. */
  size?: number;
  /** Stop-loss / take-profit placed after the fill, when asked. */
  protection?: { ok: boolean; error?: string; sl?: number; tp?: number };
}

/** Set leverage, cross unless the market is isolated-only. */
async function setLeverage(env: HyperliquidEnv, agentKey: Hex, market: PerpMarket, leverage: number): Promise<ExchangeOutcome> {
  const lev = Math.min(Math.max(1, Math.round(leverage)), market.maxLeverage);
  return sendL1(env, agentKey, updateLeverageAction(market.asset, lev, !market.onlyIsolated));
}

const dexAbstractionReady = new Set<string>();

/**
 * HIP-3 markets keep their own margin. Dex abstraction lets them draw on the
 * account's main USDC balance, so a stock perp trades from the same money as
 * ETH. Unified accounts already share it; otherwise the trading key turns it
 * on once (an agent action: no wallet popup).
 */
export async function ensureDexAbstraction(env: HyperliquidEnv, agentKey: Hex, user: Address): Promise<ExchangeOutcome> {
  const id = `${env.infoUrl}:${user.toLowerCase()}`;
  if (dexAbstractionReady.has(id)) return { ok: true };
  const [abstraction, enabled] = await Promise.all([
    infoPost<unknown>(env, { type: "userAbstraction", user }).catch(() => null),
    infoPost<unknown>(env, { type: "userDexAbstraction", user }).catch(() => null),
  ]);
  if (isUnifiedAbstraction(abstraction) || enabled === true) {
    dexAbstractionReady.add(id);
    return { ok: true };
  }
  const out = await sendL1(env, agentKey, { type: "agentEnableDexAbstraction" });
  if (out.ok) dexAbstractionReady.add(id);
  return out.ok ? out : { ok: false, error: `Couldn't link your Hyperliquid balance to stock and commodity markets: ${out.error}` };
}

/** Perp market order (IOC through the mid), with the leverage set first when asked. */
export async function perpMarketOrder(
  env: HyperliquidEnv,
  agentKey: Hex,
  o: {
    coin: string;
    isBuy: boolean;
    sizeUsd?: number;
    coinQty?: number;
    leverage?: number;
    reduceOnly?: boolean;
    stopLossPct?: number;
    takeProfitPct?: number;
    /** The account trading: needed to prepare a HIP-3 market's margin. */
    user?: Address;
  },
): Promise<MarketOrderResult> {
  const market = await fetchPerpMarket(env, o.coin);
  if (!market) return { ok: false, error: `${o.coin} isn't listed on Hyperliquid.` };
  const mid = await fetchMid(env, market.coin, market.dex);
  if (!mid) return { ok: false, error: `No live price for ${o.coin} on Hyperliquid.` };
  if (market.dex && o.user) {
    const ready = await ensureDexAbstraction(env, agentKey, o.user);
    if (!ready.ok) return { ...ready, mid };
  }
  if (!o.reduceOnly && (o.leverage || market.onlyIsolated)) {
    const set = await setLeverage(env, agentKey, market, o.leverage ?? 1);
    if (!set.ok) return { ...set, mid };
  }
  const size = roundSize(o.coinQty && o.coinQty > 0 ? o.coinQty : (o.sizeUsd ?? 0) / mid, market.szDecimals);
  if (!(size > 0)) return { ok: false, error: "Order size rounds to zero.", mid };
  const px = roundPrice(o.isBuy ? mid * (1 + MARKET_SLIPPAGE) : mid * (1 - MARKET_SLIPPAGE), market.szDecimals, false);
  const out = await sendL1(env, agentKey, orderAction([orderWire({ asset: market.asset, isBuy: o.isBuy, px, sz: size, reduceOnly: o.reduceOnly, tif: "Ioc" })]));
  if (!out.ok || !out.filled || o.reduceOnly || !(o.stopLossPct || o.takeProfitPct)) return { ...out, mid, size };
  // Protect what actually filled, priced from the real entry.
  const { sl, tp } = protectionPrices(out.filled.avgPx, o.isBuy, o);
  const placed = await placeProtection(env, agentKey, { asset: market.asset, szDecimals: market.szDecimals, isLong: o.isBuy, size: out.filled.totalSz, sl, tp });
  return { ...out, mid, size, protection: { ...placed, sl, tp } };
}

/**
 * Perp limit order at `px` (GTC: rests until filled or cancelled; ALO:
 * post-only, refused if it would take liquidity). Leverage is set first when asked.
 */
export async function perpLimitOrder(
  env: HyperliquidEnv,
  agentKey: Hex,
  o: { coin: string; isBuy: boolean; px: number; sizeUsd?: number; coinQty?: number; leverage?: number; reduceOnly?: boolean; postOnly?: boolean; user?: Address },
): Promise<MarketOrderResult> {
  const market = await fetchPerpMarket(env, o.coin);
  if (!market) return { ok: false, error: `${o.coin} isn't listed on Hyperliquid.` };
  if (!(o.px > 0)) return { ok: false, error: "Set a limit price." };
  if (market.dex && o.user) {
    const ready = await ensureDexAbstraction(env, agentKey, o.user);
    if (!ready.ok) return ready;
  }
  if (!o.reduceOnly && (o.leverage || market.onlyIsolated)) {
    const set = await setLeverage(env, agentKey, market, o.leverage ?? 1);
    if (!set.ok) return set;
  }
  const px = roundPrice(o.px, market.szDecimals, false);
  const size = roundSize(o.coinQty && o.coinQty > 0 ? o.coinQty : (o.sizeUsd ?? 0) / px, market.szDecimals);
  if (!(size > 0)) return { ok: false, error: "Order size rounds to zero." };
  if (size * px < HL_MIN_ORDER_USD) return { ok: false, error: `Hyperliquid's minimum order is $${HL_MIN_ORDER_USD}.` };
  const out = await sendL1(env, agentKey, orderAction([orderWire({ asset: market.asset, isBuy: o.isBuy, px, sz: size, reduceOnly: o.reduceOnly, tif: o.postOnly ? "Alo" : "Gtc" })]));
  return { ...out, mid: px, size };
}

/** Best bid and ask on a perp market's book (null when a side is empty or the read fails). */
export async function fetchBestBidAsk(env: HyperliquidEnv, coin: string): Promise<{ bid: number; ask: number } | null> {
  const market = await fetchPerpMarket(env, coin).catch(() => null);
  if (!market) return null;
  const book = await infoPost<{ levels?: { px: string }[][] }>(env, { type: "l2Book", coin: market.coin }).catch(() => null);
  return parseBestBidAsk(book);
}

export function parseBestBidAsk(book: { levels?: { px: string }[][] } | null): { bid: number; ask: number } | null {
  const bid = Number(book?.levels?.[0]?.[0]?.px);
  const ask = Number(book?.levels?.[1]?.[0]?.px);
  return bid > 0 && ask > 0 && ask >= bid ? { bid, ask } : null;
}

/** A reduce-only stop-loss on an open position, `stopLossPct` from `entry`. */
export async function protectPosition(
  env: HyperliquidEnv,
  agentKey: Hex,
  o: { coin: string; isLong: boolean; size: number; entry: number; stopLossPct: number },
): Promise<ExchangeOutcome> {
  const market = await fetchPerpMarket(env, o.coin);
  if (!market) return { ok: false, error: `${o.coin} isn't listed on Hyperliquid.` };
  const { sl } = protectionPrices(o.entry, o.isLong, { stopLossPct: o.stopLossPct });
  return placeProtection(env, agentKey, { asset: market.asset, szDecimals: market.szDecimals, isLong: o.isLong, size: o.size, sl });
}

/** Cancel a resting order (limit, stop-loss or take-profit). */
export async function cancelPerpOrder(env: HyperliquidEnv, agentKey: Hex, o: { coin: string; oid: number }): Promise<ExchangeOutcome> {
  const market = await fetchPerpMarket(env, o.coin);
  if (!market) return { ok: false, error: `${o.coin} isn't listed on Hyperliquid.` };
  const out = await sendL1(env, agentKey, cancelAction([{ asset: market.asset, oid: o.oid }]));
  return out;
}

/**
 * Cancel the reduce-only trigger orders (stop-loss, take-profit) left on a
 * coin once its position is closed: a leftover stop would otherwise act on
 * the next position opened on the coin.
 */
export async function cancelTriggerOrders(env: HyperliquidEnv, agentKey: Hex, o: { user: Address; coin: string }): Promise<ExchangeOutcome> {
  const market = await fetchPerpMarket(env, o.coin);
  if (!market) return { ok: false, error: `${o.coin} isn't listed on Hyperliquid.` };
  type Row = { coin?: string; oid?: number; isTrigger?: boolean; reduceOnly?: boolean };
  const rows = await infoPost<Row[]>(env, market.dex ? { type: "frontendOpenOrders", user: o.user, dex: market.dex } : { type: "frontendOpenOrders", user: o.user });
  const stale = (rows ?? []).filter((r) => r.coin === market.coin && r.isTrigger && r.reduceOnly && typeof r.oid === "number");
  if (stale.length === 0) return { ok: true };
  return sendL1(env, agentKey, cancelAction(stale.map((r) => ({ asset: market.asset, oid: r.oid as number }))));
}

/** Move a resting limit order to a new price, same side and size. */
export async function modifyPerpLimit(
  env: HyperliquidEnv,
  agentKey: Hex,
  o: { coin: string; oid: number; isBuy: boolean; size: number; px: number; reduceOnly?: boolean },
): Promise<ExchangeOutcome> {
  const market = await fetchPerpMarket(env, o.coin);
  if (!market) return { ok: false, error: `${o.coin} isn't listed on Hyperliquid.` };
  const px = roundPrice(o.px, market.szDecimals, false);
  const wire = orderWire({ asset: market.asset, isBuy: o.isBuy, px, sz: roundSize(o.size, market.szDecimals), reduceOnly: o.reduceOnly, tif: "Gtc" });
  return sendL1(env, agentKey, modifyAction(o.oid, wire));
}

/** Sell a spot token for USDC at market (IOC through the mid), at most what the account holds. */
export async function spotMarketSell(env: HyperliquidEnv, agentKey: Hex, o: { user: Address; base: string; amount?: number }): Promise<MarketOrderResult> {
  const market = await fetchSpotMarket(env, o.base);
  if (!market) return { ok: false, error: `No ${o.base}/USDC spot market on Hyperliquid.` };
  const mid = await fetchMid(env, market.coin);
  if (!mid) return { ok: false, error: `No live price for ${o.base} on Hyperliquid.` };
  const held = await fetchSpotBalance(env, o.user, o.base);
  const size = roundSize(Math.min(o.amount ?? held, held), market.szDecimals, true);
  if (!(size > 0)) return { ok: false, error: `No ${o.base} in your Hyperliquid spot balance yet.`, mid };
  const px = roundPrice(mid * (1 - MARKET_SLIPPAGE), market.szDecimals, true);
  const out = await sendL1(env, agentKey, orderAction([orderWire({ asset: market.asset, isBuy: false, px, sz: size, tif: "Ioc" })]));
  return { ...out, mid, size };
}

/**
 * Spot buy size for `usd` of a token at `mid`, capped by the free spot USDC
 * (with the slippage bound reserved, so the IOC can't ask for more USDC than
 * the account has). Rounded down to the token's size step.
 */
export function planSpotBuy(p: { usd: number; mid: number; spotUsdc: number; szDecimals: number }): { size: number; usd: number } {
  const spendable = Math.min(p.usd, p.spotUsdc / (1 + MARKET_SLIPPAGE));
  const size = roundSize(Math.max(0, spendable) / p.mid, p.szDecimals, true);
  return { size, usd: size * p.mid };
}

/** Buy a spot token (UETH, UBTC…) with USDC from the Hyperliquid spot balance at market (IOC through the mid). */
export async function spotMarketBuy(env: HyperliquidEnv, agentKey: Hex, o: { user: Address; base: string; usd: number }): Promise<MarketOrderResult> {
  const market = await fetchSpotMarket(env, o.base);
  if (!market) return { ok: false, error: `No ${o.base}/USDC spot market on Hyperliquid.` };
  const mid = await fetchMid(env, market.coin);
  if (!mid) return { ok: false, error: `No live price for ${o.base} on Hyperliquid.` };
  const spotUsdc = await fetchSpotBalance(env, o.user, "USDC");
  const plan = planSpotBuy({ usd: o.usd, mid, spotUsdc, szDecimals: market.szDecimals });
  if (plan.usd < HL_MIN_ORDER_USD) {
    return { ok: false, error: `Only $${spotUsdc.toFixed(2)} USDC free in your Hyperliquid spot balance; Hyperliquid's minimum order is $${HL_MIN_ORDER_USD}.`, mid };
  }
  const px = roundPrice(mid * (1 + MARKET_SLIPPAGE), market.szDecimals, true);
  const out = await sendL1(env, agentKey, orderAction([orderWire({ asset: market.asset, isBuy: true, px, sz: plan.size, tif: "Ioc" })]));
  return { ...out, mid, size: plan.size };
}

/* ─── Perp context, margin and protection ────────────────────────────── */

export interface PerpContext extends PerpMarket {
  mark: number;
  /** Hourly funding rate (positive: longs pay shorts). */
  fundingHourly: number;
}

/** A perp's market, mark price and funding, in one read (main dex or HIP-3). */
export async function fetchPerpContext(env: HyperliquidEnv, coin: string): Promise<PerpContext | null> {
  const market = await fetchPerpMarket(env, coin);
  if (!market) return null;
  const [, ctxs] = await infoPost<[unknown, { markPx?: string; midPx?: string | null; funding?: string }[]]>(
    env,
    market.dex ? { type: "metaAndAssetCtxs", dex: market.dex } : { type: "metaAndAssetCtxs" },
  );
  const c = ctxs?.[market.index] ?? {};
  const mark = Number(c.midPx ?? c.markPx);
  return { ...market, mark: Number.isFinite(mark) ? mark : 0, fundingHourly: Number(c.funding ?? 0) || 0 };
}

/** Funding an open position earns (+) or pays (−) per year, in % of notional. */
export function fundingAprForSide(fundingHourly: number, isLong: boolean): number {
  return (isLong ? -1 : 1) * fundingHourly * 24 * 365 * 100;
}

/** The user's free margin and open position on one coin. */
export interface PerpAccount {
  /** USDC a new order can use as margin now. */
  freeMargin: number;
  /** Free USDC in the spot balance (movable to perps outside unified mode). */
  spotUsdc: number;
  unified: boolean;
  /** Signed size of the open position on the coin (negative: short). */
  position: number;
}

export async function fetchPerpAccount(env: HyperliquidEnv, user: Address, coin: string): Promise<PerpAccount> {
  const market = await fetchPerpMarket(env, coin).catch(() => null);
  const dex = market?.dex ?? "";
  type Ch = { withdrawable?: string; assetPositions?: { position?: { coin?: string; szi?: string } }[] };
  const [ch, dexCh, spotUsdc, abstraction] = await Promise.all([
    infoPost<Ch>(env, { type: "clearinghouseState", user }),
    dex ? infoPost<Ch>(env, { type: "clearinghouseState", user, dex }).catch(() => ({}) as Ch) : Promise.resolve(null),
    fetchSpotBalance(env, user, "USDC"),
    infoPost<unknown>(env, { type: "userAbstraction", user }).catch(() => null),
  ]);
  const unified = isUnifiedAbstraction(abstraction);
  const perps = Math.max(0, Number(ch.withdrawable ?? 0));
  const main = unified ? Math.max(perps, spotUsdc) : perps;
  // A HIP-3 market draws on the main balance (dex abstraction) plus what already sits on its dex.
  const freeMargin = dexCh ? main + Math.max(0, Number(dexCh.withdrawable ?? 0)) : main;
  const name = (market?.coin ?? splitDexCoin(coin).name).toUpperCase();
  const pos = ((dexCh ?? ch).assetPositions ?? []).find((p) => p.position?.coin?.toUpperCase() === name);
  return { freeMargin, spotUsdc, unified, position: Number(pos?.position?.szi ?? 0) || 0 };
}

/** Margin an order needs: notional / leverage, plus 2% for the fill's slippage and fees. */
export function marginNeededUsd(sizeUsd: number, leverage: number | undefined): number {
  return (sizeUsd / Math.max(1, leverage ?? 1)) * 1.02;
}

/**
 * The notional an order can open with `freeMargin`: the asked size when the
 * margin covers it (buffer included), else the most the margin allows when the
 * shortfall is only the buffer or rounding (≤ 5% or $3) — the deposit landed,
 * a few cents of fees shouldn't block it. Undefined: genuinely short of margin.
 */
export function fitNotionalToMargin(sizeUsd: number, leverage: number | undefined, freeMargin: number): number | undefined {
  const needed = marginNeededUsd(sizeUsd, leverage);
  if (freeMargin >= needed) return sizeUsd;
  if (needed - freeMargin > Math.max(3, needed * 0.05)) return undefined;
  return Math.floor(((freeMargin * Math.max(1, leverage ?? 1)) / 1.02) * 100) / 100;
}

/** Stop-loss and take-profit prices `pct`% away from the entry, on the losing / winning side. */
export function protectionPrices(entry: number, isLong: boolean, p: { stopLossPct?: number; takeProfitPct?: number }): { sl?: number; tp?: number } {
  const away = (pct: number, up: boolean) => entry * (1 + ((up ? 1 : -1) * pct) / 100);
  return {
    sl: p.stopLossPct && p.stopLossPct > 0 ? away(p.stopLossPct, !isLong) : undefined,
    tp: p.takeProfitPct && p.takeProfitPct > 0 ? away(p.takeProfitPct, isLong) : undefined,
  };
}

/**
 * Reduce-only stop-loss / take-profit trigger orders for a position of
 * `size` coins (market when triggered, at most 10% through the trigger).
 */
export async function placeProtection(
  env: HyperliquidEnv,
  agentKey: Hex,
  o: { asset: number; szDecimals: number; isLong: boolean; size: number; sl?: number; tp?: number },
): Promise<{ ok: boolean; error?: string }> {
  const close = !o.isLong; // closing a long sells, closing a short buys
  const wires = (
    [
      ["sl", o.sl],
      ["tp", o.tp],
    ] as const
  )
    .filter((x): x is readonly ["sl" | "tp", number] => typeof x[1] === "number" && x[1] > 0)
    .map(([tpsl, trigger]) => {
      const triggerPx = roundPrice(trigger, o.szDecimals, false);
      const px = roundPrice(close ? triggerPx * 1.1 : triggerPx * 0.9, o.szDecimals, false);
      return triggerOrderWire({ asset: o.asset, isBuy: close, px, sz: roundSize(o.size, o.szDecimals, true), triggerPx, tpsl });
    });
  if (wires.length === 0) return { ok: true };
  const nonce = Date.now();
  const action = orderAction(wires);
  const sig = await privateKeyToAccount(agentKey).signTypedData(l1TypedData(action, nonce, !env.testnet) as never);
  const error = firstOrderError(await postExchange(env, { action, nonce, signature: splitSignature(sig), vaultAddress: null }));
  return error ? { ok: false, error } : { ok: true };
}

/** Move USDC from the spot balance to perps margin, or back with `toSpot` (one wallet signature; not for unified accounts). */
export async function moveSpotUsdcToPerps(p: { env: HyperliquidEnv; walletSign: WalletSign; walletChainId: number; amount: number; toSpot?: boolean }): Promise<{ ok: boolean; error?: string }> {
  const nonce = Date.now();
  const { action, typedData } = usdClassTransferAction({ amount: usdc2(p.amount), toPerp: !p.toSpot, nonce, isMainnet: !p.env.testnet, signatureChainId: p.walletChainId });
  const signature = splitSignature(await p.walletSign(typedData));
  const out = parseExchangeResponse(await postExchange(p.env, { action, nonce, signature, vaultAddress: null }));
  return out.ok ? { ok: true } : { ok: false, error: out.error };
}

/* ─── Withdraw to Arbitrum ───────────────────────────────────────────── */

/** Unified and portfolio-margin accounts hold one USDC balance for spot and perps. */
export const isUnifiedAbstraction = (abstraction: unknown) => abstraction === "unifiedAccount" || abstraction === "portfolioMargin";

/**
 * USDC the account can withdraw now (perps `withdrawable`), free USDC in the
 * spot balance, and whether the account is unified (spot and perps share one
 * USDC balance: no spot → perps transfer exists, withdraw3 draws on it directly).
 */
export async function fetchWithdrawable(env: HyperliquidEnv, user: Address): Promise<{ perps: number; spotUsdc: number; unified: boolean }> {
  const [ch, spotUsdc, abstraction] = await Promise.all([
    infoPost<{ withdrawable?: string }>(env, { type: "clearinghouseState", user }),
    fetchSpotBalance(env, user, "USDC"),
    infoPost<unknown>(env, { type: "userAbstraction", user }).catch(() => null),
  ]);
  return { perps: Math.max(0, Number(ch.withdrawable ?? 0)), spotUsdc, unified: isUnifiedAbstraction(abstraction) };
}

/** What a withdrawal can take right now: one shared balance in a unified account, perps (+ spot after a transfer) otherwise. */
export function withdrawableUsd(b: { perps: number; spotUsdc: number; unified: boolean }): number {
  return b.unified ? Math.max(b.perps, b.spotUsdc) : b.perps + b.spotUsdc;
}

const usdc2 = (x: number) => (Math.floor(x * 100 + 1e-9) / 100).toFixed(2);

export interface WithdrawResult {
  ok: boolean;
  /** USDC requested out of Hyperliquid (Hyperliquid takes its $1 fee from it). */
  amount?: number;
  error?: string;
}

/**
 * Withdraw up to `amount` USDC from the Hyperliquid account to the same
 * address on Arbitrum. When the perps balance (the only withdrawable one
 * outside unified mode) is short and USDC sits in spot, it is moved to perps
 * first. Each step is one wallet signature; nothing is retried silently.
 */
export async function withdrawUsdcToArbitrum(p: {
  user: Address;
  env: HyperliquidEnv;
  walletSign: WalletSign;
  walletChainId: number;
  amount: number;
  onStep?: (step: "moving" | "withdrawing") => void;
}): Promise<WithdrawResult> {
  const isMainnet = !p.env.testnet;
  const balances = await fetchWithdrawable(p.env, p.user);
  const { perps, spotUsdc } = balances;
  // Unified account: spot and perps are one balance; withdraw3 takes from it, a class transfer is refused.
  let available = balances.unified ? withdrawableUsd(balances) : perps;
  if (!balances.unified && available < p.amount && spotUsdc > 0) {
    const move = Number(usdc2(Math.min(p.amount - available, spotUsdc)));
    if (move > 0) {
      p.onStep?.("moving");
      const nonce = Date.now();
      const { action, typedData } = usdClassTransferAction({ amount: usdc2(move), toPerp: true, nonce, isMainnet, signatureChainId: p.walletChainId });
      const signature = splitSignature(await p.walletSign(typedData));
      const out = parseExchangeResponse(await postExchange(p.env, { action, nonce, signature, vaultAddress: null }));
      // Some accounts report the mode only through this refusal: treat it as unified and withdraw directly.
      if (!out.ok && /unified/i.test(out.error ?? "")) available = Math.max(perps, spotUsdc);
      else if (!out.ok) return { ok: false, error: `Couldn't move USDC from spot to perps: ${out.error}` };
      else available += move;
    }
  }
  const amount = Number(usdc2(Math.min(p.amount, available)));
  if (!(amount > HL_WITHDRAW_FEE_USD)) {
    return { ok: false, error: `Only $${available.toFixed(2)} is withdrawable on Hyperliquid; a withdrawal must exceed the $${HL_WITHDRAW_FEE_USD} fee.` };
  }
  p.onStep?.("withdrawing");
  const time = Date.now();
  const { action, typedData } = withdrawAction({ destination: p.user, amount: usdc2(amount), time, isMainnet, signatureChainId: p.walletChainId });
  const signature = splitSignature(await p.walletSign(typedData));
  const out = parseExchangeResponse(await postExchange(p.env, { action, nonce: time, signature, vaultAddress: null }));
  return out.ok ? { ok: true, amount } : { ok: false, error: out.error };
}

/* ─── HLP deposit and HYPE staking ───────────────────────────────────── */

/** HLP deposits are locked this long before they can be withdrawn. */
export const HLP_LOCKUP_DAYS = 4;
/** Staked HYPE takes this long to come back to spot after undelegating (Hyperliquid's unstaking queue). */
export const HYPE_UNSTAKE_DAYS = 7;

/**
 * Deposit USDC from the Hyperliquid account into HLP (vaultTransfer, signed by
 * the trading key). Outside unified mode HLP draws on perps margin, so USDC in
 * spot is moved to perps first (one wallet signature).
 */
export async function depositToHlp(p: {
  user: Address;
  env: HyperliquidEnv;
  walletSign: WalletSign;
  walletChainId: number;
  usd: number;
  onStep?: (step: "approving" | "moving" | "depositing") => void;
}): Promise<{ ok: boolean; amount?: number; error?: string }> {
  const balances = await fetchWithdrawable(p.env, p.user);
  let available = balances.unified ? withdrawableUsd(balances) : balances.perps;
  if (!balances.unified && available < p.usd && balances.spotUsdc > 0) {
    p.onStep?.("moving");
    const move = Number(usdc2(Math.min(p.usd - available, balances.spotUsdc)));
    const moved = move > 0 ? await moveSpotUsdcToPerps({ env: p.env, walletSign: p.walletSign, walletChainId: p.walletChainId, amount: move }) : { ok: true };
    if (!moved.ok) return { ok: false, error: `Couldn't move USDC from spot to perps: ${moved.error}` };
    available += move;
  }
  const amount = Number(usdc2(Math.min(p.usd, available)));
  if (!(amount >= 1)) return { ok: false, error: `Only $${available.toFixed(2)} of USDC is free in your Hyperliquid account.` };
  const out = await withAgent({ ...p, onApproving: () => p.onStep?.("approving") }, (key) => {
    p.onStep?.("depositing");
    return sendL1(p.env, key, vaultTransferAction({ vaultAddress: HLP_VAULT_ADDRESS as Address, isDeposit: true, usd: Math.round(amount * 1e6) }));
  });
  return out.ok ? { ok: true, amount } : { ok: false, error: out.error };
}

export interface ValidatorSummary {
  validator: Address;
  name: string;
  stake: number;
  commission: number;
  isActive: boolean;
  isJailed: boolean;
}

export function parseValidators(raw: unknown): ValidatorSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v) => ({
      validator: String(v?.validator ?? "") as Address,
      name: String(v?.name ?? "validator"),
      stake: Number(v?.stake ?? 0),
      commission: Number(v?.commission ?? 1),
      isActive: v?.isActive === true,
      isJailed: v?.isJailed === true,
    }))
    .filter((v) => /^0x[0-9a-fA-F]{40}$/.test(v.validator) && Number.isFinite(v.stake) && Number.isFinite(v.commission));
}

/** Where to delegate by default: an active, unjailed validator with a commission of 5% or less, the most staked first. */
export function pickValidator(list: ValidatorSummary[]): ValidatorSummary | undefined {
  return list.filter((v) => v.isActive && !v.isJailed && v.commission <= 0.05).sort((a, b) => b.stake - a.stake)[0];
}

export async function fetchValidators(env: HyperliquidEnv): Promise<ValidatorSummary[]> {
  return parseValidators(await infoPost<unknown>(env, { type: "validatorSummaries" }));
}

/**
 * Stake HYPE from the Hyperliquid spot balance: move it to staking
 * (cDeposit), then delegate it to a validator (tokenDelegate). Two wallet
 * signatures, no gas. Rewards accrue from the delegation; getting HYPE back
 * takes Hyperliquid's 7-day unstaking queue.
 */
export async function stakeHype(p: {
  user: Address;
  env: HyperliquidEnv;
  walletSign: WalletSign;
  walletChainId: number;
  amount: number;
  validator: Address;
  onStep?: (step: "depositing" | "delegating") => void;
}): Promise<{ ok: boolean; amount?: number; error?: string }> {
  const spot = await fetchSpotBalance(p.env, p.user, "HYPE");
  const amount = Math.floor(Math.min(p.amount, spot) * 1e4) / 1e4;
  if (!(amount > 0)) return { ok: false, error: "No HYPE in your Hyperliquid spot balance to stake. HYPE on HyperEVM has to be moved to HyperCore spot first." };
  const wei = Math.round(amount * 10 ** HYPE_WEI_DECIMALS);
  const isMainnet = !p.env.testnet;
  p.onStep?.("depositing");
  const n1 = Date.now();
  const dep = cDepositAction({ wei, nonce: n1, isMainnet, signatureChainId: p.walletChainId });
  const r1 = parseExchangeResponse(await postExchange(p.env, { action: dep.action, nonce: n1, signature: splitSignature(await p.walletSign(dep.typedData)), vaultAddress: null }));
  if (!r1.ok) return { ok: false, error: `Couldn't move HYPE to staking: ${r1.error}` };
  p.onStep?.("delegating");
  const n2 = Date.now() + 1;
  const del = tokenDelegateAction({ validator: p.validator, wei, isUndelegate: false, nonce: n2, isMainnet, signatureChainId: p.walletChainId });
  const r2 = parseExchangeResponse(await postExchange(p.env, { action: del.action, nonce: n2, signature: splitSignature(await p.walletSign(del.typedData)), vaultAddress: null }));
  if (!r2.ok) return { ok: false, error: `HYPE is in your staking balance but the delegation failed (${r2.error}). Delegate it from the Hyperliquid app or try again.` };
  return { ok: true, amount };
}

/** Hyperliquid refuses orders under $10 of notional. */
export const HL_MIN_ORDER_USD = 10;

/**
 * How much of a token to move from HyperEVM and to sell, for a sell of
 * `target` (undefined: everything). Amounts are floored to the spot market's
 * size step, so what lands on HyperCore is exactly sellable (finer EVM units
 * would be lost in the transfer). Within 3% of the whole holding, the whole
 * holding is sold rather than leaving dust.
 */
export function planSpotSell(p: { target?: number; core: number; evm: number; szDecimals: number }): { move: number; sell: number } {
  const total = p.core + p.evm;
  const want = p.target === undefined || p.target >= total * 0.97 ? total : Math.max(0, p.target);
  const move = roundSize(Math.min(p.evm, Math.max(0, want - p.core)), p.szDecimals, true);
  const sell = roundSize(Math.min(want, p.core + move), p.szDecimals, true);
  return { move, sell };
}

export { hyperliquidEnv };
