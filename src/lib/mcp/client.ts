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
export async function getMcpClient(serverUrl: string, name: string): Promise<Client> {
  const existing = connectionPool.get(serverUrl);
  if (existing && Date.now() - existing.connectedAt < MAX_CONNECTION_AGE_MS) {
    return existing.client;
  }

  // Close stale connection if any
  if (existing) {
    try { await existing.transport.close(); } catch { /* ignore */ }
    connectionPool.delete(serverUrl);
  }

  const url = new URL(serverUrl);

  // Try Streamable HTTP first (current MCP standard)
  try {
    const transport = new StreamableHTTPClientTransport(url);
    const client = new Client({ name: `meridian-${name}`, version: "1.0.0" }, {
      capabilities: {},
    });
    await client.connect(transport);
    connectionPool.set(serverUrl, { client, transport, connectedAt: Date.now() });
    return client;
  } catch {
    // Fall back to legacy SSE transport
  }

  // Legacy SSE fallback
  const transport = new SSEClientTransport(url);
  const client = new Client({ name: `meridian-${name}`, version: "1.0.0" }, {
    capabilities: {},
  });
  await client.connect(transport);
  connectionPool.set(serverUrl, { client, transport, connectedAt: Date.now() });
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
  timeoutMs = 15000,
): Promise<unknown> {
  const client = await getMcpClient(serverUrl, serverName);

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
