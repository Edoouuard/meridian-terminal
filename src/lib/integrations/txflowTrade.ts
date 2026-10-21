/**
 * txflowTrade.ts — trading on TxFlow from the browser.
 *
 * The wallet signs once to approve a Meridian trading key (`approveAgent`,
 * direct EIP-712 on the wallet's chain); that key, generated and kept in this
 * browser, then signs every order. It can trade, never withdraw: withdrawals
 * (`withdraw3`) are signed by the wallet itself.
 *
 * An order's response only says the transaction executed, not what filled, so
 * a market order reads the position before and after: the fill is the change
 * in size. Market orders are IOC limit orders priced 1% through the mark, on
 * the market's tick. Any refusal surfaces as an error, never a fake success.
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import {
  TXFLOW_MIN_WITHDRAW_USD,
  isUnauthorizedAgent,
  parseTxflowResponse,
  priceOnTick,
  sizeToWire,
  txflowAgentTypedData,
  txflowApproveAgent,
  txflowLeverageAction,
  txflowOrderAction,
  txflowOrderBody,
  txflowSignature,
  txflowWithdraw,
  type TxflowNetwork,
  type TxflowOutcome,
} from "@/lib/integrations/txflowExchange";
import { TXFLOW_NETWORK, fetchTxflowAccount, fetchTxflowCtx, fetchTxflowMarkets, findTxflowMarket, txflowUrl, type TxflowMarket } from "@/lib/integrations/txflow-live";
import { TXFLOW_API_VERSION_HEADER } from "@/lib/integrations/txflowExchange";

/** Market orders cross the mark by this much (IOC: fills now within it, or not at all). */
export const TXFLOW_SLIPPAGE = 0.01;
const AGENT_NAME = "meridian";

/** The wallet's EIP-712 signer (wagmi signTypedData). */
export type TxflowWalletSign = (typedData: ReturnType<typeof txflowApproveAgent>["typedData"] | ReturnType<typeof txflowWithdraw>["typedData"]) => Promise<Hex>;

async function postExchange(network: TxflowNetwork, envelope: Record<string, unknown>): Promise<TxflowOutcome> {
  const res = await fetch(txflowUrl(network, "exchange"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-version": TXFLOW_API_VERSION_HEADER },
    body: JSON.stringify(envelope),
    cache: "no-store",
  });
  return parseTxflowResponse(await res.json().catch(() => null), res.status);
}

/* ─── Trading key ────────────────────────────────────────────────────── */

export interface TxflowAgent {
  key: Hex;
  address: Address;
}

const agentKey = (user: Address, network: TxflowNetwork) => `meridian:txflowAgent:${network}:${user.toLowerCase()}`;

export function loadTxflowAgent(user: Address, network: TxflowNetwork = TXFLOW_NETWORK): TxflowAgent | null {
  try {
    const raw = window.localStorage.getItem(agentKey(user, network));
    const a = raw ? (JSON.parse(raw) as TxflowAgent) : null;
    return a?.key && a.address ? a : null;
  } catch {
    return null;
  }
}

function saveTxflowAgent(user: Address, network: TxflowNetwork, agent: TxflowAgent | null) {
  try {
    if (agent) window.localStorage.setItem(agentKey(user, network), JSON.stringify(agent));
    else window.localStorage.removeItem(agentKey(user, network));
  } catch {
    /* private mode: the key is approved again next time */
  }
}

/** One wallet signature: authorize a fresh trading key (it replaces the earlier "meridian" key). */
export async function approveTxflowAgent(p: { user: Address; walletSign: TxflowWalletSign; walletChainId: number; network?: TxflowNetwork }): Promise<TxflowAgent> {
  const network = p.network ?? TXFLOW_NETWORK;
  const key = generatePrivateKey();
  const agent = privateKeyToAccount(key);
  const nonce = Date.now();
  const { action, typedData, signatureChainId } = txflowApproveAgent({ network, agentAddress: agent.address, agentName: AGENT_NAME, nonce, walletChainId: p.walletChainId });
  const signature = txflowSignature(await p.walletSign(typedData));
  const out = await postExchange(network, { action, signature, nonce, vaultAddress: null, signatureChainId, confirm: "executed" });
  if (!out.ok) throw new Error(`TxFlow didn't approve the trading key: ${out.error}`);
  const stored = { key, address: agent.address };
  saveTxflowAgent(p.user, network, stored);
  return stored;
}

async function sendAgentAction(network: TxflowNetwork, key: Hex, action: { type: string } & Record<string, unknown>): Promise<TxflowOutcome> {
  const nonce = Date.now();
  const sig = await privateKeyToAccount(key).signTypedData(txflowAgentTypedData(action, nonce, network));
  return postExchange(network, { action, signature: txflowSignature(sig), nonce, vaultAddress: null, signatureChainId: null, confirm: "executed" });
}

/**
 * Run agent-signed actions with the stored key, approving one first when
 * there is none. A key TxFlow no longer knows (revoked, other device) is
 * approved again once and the actions retried.
 */
export async function withTxflowAgent<T extends TxflowOutcome>(
  p: { user: Address; walletSign: TxflowWalletSign; walletChainId: number; network?: TxflowNetwork; onApproving?: () => void },
  run: (agentKey: Hex) => Promise<T>,
): Promise<T> {
  const network = p.network ?? TXFLOW_NETWORK;
  let agent = loadTxflowAgent(p.user, network);
  if (!agent) {
    p.onApproving?.();
    agent = await approveTxflowAgent(p);
  }
  const out = await run(agent.key);
  if (!isUnauthorizedAgent(out.error)) return out;
  saveTxflowAgent(p.user, network, null);
  p.onApproving?.();
  agent = await approveTxflowAgent(p);
  return run(agent.key);
}

/* ─── Orders ─────────────────────────────────────────────────────────── */

export interface TxflowFillResult extends TxflowOutcome {
  market?: TxflowMarket;
  /** Base quantity filled and its price (the entry for a new position, else the mark). */
  filled?: { totalSz: number; avgPx: number };
}

/** Size the order: an exact base quantity, or USD over the mark; on szDecimals, rounded down. */
export function txflowOrderSize(p: { sizeUsd?: number; coinQty?: number; mark: number; szDecimals: number }): string {
  const raw = p.coinQty && p.coinQty > 0 ? p.coinQty : (p.sizeUsd ?? 0) / p.mark;
  return sizeToWire(raw, p.szDecimals);
}

/** The IOC limit price: through the mark by the slippage, on the tick, rounded away from the mark. */
export function txflowMarketPrice(mark: number, isBuy: boolean, tick: string, slippage = TXFLOW_SLIPPAGE): string {
  return priceOnTick(mark * (isBuy ? 1 + slippage : 1 - slippage), tick, isBuy ? "up" : "down");
}

/** What filled, from the position's size before and after the order (signed sizes). */
export function fillFromPositions(before: number, after: number, isBuy: boolean): number {
  const delta = after - before;
  return isBuy ? Math.max(0, delta) : Math.max(0, -delta);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A market order (open, or close with reduceOnly), filled now or not at all.
 * Leverage is set first when opening; the fill is read back from the account.
 */
export async function txflowMarketOrder(
  network: TxflowNetwork,
  agentKey: Hex,
  o: { user: Address; symbol: string; isBuy: boolean; sizeUsd?: number; coinQty?: number; leverage?: number; reduceOnly?: boolean },
): Promise<TxflowFillResult> {
  const market = findTxflowMarket(await fetchTxflowMarkets(network), o.symbol);
  if (!market) return { ok: false, error: `${o.symbol} isn't listed on TxFlow.` };
  const ctx = await fetchTxflowCtx(market.index, network);
  if (!ctx) return { ok: false, market, error: `No live price for ${market.name} on TxFlow.` };
  const sz = txflowOrderSize({ sizeUsd: o.sizeUsd, coinQty: o.coinQty, mark: ctx.mark, szDecimals: market.szDecimals });
  if (!(Number(sz) > 0)) return { ok: false, market, error: `This order is below ${market.name}'s size step (${10 ** -market.szDecimals} ${market.base}).` };
  if (market.maxMarketOrderSize > 0 && Number(sz) > market.maxMarketOrderSize) {
    return { ok: false, market, error: `TxFlow's largest market order on ${market.name} is ${market.maxMarketOrderSize} ${market.base}; this one is ${sz}.` };
  }
  const marginMode = market.onlyIsolated ? "isolated" : "cross";

  if (!o.reduceOnly && o.leverage && o.leverage > 0) {
    const lev = Math.max(1, Math.min(Math.round(o.leverage), market.maxLeverage));
    const set = await sendAgentAction(network, agentKey, txflowLeverageAction(market.index, lev, marginMode));
    // Leverage can't change while orders are open on the market: the order then uses the current leverage.
    if (!set.ok && !/open orders|tpsl orders|trigger orders/i.test(set.error ?? "")) return { ...set, market };
  }

  const sizeOf = async () => (await fetchTxflowAccount(o.user, network)).positions.find((p) => p.index === market.index)?.size ?? 0;
  const before = await sizeOf();
  const px = txflowMarketPrice(ctx.mark, o.isBuy, market.priceTick);
  const action = txflowOrderAction([txflowOrderBody({ asset: market.index, isBuy: o.isBuy, px, sz, reduceOnly: o.reduceOnly ?? false, tif: "Ioc", marginMode })]);
  const out = await sendAgentAction(network, agentKey, action);
  if (!out.ok) return { ...out, market };

  // The account index can trail the block by a moment: read until the size moves.
  for (let i = 0; i < 8; i++) {
    const after = (await fetchTxflowAccount(o.user, network)).positions.find((p) => p.index === market.index);
    const filled = fillFromPositions(before, after?.size ?? 0, o.isBuy);
    if (filled > 0) {
      const avgPx = before === 0 && after?.entry ? after.entry : ctx.mark;
      return { ok: true, market, filled: { totalSz: Number(filled.toFixed(market.szDecimals)), avgPx } };
    }
    await sleep(600);
  }
  return { ok: false, market, error: "The order didn't fill (no liquidity within 1% of the mark). Nothing was traded." };
}

/** USDC from the TxFlow perp account to the wallet on Arbitrum ($1 fee, minimum $2), signed by the wallet. */
export async function withdrawFromTxflow(p: { user: Address; walletSign: TxflowWalletSign; walletChainId: number; amount: number; network?: TxflowNetwork }): Promise<TxflowOutcome & { amount?: number }> {
  const network = p.network ?? TXFLOW_NETWORK;
  const amount = Math.floor(p.amount * 100) / 100;
  if (!(amount >= TXFLOW_MIN_WITHDRAW_USD)) return { ok: false, error: `TxFlow's minimum withdrawal is ${TXFLOW_MIN_WITHDRAW_USD} USDC.` };
  const nonce = Date.now();
  const { action, typedData, signatureChainId } = txflowWithdraw({ network, destination: p.user, amount: String(amount), nonce, walletChainId: p.walletChainId });
  const signature = txflowSignature(await p.walletSign(typedData));
  const out = await postExchange(network, { action, signature, nonce, vaultAddress: null, signatureChainId, confirm: "executed" });
  return out.ok ? { ok: true, amount } : out;
}
