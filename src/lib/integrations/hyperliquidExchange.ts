/**
 * hyperliquidExchange.ts — Hyperliquid's exchange protocol, as the official
 * SDKs implement it (hyperliquid-python-sdk `signing.py`).
 *
 * Two kinds of signatures:
 *   - L1 actions (orders, leverage): the action is msgpack-encoded and hashed
 *     with the nonce (+ vault flag) into a `connectionId`; a "phantom agent"
 *     {source, connectionId} is signed with EIP-712 domain "Exchange",
 *     chainId 1337. Wallets refuse to sign for chain 1337, so these are signed
 *     by an AGENT key that lives in the browser and that the user approved
 *     once (it can trade, it can never withdraw).
 *   - User-signed actions (approveAgent): EIP-712 domain
 *     "HyperliquidSignTransaction" on the wallet's own chain, signed by the
 *     wallet itself.
 *
 * Everything here is pure except the `post*` helpers, which only send what
 * the caller built and signed.
 */

import { encode } from "@msgpack/msgpack";
import { concat, hexToBytes, keccak256, parseSignature, toBytes, type Address, type Hex } from "viem";

export const HL_ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** Hyperliquid prices: at most 5 significant figures and (6 − szDecimals) decimals for perps, (8 − szDecimals) for spot. */
export function roundPrice(px: number, szDecimals: number, spot: boolean): number {
  const sig = Number(px.toPrecision(5));
  const decimals = Math.max(0, (spot ? 8 : 6) - szDecimals);
  return Number(sig.toFixed(decimals));
}

/** Sizes round to the asset's szDecimals; `down` never rounds above what the user holds. */
export function roundSize(sz: number, szDecimals: number, down = false): number {
  const f = 10 ** szDecimals;
  return (down ? Math.floor(sz * f + 1e-9) : Math.round(sz * f)) / f;
}

/** The SDK's float_to_wire: 8 decimals, trailing zeros stripped, never "-0". */
export function floatToWire(x: number): string {
  const rounded = x.toFixed(8);
  if (Math.abs(Number(rounded) - x) >= 1e-12) throw new Error(`floatToWire causes rounding: ${x}`);
  let s = rounded.replace(/\.?0+$/, "");
  if (s === "-0" || s === "") s = "0";
  return s;
}

export interface OrderWire {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: { limit: { tif: "Gtc" | "Ioc" | "Alo" } } | { trigger: { isMarket: boolean; triggerPx: string; tpsl: "tp" | "sl" } };
}

/** Key order matters: it is part of the msgpack hash. */
export function orderWire(o: { asset: number; isBuy: boolean; px: number; sz: number; reduceOnly?: boolean; tif?: "Gtc" | "Ioc" | "Alo" }): OrderWire {
  return { a: o.asset, b: o.isBuy, p: floatToWire(o.px), s: floatToWire(o.sz), r: o.reduceOnly ?? false, t: { limit: { tif: o.tif ?? "Ioc" } } };
}

/**
 * A reduce-only stop-loss or take-profit: when the mark crosses `triggerPx`
 * it becomes a market order, `px` being the worst price it may fill at.
 */
export function triggerOrderWire(o: { asset: number; isBuy: boolean; px: number; sz: number; triggerPx: number; tpsl: "tp" | "sl" }): OrderWire {
  return {
    a: o.asset,
    b: o.isBuy,
    p: floatToWire(o.px),
    s: floatToWire(o.sz),
    r: true,
    t: { trigger: { isMarket: true, triggerPx: floatToWire(o.triggerPx), tpsl: o.tpsl } },
  };
}

export function orderAction(orders: OrderWire[]) {
  return { type: "order", orders, grouping: "na" };
}

/** Cancel resting orders (limit, stop-loss, take-profit) by asset and order id. */
export function cancelAction(cancels: { asset: number; oid: number }[]) {
  return { type: "cancel", cancels: cancels.map((c) => ({ a: c.asset, o: c.oid })) };
}

/** Replace a resting order in place (new price / size), keeping its place in the book when possible. */
export function modifyAction(oid: number, order: OrderWire) {
  return { type: "batchModify", modifies: [{ oid, order }] };
}

export function updateLeverageAction(asset: number, leverage: number, isCross = true) {
  return { type: "updateLeverage", asset, isCross, leverage: Math.round(leverage) };
}

/** keccak256(msgpack(action) ‖ nonce (u64 BE) ‖ vault flag [‖ vault]). */
export function actionHash(action: unknown, vaultAddress: Address | null, nonce: number): Hex {
  const data = encode(action);
  const nonceBytes = new Uint8Array(8);
  new DataView(nonceBytes.buffer).setBigUint64(0, BigInt(nonce));
  const vault = vaultAddress ? concat([new Uint8Array([1]), hexToBytes(vaultAddress)]) : new Uint8Array([0]);
  return keccak256(concat([data, nonceBytes, vault]));
}

/** EIP-712 payload of an L1 action, signed by the agent key. */
export function l1TypedData(action: unknown, nonce: number, isMainnet: boolean, vaultAddress: Address | null = null) {
  return {
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: HL_ZERO_ADDRESS },
    types: {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent" as const,
    message: { source: isMainnet ? "a" : "b", connectionId: actionHash(action, vaultAddress, nonce) },
  };
}

const APPROVE_AGENT_TYPES = [
  { name: "hyperliquidChain", type: "string" },
  { name: "agentAddress", type: "address" },
  { name: "agentName", type: "string" },
  { name: "nonce", type: "uint64" },
] as const;

/**
 * The approveAgent action and the EIP-712 payload the WALLET signs for it,
 * on the wallet's current chain (wallets refuse a domain for another chain).
 */
export function approveAgentAction(p: { agentAddress: Address; agentName: string; nonce: number; isMainnet: boolean; signatureChainId: number }) {
  const action = {
    type: "approveAgent",
    signatureChainId: `0x${p.signatureChainId.toString(16)}`,
    hyperliquidChain: p.isMainnet ? "Mainnet" : "Testnet",
    agentAddress: p.agentAddress,
    agentName: p.agentName,
    nonce: p.nonce,
  };
  const typedData = {
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId: p.signatureChainId, verifyingContract: HL_ZERO_ADDRESS },
    types: { "HyperliquidTransaction:ApproveAgent": APPROVE_AGENT_TYPES },
    primaryType: "HyperliquidTransaction:ApproveAgent" as const,
    message: { hyperliquidChain: action.hyperliquidChain, agentAddress: p.agentAddress, agentName: p.agentName, nonce: BigInt(p.nonce) },
  };
  return { action, typedData };
}

const WITHDRAW_TYPES = [
  { name: "hyperliquidChain", type: "string" },
  { name: "destination", type: "string" },
  { name: "amount", type: "string" },
  { name: "time", type: "uint64" },
] as const;

const USD_CLASS_TRANSFER_TYPES = [
  { name: "hyperliquidChain", type: "string" },
  { name: "amount", type: "string" },
  { name: "toPerp", type: "bool" },
  { name: "nonce", type: "uint64" },
] as const;

const userSignedDomain = (signatureChainId: number) => ({ name: "HyperliquidSignTransaction", version: "1", chainId: signatureChainId, verifyingContract: HL_ZERO_ADDRESS });

/**
 * Withdraw USDC from the Hyperliquid account to the same address on
 * Arbitrum (withdraw3). Signed by the WALLET; Hyperliquid takes a $1 fee and
 * the funds arrive in a few minutes. `time` is also the request's nonce.
 */
export function withdrawAction(p: { destination: Address; amount: string; time: number; isMainnet: boolean; signatureChainId: number }) {
  const hyperliquidChain = p.isMainnet ? "Mainnet" : "Testnet";
  const action = { type: "withdraw3", signatureChainId: `0x${p.signatureChainId.toString(16)}`, hyperliquidChain, destination: p.destination, amount: p.amount, time: p.time };
  const typedData = {
    domain: userSignedDomain(p.signatureChainId),
    types: { "HyperliquidTransaction:Withdraw": WITHDRAW_TYPES },
    primaryType: "HyperliquidTransaction:Withdraw" as const,
    message: { hyperliquidChain, destination: p.destination, amount: p.amount, time: BigInt(p.time) },
  };
  return { action, typedData };
}

/** Move USDC between the spot and perps balances (only perps margin can be withdrawn outside unified mode). */
export function usdClassTransferAction(p: { amount: string; toPerp: boolean; nonce: number; isMainnet: boolean; signatureChainId: number }) {
  const hyperliquidChain = p.isMainnet ? "Mainnet" : "Testnet";
  const action = { type: "usdClassTransfer", signatureChainId: `0x${p.signatureChainId.toString(16)}`, hyperliquidChain, amount: p.amount, toPerp: p.toPerp, nonce: p.nonce };
  const typedData = {
    domain: userSignedDomain(p.signatureChainId),
    types: { "HyperliquidTransaction:UsdClassTransfer": USD_CLASS_TRANSFER_TYPES },
    primaryType: "HyperliquidTransaction:UsdClassTransfer" as const,
    message: { hyperliquidChain, amount: p.amount, toPerp: p.toPerp, nonce: BigInt(p.nonce) },
  };
  return { action, typedData };
}

/** Hyperliquid's fixed fee on a withdrawal to Arbitrum, in USDC. */
export const HL_WITHDRAW_FEE_USD = 1;

export function splitSignature(sig: Hex): { r: Hex; s: Hex; v: number } {
  const { r, s, v, yParity } = parseSignature(sig);
  return { r, s, v: Number(v ?? BigInt(27 + (yParity ?? 0))) };
}

/** The HyperCore "system address" a HyperEVM token is sent to so it lands in the user's Hyperliquid spot balance. */
export function systemAddressForToken(tokenIndex: number): Address {
  const bytes = new Uint8Array(20);
  bytes[0] = 0x20;
  const idx = toBytes(BigInt(tokenIndex), { size: 8 });
  bytes.set(idx, 12);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Address;
}

/* ─── Exchange responses ─────────────────────────────────────────────── */

export interface ExchangeOutcome {
  ok: boolean;
  /** Filled size and average price when an IOC order (partly) filled. */
  filled?: { totalSz: number; avgPx: number };
  /** Order id of a limit order now resting on the book. */
  resting?: { oid: number };
  error?: string;
}

/** Read an /exchange response: transport errors, then the per-order status. */
export function parseExchangeResponse(body: unknown): ExchangeOutcome {
  const b = body as { status?: string; response?: unknown } | null;
  if (!b || b.status !== "ok") {
    const msg = typeof b?.response === "string" ? b.response : JSON.stringify(body)?.slice(0, 200);
    return { ok: false, error: msg || "Hyperliquid rejected the request." };
  }
  const resp = b.response as { type?: string; data?: { statuses?: unknown[] } } | undefined;
  const status = resp?.data?.statuses?.[0] as { filled?: { totalSz?: string; avgPx?: string }; resting?: { oid?: number }; error?: string } | string | undefined;
  if (status && typeof status === "object") {
    if (status.error) return { ok: false, error: status.error };
    if (status.filled) return { ok: true, filled: { totalSz: Number(status.filled.totalSz ?? 0), avgPx: Number(status.filled.avgPx ?? 0) } };
    if (typeof status.resting?.oid === "number") return { ok: true, resting: { oid: status.resting.oid } };
  }
  return { ok: true };
}

/** The first per-order error of a multi-order action (a TP and an SL), if any. */
export function firstOrderError(body: unknown): string | undefined {
  const parsed = parseExchangeResponse(body);
  if (!parsed.ok) return parsed.error;
  const statuses = (body as { response?: { data?: { statuses?: unknown[] } } }).response?.data?.statuses ?? [];
  for (const st of statuses) if (st && typeof st === "object" && "error" in st) return String((st as { error: unknown }).error);
  return undefined;
}

/** "User or API Wallet 0x… does not exist." — the agent isn't (or is no longer) approved. */
export function isUnknownAgentError(error: string | undefined): boolean {
  return !!error && /does not exist/i.test(error);
}
