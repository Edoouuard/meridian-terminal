/**
 * mcp/client.ts — MCP client supporting Streamable HTTP (primary) + SSE (legacy fallback).
 *
 * Connects to remote MCP servers and exposes a simple `callTool(name, args)` interface.
 * Connections are created on-demand and cached for the lifetime of the serverless
 * function instance.
 *
 * Non-custodial: MCP servers return unsigned transactions or read-only data.
 * Signing always happens client-side via wagmi/viem.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

// ─── Types ────────────────────────────────────────────────────────────

export type McpTransportKind = "http" | "sse" | "auto";

export interface McpClientOptions {
  /** Which transport to use. "auto" (default) tries HTTP first, falls back to SSE. */
  transport?: McpTransportKind;
  /** Extra headers to send (e.g. API key). Only supported by HTTP transport. */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds. Defaults to 15 000. */
  timeoutMs?: number;
}

interface McpConnection {
  client: Client;
  transport: StreamableHTTPClientTransport | SSEClientTransport;
  connectedAt: number;
}

/** Cache of active MCP connections keyed by server URL. */
const connectionPool = new Map<string, McpConnection>();

/** Max age before reconnecting (5 minutes). */
const MAX_CONNECTION_AGE_MS = 5 * 60 * 1000;

/**
 * Get or create an MCP client connection to a remote server.
 * Tries Streamable HTTP first, falls back to SSE for legacy servers.
 */
export async function getMcpClient(
  serverUrl: string,
  name: string,
  opts?: McpClientOptions,
): Promise<Client> {
  const kind = opts?.transport ?? "auto";
  const cacheKey = `${serverUrl}::${kind}`;

  const existing = connectionPool.get(cacheKey);
  if (existing && Date.now() - existing.connectedAt < MAX_CONNECTION_AGE_MS) {
    return existing.client;
  }

  // Close stale connection if any
  if (existing) {
    try { await existing.transport.close(); } catch { /* ignore */ }
    connectionPool.delete(cacheKey);
  }

  const url = new URL(serverUrl);

  // Try Streamable HTTP (current MCP standard)
  if (kind === "http" || kind === "auto") {
    try {
      const transportInit: Record<string, unknown> = {};
      if (opts?.headers) {
        transportInit.requestInit = { headers: opts.headers };
      }
      const transport = new StreamableHTTPClientTransport(url, transportInit);
      const client = new Client({ name: `meridian-${name}`, version: "1.0.0" }, {
        capabilities: {},
      });
      await client.connect(transport);
      connectionPool.set(cacheKey, { client, transport, connectedAt: Date.now() });
      return client;
    } catch {
      if (kind === "http") throw new Error(`[mcp] HTTP transport failed for ${serverUrl}`);
      // Fall through to SSE for "auto"
    }
  }

  // Legacy SSE fallback
  const transport = new SSEClientTransport(url);
  const client = new Client({ name: `meridian-${name}`, version: "1.0.0" }, {
    capabilities: {},
  });
  await client.connect(transport);
  connectionPool.set(cacheKey, { client, transport, connectedAt: Date.now() });
  return client;
}

/**
 * Call an MCP tool on a remote server. Returns the tool result content or
 * throws on connection/tool errors.
 *
 * The 5th argument accepts either a timeout number (ms) or an options object.
 */
export async function callMcpTool(
  serverUrl: string,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  optsOrTimeout?: number | McpClientOptions,
): Promise<unknown> {
  const opts: McpClientOptions =
    typeof optsOrTimeout === "number"
      ? { timeoutMs: optsOrTimeout }
      : optsOrTimeout ?? {};

  const timeoutMs = opts.timeoutMs ?? 15000;
  const client = await getMcpClient(serverUrl, serverName, opts);

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
 * Parse the MCP tool result content array into a typed value.
 * MCP tools return `{ content: [{ type: "text", text: "..." }] }` —
 * this extracts the first text block and JSON-parses it.
 */
export function parseMcpToolResult<T>(content: unknown): T | null {
  if (!content) return null;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && "type" in block) {
        if (block.type === "text" && "text" in block) {
          try { return JSON.parse(block.text as string) as T; } catch {
            return null;
          }
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
 * List available tools on an MCP server (useful for discovery/debugging).
 */
export async function listMcpTools(serverUrl: string, serverName: string) {
  const client = await getMcpClient(serverUrl, serverName);
  return client.listTools();
}

/**
 * Gracefully close all MCP connections (for cleanup).
 */
export async function closeAllMcpConnections() {
  for (const [url, conn] of connectionPool.entries()) {
    try { await conn.transport.close(); } catch { /* ignore */ }
    connectionPool.delete(url);
  }
}
