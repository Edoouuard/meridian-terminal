/**
 * integrations/extendedBridge.ts — deposit USDC from Arbitrum into the
 * connected Extended account, through Extended's bridge provider (Rhino.fi).
 *
 * Extended's documented EVM deposit (API docs, "Deposits"), in this order:
 *   1. GET  /user/bridge/config            → the bridge contract per chain
 *   2. GET  /user/bridge/quote             → a quote id and the bridge fee
 *   3. POST /user/bridge/quote?id=…        → commit it (Rhino.fi starts watching)
 *   4. depositWithId(token, amount, id) on the Arbitrum bridge contract, with
 *      the same id, amount and token (Rhino.fi EVM contract docs).
 * Funds sent any other way are not recoverable, so every value is checked
 * here before the wallet is asked to sign: the contract must be the known
 * Rhino.fi bridge on Arbitrum, the token native USDC, the id a hex quote id.
 */

import type { Address } from "viem";
import type { Signer as ExtendedSigner } from "@blackcube/extended-sdk";
import { extendedRestUrls } from "@/lib/integrations/extendedProxy";
import { ARBITRUM_USDC } from "@/lib/integrations/hyperliquidDeposit";

export const EXTENDED_DEPOSIT_CHAIN_ID = 42161;
/** Rhino.fi's bridge contract on Arbitrum, as Extended's bridge config returns it. Anything else is refused. */
export const RHINO_ARBITRUM_BRIDGE: Address = "0x10417734001162Ea139e8b044DFe28DbB8B28ad0";
export const EXTENDED_DEPOSIT_TOKEN: Address = ARBITRUM_USDC;
/** Smallest deposit Meridian sends: below this the bridge fee eats most of it. */
export const EXTENDED_MIN_DEPOSIT_USD = 10;
/** Extended's own app: the fallback when its bridge API fails (same wallet, same account). */
export const EXTENDED_APP_URL = "https://app.extended.exchange/";

export const RHINO_DEPOSIT_ABI = [
  {
    type: "function",
    name: "depositWithId",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "commitmentId", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export interface BridgeQuote {
  id: string;
  /** Bridge fee in USDC. */
  feeUsd: number;
  amountUsd: number;
}

type FetchImpl = typeof fetch;

/** An error Extended's bridge answered, with its HTTP status (5xx: their side, worth a retry). */
export class ExtendedBridgeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ExtendedBridgeError";
  }
}

/** Extended's server failed, not the request: the same quote may work in another documented form or a minute later. */
export const isBridgeServerError = (e: unknown): boolean => e instanceof ExtendedBridgeError && e.status >= 500;

async function call(signer: ExtendedSigner, method: "GET" | "POST", path: string, fetchImpl: FetchImpl): Promise<unknown> {
  const res = await fetchImpl(`${extendedRestUrls()[signer.network]}${path}`, { method, headers: { "x-api-key": signer.apiKey } });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  if (!res.ok || (body as { status?: unknown } | null)?.status === "ERROR") {
    throw new ExtendedBridgeError(typeof message === "string" && message ? message : `Extended bridge: HTTP ${res.status}`, res.status);
  }
  // Some bridge endpoints answer without the usual { status, data } envelope.
  return (body as { data?: unknown } | null)?.data ?? body;
}

/** The bridge contract Extended names for Arbitrum, only if it is the known Rhino.fi contract. */
export function arbitrumBridgeFromConfig(config: unknown): Address {
  const chains = (config as { chains?: unknown } | null)?.chains;
  const arb = Array.isArray(chains) ? (chains as { chain?: unknown; contractAddress?: unknown }[]).find((c) => c?.chain === "ARB") : undefined;
  const addr = typeof arb?.contractAddress === "string" ? arb.contractAddress : "";
  if (!addr) throw new Error("Extended doesn't list an Arbitrum bridge right now.");
  if (addr.toLowerCase() !== RHINO_ARBITRUM_BRIDGE.toLowerCase()) {
    throw new Error("Extended's Arbitrum bridge address changed; Meridian won't send funds to an address it hasn't verified.");
  }
  return RHINO_ARBITRUM_BRIDGE;
}

/** The uint256 commitment id the contract expects, from the hex quote id. */
export function commitmentIdFromQuote(id: string): bigint {
  const hex = id.trim().replace(/^0x/i, "");
  if (!/^[0-9a-f]{1,64}$/i.test(hex)) throw new Error("Unexpected bridge quote id; deposit stopped before signing.");
  return BigInt(`0x${hex}`);
}

/** USDC base units (6 decimals) for a dollar amount, rounded down to the cent. */
export function usdcUnits(amountUsd: number): bigint {
  return BigInt(Math.floor(amountUsd * 100)) * 10_000n;
}

export function parseQuote(raw: unknown, amountUsd: number): BridgeQuote {
  const q = raw as { id?: unknown; fee?: unknown } | null;
  const id = typeof q?.id === "string" ? q.id : typeof q?.id === "number" ? String(q.id) : "";
  const feeUsd = Number(q?.fee);
  if (!id || !Number.isFinite(feeUsd) || feeUsd < 0) throw new Error("Extended returned an unreadable bridge quote.");
  commitmentIdFromQuote(id);
  return { id, feeUsd, amountUsd };
}

export async function fetchArbitrumBridge(signer: ExtendedSigner, fetchImpl: FetchImpl = fetch): Promise<Address> {
  return arbitrumBridgeFromConfig(await call(signer, "GET", "/user/bridge/config", fetchImpl));
}

/**
 * The quote request in the forms Extended's docs allow, tried in order while
 * Extended answers with a server error (owner report 2026-10-22: HTTP 500,
 * code 1006, on the documented form): `asset` is optional, and the amount is
 * a number. The quoted amount is the one deposited, so a whole-dollar form
 * quotes (and later deposits) the whole dollars. USD is Extended's only
 * collateral symbol ("USDC" answers "Asset not found").
 */
export function quoteAttempts(amountUsd: number): { query: string; amountUsd: number }[] {
  const cents = (Math.floor(amountUsd * 100) / 100).toFixed(2);
  const whole = Math.floor(amountUsd);
  const base = "/user/bridge/quote?chainIn=ARB&chainOut=STRK";
  return [
    { query: `${base}&amount=${cents}&asset=USD`, amountUsd: Number(cents) },
    { query: `${base}&amount=${cents}`, amountUsd: Number(cents) },
    { query: `${base}&amount=${whole}&asset=USD`, amountUsd: whole },
  ].filter((a, i, all) => a.amountUsd >= EXTENDED_MIN_DEPOSIT_USD && all.findIndex((b) => b.query === a.query) === i);
}

export async function quoteArbitrumDeposit(signer: ExtendedSigner, amountUsd: number, fetchImpl: FetchImpl = fetch): Promise<BridgeQuote> {
  if (!(amountUsd >= EXTENDED_MIN_DEPOSIT_USD)) throw new Error(`Deposits to Extended start at $${EXTENDED_MIN_DEPOSIT_USD}.`);
  let last: unknown = null;
  for (const a of quoteAttempts(amountUsd)) {
    try {
      return parseQuote(await call(signer, "GET", a.query, fetchImpl), a.amountUsd);
    } catch (e) {
      // A refusal (geo-restriction, bad amount) is an answer: only a server error tries the next form.
      // After a server error, a later form's refusal is not the story: Extended's outage is.
      if (!isBridgeServerError(e)) {
        if (last) break;
        throw e;
      }
      last = e;
    }
  }
  throw new ExtendedBridgeError(
    `Extended's deposit service is failing on its side ("${last instanceof Error ? last.message : "server error"}" on every quote). Nothing was sent. Deposit with this same wallet on app.extended.exchange instead: Meridian reads the balance as soon as it lands, and the bot uses it.`,
    last instanceof ExtendedBridgeError ? last.status : 500,
  );
}

export async function commitQuote(signer: ExtendedSigner, quoteId: string, fetchImpl: FetchImpl = fetch): Promise<void> {
  commitmentIdFromQuote(quoteId);
  await call(signer, "POST", `/user/bridge/quote?id=${encodeURIComponent(quoteId)}`, fetchImpl);
}

/** The deposit call, built only from checked values. */
export function depositCall(bridge: Address, quote: BridgeQuote) {
  return {
    chainId: EXTENDED_DEPOSIT_CHAIN_ID,
    address: bridge,
    abi: RHINO_DEPOSIT_ABI,
    functionName: "depositWithId" as const,
    args: [EXTENDED_DEPOSIT_TOKEN, usdcUnits(quote.amountUsd), commitmentIdFromQuote(quote.id)] as const,
  };
}

export interface DepositOperation {
  id: string;
  status: "CREATED" | "IN_PROGRESS" | "COMPLETED" | "REJECTED" | string;
  amountUsd: number;
  transactionHash?: string;
  time: number;
}

/** Latest deposits on the account (GET /user/assetOperations?type=DEPOSIT), newest first. */
export async function fetchRecentDeposits(signer: ExtendedSigner, fetchImpl: FetchImpl = fetch): Promise<DepositOperation[]> {
  const raw = await call(signer, "GET", "/user/assetOperations?type=DEPOSIT&limit=10", fetchImpl);
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[]).map((d) => ({
    id: String(d.id ?? ""),
    status: String(d.status ?? ""),
    amountUsd: Number(d.amount) || 0,
    transactionHash: typeof d.transactionHash === "string" ? d.transactionHash : undefined,
    time: Number(d.time) || 0,
  }));
}

/** The deposit matching an Arbitrum transaction, once Extended has seen it. */
export function depositForTx(deposits: DepositOperation[], txHash: string): DepositOperation | undefined {
  return deposits.find((d) => d.transactionHash?.toLowerCase() === txHash.toLowerCase());
}
