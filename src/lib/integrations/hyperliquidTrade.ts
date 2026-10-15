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
  approveAgentAction,
  isUnknownAgentError,
  l1TypedData,
  orderAction,
  orderWire,
  parseExchangeResponse,
  roundPrice,
  roundSize,
  splitSignature,
  updateLeverageAction,
  usdClassTransferAction,
  withdrawAction,
  type ExchangeOutcome,
} from "@/lib/integrations/hyperliquidExchange";
import { hyperliquidEnv, type HyperliquidEnv } from "@/lib/integrations/hyperliquid-live";

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
  asset: number;
  szDecimals: number;
  maxLeverage: number;
}

export async function fetchPerpMarket(env: HyperliquidEnv, coin: string): Promise<PerpMarket | null> {
  const meta = await infoPost<{ universe?: { name: string; szDecimals: number; maxLeverage: number }[] }>(env, { type: "meta" });
  const name = coin.toUpperCase().replace(/[-\s]?PERP$/, "");
  const asset = (meta.universe ?? []).findIndex((u) => u.name.toUpperCase() === name);
  if (asset < 0) return null;
  const u = meta.universe![asset];
  return { asset, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage };
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

export async function fetchMid(env: HyperliquidEnv, coin: string): Promise<number | null> {
  const mids = await infoPost<Record<string, string>>(env, { type: "allMids" });
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
    | ReturnType<typeof usdClassTransferAction>["typedData"],
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
}

/** Perp market order (IOC through the mid), with the leverage set first when asked. */
export async function perpMarketOrder(
  env: HyperliquidEnv,
  agentKey: Hex,
  o: { coin: string; isBuy: boolean; sizeUsd?: number; coinQty?: number; leverage?: number; reduceOnly?: boolean },
): Promise<MarketOrderResult> {
  const market = await fetchPerpMarket(env, o.coin);
  if (!market) return { ok: false, error: `${o.coin} isn't listed on Hyperliquid.` };
  const mid = await fetchMid(env, o.coin.toUpperCase().replace(/[-\s]?PERP$/, ""));
  if (!mid) return { ok: false, error: `No live price for ${o.coin} on Hyperliquid.` };
  if (o.leverage && !o.reduceOnly) {
    const lev = Math.min(Math.max(1, Math.round(o.leverage)), market.maxLeverage);
    const set = await sendL1(env, agentKey, updateLeverageAction(market.asset, lev));
    if (!set.ok) return { ...set, mid };
  }
  const size = roundSize(o.coinQty && o.coinQty > 0 ? o.coinQty : (o.sizeUsd ?? 0) / mid, market.szDecimals);
  if (!(size > 0)) return { ok: false, error: "Order size rounds to zero.", mid };
  const px = roundPrice(o.isBuy ? mid * (1 + MARKET_SLIPPAGE) : mid * (1 - MARKET_SLIPPAGE), market.szDecimals, false);
  const out = await sendL1(env, agentKey, orderAction([orderWire({ asset: market.asset, isBuy: o.isBuy, px, sz: size, reduceOnly: o.reduceOnly, tif: "Ioc" })]));
  return { ...out, mid, size };
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
