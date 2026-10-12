/**
 * mcp/providers/base.ts — Base MCP provider.
 *
 * Base-specific wallet UX and primitives: ENS/Basenames resolution,
 * Paymaster (gasless tx), smart wallet detection, Base-native DeFi
 * primitives (Aerodrome, Moonwell, etc.), and onramp support.
 *
 * Base MCP endpoint: https://mcp.base.org (Streamable HTTP). It is an
 * OAuth-protected Coinbase agent-wallet server (scopes agent_wallet:*): every
 * request needs a bearer token obtained through its OAuth flow. Set
 * BASE_MCP_TOKEN to enable this provider; without it the provider reports
 * "not configured" and makes no network calls.
 */

import { callMcpTool, getMcpClient } from "../client";
import type {
  McpProviderId,
  McpProviderStatus,
  TokenInfo,
  UnsignedTx,
} from "../types";
import type { Address } from "viem";

const BASE_MCP_URL = process.env.BASE_MCP_URL || "https://mcp.base.org";
const PROVIDER_ID: McpProviderId = "base";
const SERVER_NAME = "base";
const BASE_CHAIN_ID = 8453;

function baseHeaders(): Record<string, string> | null {
  const token = process.env.BASE_MCP_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : null;
}

export function isConfigured(): boolean {
  return baseHeaders() !== null;
}

/** Call a Base MCP tool, or resolve to null without any network call when no token is configured. */
async function callBase(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const headers = baseHeaders();
  if (!headers) return null;
  return callMcpTool(BASE_MCP_URL, SERVER_NAME, toolName, args, { headers });
}

// ─── Health check ────────────────────────────────────────────────────

let lastHealthCheck: McpProviderStatus = {
  id: PROVIDER_ID,
  name: "Base",
  healthy: false,
  configured: isConfigured(),
  latencyMs: null,
  lastChecked: 0,
};

export async function checkHealth(): Promise<McpProviderStatus> {
  const start = Date.now();
  const headers = baseHeaders();
  if (!headers) {
    lastHealthCheck = { id: PROVIDER_ID, name: "Base", healthy: false, configured: false, latencyMs: null, lastChecked: Date.now() };
    return lastHealthCheck;
  }
  try {
    // An authenticated tools/list proves the server is up and the token valid.
    const client = await getMcpClient(BASE_MCP_URL, SERVER_NAME, { headers });
    await client.listTools(undefined, { timeout: 8000 });
    lastHealthCheck = {
      id: PROVIDER_ID,
      name: "Base",
      healthy: true,
      configured: true,
      latencyMs: Date.now() - start,
      lastChecked: Date.now(),
    };
  } catch {
    lastHealthCheck = {
      id: PROVIDER_ID,
      name: "Base",
      healthy: false,
      configured: true,
      latencyMs: Date.now() - start,
      lastChecked: Date.now(),
    };
  }
  return lastHealthCheck;
}

export function getStatus(): McpProviderStatus {
  return lastHealthCheck;
}

// ─── Name resolution ─────────────────────────────────────────────────

/**
 * Resolve a Basename or ENS name to an address on Base.
 */
export async function resolveName(name: string): Promise<Address | null> {
  try {
    const result = await callBase("resolve_name", { name });
    const data = parseResult<{ address: string }>(result);
    return (data?.address as Address) ?? null;
  } catch (err) {
    console.warn("[base] resolveName failed:", err);
    return null;
  }
}

/**
 * Reverse-resolve an address to a Basename.
 */
export async function reverseName(address: Address): Promise<string | null> {
  try {
    const result = await callBase("reverse_name", { address });
    const data = parseResult<{ name: string }>(result);
    return data?.name ?? null;
  } catch (err) {
    console.warn("[base] reverseName failed:", err);
    return null;
  }
}

// ─── Smart wallet / Paymaster ────────────────────────────────────────

export interface SmartWalletInfo {
  isSmartWallet: boolean;
  implementation?: string;
  paymasterAvailable: boolean;
}

/**
 * Detect whether an address is a smart wallet (Coinbase Smart Wallet, Safe, etc.)
 * and whether a paymaster is available for gasless transactions.
 */
export async function detectSmartWallet(address: Address): Promise<SmartWalletInfo> {
  try {
    const result = await callBase("detect_smart_wallet", { address });
    return parseResult<SmartWalletInfo>(result) ?? {
      isSmartWallet: false,
      paymasterAvailable: false,
    };
  } catch (err) {
    console.warn("[base] detectSmartWallet failed:", err);
    return { isSmartWallet: false, paymasterAvailable: false };
  }
}

/**
 * Wrap an unsigned transaction with paymaster sponsorship (gasless).
 * Returns the sponsored tx or null if paymaster is unavailable.
 */
export async function sponsorTransaction(
  tx: UnsignedTx,
  userAddress: Address,
): Promise<UnsignedTx | null> {
  if (tx.chainId !== BASE_CHAIN_ID) return null;
  try {
    const result = await callBase("sponsor_transaction", {
      to: tx.to,
      data: tx.data,
      value: tx.value,
      sender: userAddress,
    });
    const sponsored = parseResult<{ to: string; data: string; value: string; gasLimit: string }>(result);
    if (!sponsored) return null;
    return {
      to: sponsored.to as Address,
      data: sponsored.data as `0x${string}`,
      value: sponsored.value,
      chainId: BASE_CHAIN_ID,
      gasLimit: sponsored.gasLimit,
    };
  } catch (err) {
    console.warn("[base] sponsorTransaction failed:", err);
    return null;
  }
}

// ─── Base-native DeFi primitives ─────────────────────────────────────

export interface AerodromePool {
  address: Address;
  token0: TokenInfo;
  token1: TokenInfo;
  tvlUsd: number;
  apr: number;
  stable: boolean;
}

/**
 * List top Aerodrome liquidity pools on Base.
 */
export async function getAerodromePools(opts?: {
  limit?: number;
  token?: string;
}): Promise<AerodromePool[]> {
  try {
    const result = await callBase("get_aerodrome_pools", {
      limit: opts?.limit ?? 20,
      ...(opts?.token && { token: opts.token }),
    });
    return parseResult<AerodromePool[]>(result) ?? [];
  } catch (err) {
    console.warn("[base] getAerodromePools failed:", err);
    return [];
  }
}

/**
 * Get Moonwell lending markets on Base.
 */
export interface MoonwellMarket {
  asset: string;
  address: Address;
  supplyApy: number;
  borrowApy: number;
  totalSupplyUsd: number;
  totalBorrowUsd: number;
}

export async function getMoonwellMarkets(): Promise<MoonwellMarket[]> {
  try {
    const result = await callBase("get_moonwell_markets", {});
    return parseResult<MoonwellMarket[]>(result) ?? [];
  } catch (err) {
    console.warn("[base] getMoonwellMarkets failed:", err);
    return [];
  }
}

// ─── Onramp ──────────────────────────────────────────────────────────

export interface OnrampQuote {
  provider: string;
  fiatAmount: number;
  fiatCurrency: string;
  cryptoAmount: string;
  cryptoToken: string;
  feeUsd: number;
  checkoutUrl: string;
}

/**
 * Get onramp quotes for buying crypto on Base with fiat.
 */
export async function getOnrampQuote(
  fiatAmount: number,
  fiatCurrency: string,
  cryptoToken: string,
): Promise<OnrampQuote | null> {
  try {
    const result = await callBase("get_onramp_quote", {
      fiatAmount,
      fiatCurrency,
      cryptoToken,
      chainId: BASE_CHAIN_ID,
    });
    return parseResult<OnrampQuote>(result);
  } catch (err) {
    console.warn("[base] getOnrampQuote failed:", err);
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function parseResult<T>(content: unknown): T | null {
  if (!content) return null;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && "type" in block) {
        if (block.type === "text" && "text" in block) {
          try { return JSON.parse(block.text as string) as T; } catch { return null; }
        }
      }
    }
    return null;
  }
  if (typeof content === "string") {
    try { return JSON.parse(content) as T; } catch { return null; }
  }
  return content as T;
}
