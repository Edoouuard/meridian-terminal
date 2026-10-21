/**
 * txflowExchange.ts — TxFlow's exchange protocol (docs.txflow.com/api/signing).
 *
 * TxFlow is its own L1 with a Hyperliquid-style API: unsigned reads on
 * POST /info, signed writes on POST /exchange. Two signing flows, both EIP-712
 * with domain {name: "TxFlow-Mainnet" | "TxFlow-Testnet", version: "1",
 * chainId: 869 | 2511, verifyingContract: 0x0}:
 *   - Direct EIP-712, signed by the WALLET (approveAgent, withdraw3): the
 *     action fields are the typed message. `signatureChainId` swaps the
 *     domain chain for the wallet's connected one (wallets refuse a domain on
 *     another chain); the struct keeps TxFlow's chainId.
 *   - Agent signing (orders, leverage): msgpack(action without `type`) ‖
 *     nonce (u64 BE) ‖ vault flag → keccak256 = connectionId, signed as
 *     Agent{txflowNetwork, chainId, apiVersion, connectionId} by an agent key
 *     kept in the browser, approved once by the wallet. It can trade, never
 *     withdraw.
 *
 * Pure: the official test vectors are pinned in txflowExchange.test.ts.
 */

import { encode } from "@msgpack/msgpack";
import { concat, hexToBytes, keccak256, parseSignature, type Address, type Hex } from "viem";

export type TxflowNetwork = "mainnet" | "testnet";

export const TXFLOW_ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
export const TXFLOW_API_VERSION = 1;
/** Sent on every /info and /exchange request: responses are documented in this format. */
export const TXFLOW_API_VERSION_HEADER = "2026-08-16";

export const TXFLOW = {
  mainnet: { name: "TxFlow-Mainnet", chainId: 869, host: "https://rpc.txflow.com" },
  testnet: { name: "TxFlow-Testnet", chainId: 2511, host: "https://rpc.txflow-testnet.xyz" },
} as const;

/** TxFlow-side USDC (withdraw3 `tokenAddress`). */
export const TXFLOW_USDC: Address = "0xd04f0d19E8FbA49cfA541E272F9C60a2ad720464";
/** withdraw3: minimum amount and flat fee, in USDC. */
export const TXFLOW_MIN_WITHDRAW_USD = 2;
export const TXFLOW_WITHDRAW_FEE_USD = 1;

const domain = (network: TxflowNetwork, chainId?: number) => ({
  name: TXFLOW[network].name,
  version: String(TXFLOW_API_VERSION),
  chainId: chainId ?? TXFLOW[network].chainId,
  verifyingContract: TXFLOW_ZERO_ADDRESS,
});

/* ─── Prices and sizes ───────────────────────────────────────────────── */

const decimalsOf = (step: string) => (step.includes(".") ? step.split(".")[1].replace(/0+$/, "").length : 0);

/** A price on the instrument's tick (`priceTick` from perpMeta), as the decimal string the signature covers. */
export function priceOnTick(px: number, tick: string, mode: "up" | "down" | "nearest" = "nearest"): string {
  const t = Number(tick);
  if (!(t > 0) || !(px > 0)) throw new Error(`Invalid price ${px} or tick ${tick}`);
  const n = px / t;
  const k = mode === "up" ? Math.ceil(n - 1e-9) : mode === "down" ? Math.floor(n + 1e-9) : Math.round(n);
  return (k * t).toFixed(decimalsOf(tick));
}

/** A size with at most `szDecimals` decimals, rounded down (never more than asked or held). */
export function sizeToWire(sz: number, szDecimals: number): string {
  const f = 10 ** szDecimals;
  const v = Math.floor(sz * f + 1e-9) / f;
  return v.toFixed(szDecimals).replace(/\.?0+$/, "") || "0";
}

/* ─── Agent-signed actions ───────────────────────────────────────────── */

export interface TxflowOrderBody {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: { limit: { tif: "Gtc" | "Ioc" | "Alo" } };
  /** Margin mode, sent explicitly as the docs advise (it selects the position). */
  m?: "cross" | "isolated";
}

/** Key order is the node's (a, b, p, s, r, t, m): it is part of the hash. */
export function txflowOrderBody(o: { asset: number; isBuy: boolean; px: string; sz: string; reduceOnly?: boolean; tif?: "Gtc" | "Ioc" | "Alo"; marginMode?: "cross" | "isolated" }): TxflowOrderBody {
  const body: TxflowOrderBody = { a: o.asset, b: o.isBuy, p: o.px, s: o.sz, r: o.reduceOnly ?? false, t: { limit: { tif: o.tif ?? "Ioc" } } };
  if (o.marginMode) body.m = o.marginMode;
  return body;
}

export function txflowOrderAction(orders: TxflowOrderBody[]) {
  return { type: "order", grouping: "na", orders };
}

export interface TxflowTriggerBody {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: { trigger: { isMarket: boolean; triggerPx: string; tpsl: "tp" | "sl" } };
  m?: "cross" | "isolated";
}

/**
 * Stop-loss / take-profit bound to an open position (`grouping:
 * "positionTpsl"`): reduce-only market triggers on the closing side, size "0"
 * = the whole position (as `modifyTpsl` defines it), limit price = the
 * trigger price on the tick. Key orders are the node's: a, b, p, s, r, t, m
 * and isMarket, triggerPx, tpsl. Stop-loss first, as TxFlow pairs them.
 */
export function txflowPositionTpslAction(o: { asset: number; isLong: boolean; sl?: string; tp?: string; marginMode?: "cross" | "isolated" }) {
  const leg = (tpsl: "tp" | "sl", px: string): TxflowTriggerBody => {
    const body: TxflowTriggerBody = { a: o.asset, b: !o.isLong, p: px, s: "0", r: true, t: { trigger: { isMarket: true, triggerPx: px, tpsl } } };
    if (o.marginMode) body.m = o.marginMode;
    return body;
  };
  const orders = [o.sl ? leg("sl", o.sl) : null, o.tp ? leg("tp", o.tp) : null].filter((x): x is TxflowTriggerBody => x !== null);
  return { type: "order", grouping: "positionTpsl", orders };
}

export function txflowLeverageAction(asset: number, leverage: number, marginMode: "cross" | "isolated" = "cross") {
  return { type: "updateLeverage", asset, leverage, marginMode };
}

/** keccak256(msgpack(action without `type`) ‖ nonce (u64 BE) ‖ vault flag [‖ vault]). */
export function txflowConnectionId(action: { type: string } & Record<string, unknown>, nonce: number, vaultAddress: Address | null = null): Hex {
  const { type: _type, ...body } = action;
  void _type;
  const data = encode(body);
  const nonceBytes = new Uint8Array(8);
  new DataView(nonceBytes.buffer).setBigUint64(0, BigInt(nonce));
  const vault = vaultAddress ? concat([new Uint8Array([1]), hexToBytes(vaultAddress)]) : new Uint8Array([0]);
  return keccak256(concat([data, nonceBytes, vault]));
}

/** The EIP-712 payload the agent key signs for a trading action. */
export function txflowAgentTypedData(action: { type: string } & Record<string, unknown>, nonce: number, network: TxflowNetwork, vaultAddress: Address | null = null) {
  return {
    domain: domain(network),
    types: {
      Agent: [
        { name: "txflowNetwork", type: "string" },
        { name: "chainId", type: "uint32" },
        { name: "apiVersion", type: "uint32" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent" as const,
    message: { txflowNetwork: TXFLOW[network].name, chainId: TXFLOW[network].chainId, apiVersion: TXFLOW_API_VERSION, connectionId: txflowConnectionId(action, nonce, vaultAddress) },
  };
}

/* ─── Wallet-signed actions ──────────────────────────────────────────── */

/** Authorize the agent key (an `agentAddress` of 0x0 revokes `agentName`). */
export function txflowApproveAgent(p: { network: TxflowNetwork; agentAddress: Address; agentName: string; nonce: number; walletChainId?: number }) {
  const net = TXFLOW[p.network];
  const action = { type: "approveAgent", txflowNetwork: net.name, chainId: net.chainId, apiVersion: TXFLOW_API_VERSION, agentAddress: p.agentAddress, agentName: p.agentName, nonce: p.nonce };
  const typedData = {
    domain: domain(p.network, p.walletChainId),
    types: {
      ApproveAgent: [
        { name: "txflowNetwork", type: "string" },
        { name: "chainId", type: "uint32" },
        { name: "apiVersion", type: "uint32" },
        { name: "agentAddress", type: "address" },
        { name: "agentName", type: "string" },
        { name: "nonce", type: "uint64" },
      ],
    },
    primaryType: "ApproveAgent" as const,
    message: { txflowNetwork: net.name, chainId: net.chainId, apiVersion: TXFLOW_API_VERSION, agentAddress: p.agentAddress, agentName: p.agentName, nonce: BigInt(p.nonce) },
  };
  return { action, typedData, signatureChainId: p.walletChainId ?? null };
}

/** USDC from the perp account to an Arbitrum address (min $2, $1 fee). */
export function txflowWithdraw(p: { network: TxflowNetwork; destination: Address; amount: string; nonce: number; walletChainId: number }) {
  const net = TXFLOW[p.network];
  const signatureChainId = p.walletChainId.toString(16);
  const action = { type: "withdraw3", txflowNetwork: net.name, chainId: net.chainId, apiVersion: TXFLOW_API_VERSION, destination: p.destination, signatureChainId, tokenAddress: TXFLOW_USDC, amount: p.amount, nonce: p.nonce };
  const typedData = {
    domain: domain(p.network, p.walletChainId),
    types: {
      Withdraw3: [
        { name: "txflowNetwork", type: "string" },
        { name: "destination", type: "address" },
        { name: "signatureChainId", type: "string" },
        { name: "tokenAddress", type: "address" },
        { name: "amount", type: "string" },
        { name: "nonce", type: "uint64" },
      ],
    },
    primaryType: "Withdraw3" as const,
    message: { txflowNetwork: net.name, destination: p.destination, signatureChainId, tokenAddress: TXFLOW_USDC, amount: p.amount, nonce: BigInt(p.nonce) },
  };
  return { action, typedData, signatureChainId: p.walletChainId };
}

/* ─── Envelope and responses ─────────────────────────────────────────── */

export function txflowSignature(sig: Hex): { r: Hex; s: Hex; v: number } {
  const { r, s, v, yParity } = parseSignature(sig);
  return { r, s, v: Number(v ?? BigInt(27 + (yParity ?? 0))) };
}

export interface TxflowOutcome {
  ok: boolean;
  error?: string;
  /** HTTP 202: accepted, execution not confirmed within the wait. */
  pending?: boolean;
}

/**
 * Read an /exchange response. Sent with `confirm: "executed"`, a failed
 * execution comes back as `{error}` inside `statuses`; a rejection as
 * `status: "err"` with the reason in `message` (or `response`).
 */
export function parseTxflowResponse(body: unknown, httpStatus = 200): TxflowOutcome {
  const b = (body ?? {}) as { status?: string; message?: unknown; response?: unknown; data?: { data?: { statuses?: unknown[] } } };
  if (httpStatus === 202 || b.status === "pending") return { ok: false, pending: true, error: "TxFlow accepted the action but hasn't confirmed its execution yet." };
  if (b.status !== "ok") {
    const reason = typeof b.message === "string" ? b.message : typeof b.response === "string" ? b.response : JSON.stringify(body ?? {}).slice(0, 160);
    return { ok: false, error: reason || `TxFlow refused the action (HTTP ${httpStatus}).` };
  }
  const failed = (b.data?.data?.statuses ?? []).find((s): s is { error: string } => typeof s === "object" && s !== null && typeof (s as { error?: unknown }).error === "string");
  return failed ? { ok: false, error: failed.error } : { ok: true };
}

/** The node's answer when the agent key isn't (or no longer) authorized. */
export function isUnauthorizedAgent(error: string | undefined): boolean {
  return !!error && /agent .*not authorized|not authorized by any account/i.test(error);
}
