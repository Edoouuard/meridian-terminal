/**
 * mcp/providers/base.ts — Base MCP provider.
 *
 * Base-specific wallet UX and primitives: ENS/Basenames resolution,
 * Paymaster (gasless tx), smart wallet detection, Base-native DeFi
 * primitives (Aerodrome, Moonwell, etc.), and onramp support.
 *
 * There is NO public hosted Base MCP server: the `base-mcp` package is
 * archived/deprecated (it was a local stdio server, never hosted at
 * mcp.base.org). Every MCP-backed call here is therefore opt-in via
 * BASE_MCP_URL; without it the provider reports "not configured" and returns
 * empty results immediately instead of hanging on a host that doesn't exist.
 * Name resolution works regardless, via on-chain ENS (Basenames resolve
 * through ENS's CCIP-read gateway on mainnet).
 */

import { callMcpTool, parseMcpToolResult as parseResult } from "../client";
import type {
  McpProviderId,
  McpProviderStatus,
  TokenInfo,
  UnsignedTx,
} from "../types";
import { createPublicClient, http, type Address } from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";

let ensClient: ReturnType<typeof createPublicClient> | null = null;
function getEnsClient() {
  ensClient ??= createPublicClient({ chain: mainnet, transport: http(process.env.MAINNET_RPC_URL || undefined, { timeout: 8000 }) });
  return ensClient;
}

const BASE_MCP_URL = process.env.BASE_MCP_URL || "";
const configured = BASE_MCP_URL !== "";
const PROVIDER_ID: McpProviderId = "base";
const SERVER_NAME = "base";
const BASE_CHAIN_ID = 8453;

// ─── Health check ────────────────────────────────────────────────────

let lastHealthCheck: McpProviderStatus = {
  id: PROVIDER_ID,
  name: "Base",
  healthy: false,
  latencyMs: null,
  lastChecked: 0,
  configured,
};

export async function checkHealth(): Promise<McpProviderStatus> {
  if (!configured) {
    lastHealthCheck = { id: PROVIDER_ID, name: "Base", healthy: false, latencyMs: null, lastChecked: Date.now(), configured: false };
    return lastHealthCheck;
  }
  const start = Date.now();
  try {
    const { listMcpTools } = await import("../client");
    await listMcpTools(BASE_MCP_URL, SERVER_NAME, { timeoutMs: 8000 });
    lastHealthCheck = {
      id: PROVIDER_ID,
      name: "Base",
      healthy: true,
      latencyMs: Date.now() - start,
      lastChecked: Date.now(),
      configured,
    };
  } catch {
    lastHealthCheck = {
      id: PROVIDER_ID,
      name: "Base",
      healthy: false,
      latencyMs: Date.now() - start,
      lastChecked: Date.now(),
      configured,
    };
  }
  return lastHealthCheck;
}

export function getStatus(): McpProviderStatus {
  return lastHealthCheck;
}

// ─── Name resolution ─────────────────────────────────────────────────

/**
 * Resolve a Basename or ENS name to an address (on-chain ENS, CCIP-read for *.base.eth).
 */
export async function resolveName(name: string): Promise<Address | null> {
  try {
    return (await getEnsClient().getEnsAddress({ name: normalize(name) })) ?? null;
  } catch (err) {
    console.warn("[base] resolveName failed:", err);
    return null;
  }
}

/**
 * Reverse-resolve an address to its primary ENS name.
 */
export async function reverseName(address: Address): Promise<string | null> {
  try {
    return (await getEnsClient().getEnsName({ address })) ?? null;
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
  if (!configured) return { isSmartWallet: false, paymasterAvailable: false };
  try {
    const result = await callMcpTool(BASE_MCP_URL, SERVER_NAME, "detect_smart_wallet", { address });
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
  if (!configured) return null;
  if (tx.chainId !== BASE_CHAIN_ID) return null;
  try {
    const result = await callMcpTool(BASE_MCP_URL, SERVER_NAME, "sponsor_transaction", {
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
  if (!configured) return [];
  try {
    const result = await callMcpTool(BASE_MCP_URL, SERVER_NAME, "get_aerodrome_pools", {
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
  if (!configured) return [];
  try {
    const result = await callMcpTool(BASE_MCP_URL, SERVER_NAME, "get_moonwell_markets", {});
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
  if (!configured) return null;
  try {
    const result = await callMcpTool(BASE_MCP_URL, SERVER_NAME, "get_onramp_quote", {
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

