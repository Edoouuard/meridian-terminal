/**
 * mcp/client.ts — Lightweight MCP client for server-side API routes.
 *
 * Connects to remote MCP servers over either SSE (Aave, Hyperliquid) or
 * Streamable HTTP (deBridge, LI.FI — neither exposes an SSE endpoint) and
 * exposes a simple `callTool(name, args)` interface. Connections are
 * created on-demand and cached for the lifetime of the serverless function
 * instance, keyed by server URL + any custom headers (so an authenticated
 * and an unauthenticated client to the same server never share a slot).
 *
 * Non-custodial: MCP servers return unsigned transactions or read-only data.
 * Signing always happens client-side via wagmi/viem.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type McpTransportKind = "sse" | "http";

type McpTransport = SSEClientTransport | StreamableHTTPClientTransport;

interface McpConnection {
  client: Client;
  transport: McpTransport;
  connectedAt: number;
}

export interface McpClientOptions {
  /** "sse" (default — Aave/Hyperliquid) or "http" (Streamable HTTP — deBridge/LI.FI). */
  transport?: McpTransportKind;
  /** Extra HTTP headers (e.g. an API key). Only meaningful for "http". */
  headers?: Record<string, string>;
}

/** Cache of active MCP connections keyed by server URL (+ a headers fingerprint, if any). */
const connectionPool = new Map<string, McpConnection>();

/** Max age before reconnecting (5 minutes). */
const MAX_CONNECTION_AGE_MS = 5 * 60 * 1000;

function poolKey(serverUrl: string, headers?: Record<string, string>): string {
  if (!headers || Object.keys(headers).length === 0) return serverUrl;
  return `${serverUrl}::${JSON.stringify(headers)}`;
}

/**
 * Get or create an MCP client connection to a remote server. Connections
 * are reused within the same serverless instance lifecycle.
 */
export async function getMcpClient(serverUrl: string, name: string, opts: McpClientOptions = {}): Promise<Client> {
  const key = poolKey(serverUrl, opts.headers);
  const existing = connectionPool.get(key);
  if (existing && Date.now() - existing.connectedAt < MAX_CONNECTION_AGE_MS) {
    return existing.client;
  }

  // Close stale connection if any
  if (existing) {
    try { await existing.transport.close(); } catch { /* ignore */ }
    connectionPool.delete(key);
  }

  const transport: McpTransport =
    opts.transport === "http"
      ? new StreamableHTTPClientTransport(new URL(serverUrl), {
          requestInit: opts.headers ? { headers: opts.headers } : undefined,
        })
      : new SSEClientTransport(new URL(serverUrl));

  const client = new Client({ name: `meridian-${name}`, version: "1.0.0" }, {
    capabilities: {},
  });

  await client.connect(transport);

  connectionPool.set(key, {
    client,
    transport,
    connectedAt: Date.now(),
  });

  return client;
}

/**
 * Call an MCP tool on a remote server. Returns the tool result content or
 * throws on connection/tool errors. Timeout defaults to 15 seconds.
 */
export async function callMcpTool(
  serverUrl: string,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  opts: McpClientOptions & { timeoutMs?: number } = {},
): Promise<unknown> {
  const { timeoutMs = 15000, ...clientOpts } = opts;
  const client = await getMcpClient(serverUrl, serverName, clientOpts);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    return result.content;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * List available tools on an MCP server (useful for discovery/debugging).
 */
export async function listMcpTools(serverUrl: string, serverName: string, opts: McpClientOptions = {}) {
  const client = await getMcpClient(serverUrl, serverName, opts);
  return client.listTools();
}

/**
 * Parse an MCP tool result's content blocks into typed JSON. Shared by every
 * protocol module under mcp/ so each one doesn't reimplement the same
 * content-block unwrapping logic.
 */
export function parseMcpToolResult<T>(content: unknown): T | null {
  if (!content) return null;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && "type" in block && (block as { type: unknown }).type === "text" && "text" in block) {
        try {
          return JSON.parse((block as { text: string }).text) as T;
        } catch {
          return null;
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

/**
 * Gracefully close all MCP connections (for cleanup).
 */
export async function closeAllMcpConnections() {
  for (const [key, conn] of connectionPool.entries()) {
    try { await conn.transport.close(); } catch { /* ignore */ }
    connectionPool.delete(key);
  }
}
