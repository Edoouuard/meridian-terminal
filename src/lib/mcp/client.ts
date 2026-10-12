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
  /** Extra headers to send (e.g. API key or bearer token). */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds. Defaults to 15 000. */
  timeoutMs?: number;
}

/**
 * Thrown when the MCP server answered the call but flagged the result as an
 * error (`isError: true`) — e.g. invalid arguments or an upstream API failure.
 * The message is the server's own explanation.
 */
export class McpToolError extends Error {
  constructor(public readonly toolName: string, message: string) {
    super(`[mcp] ${toolName}: ${message}`);
    this.name = "McpToolError";
  }
}

interface McpConnection {
  client: Client;
  transport: StreamableHTTPClientTransport | SSEClientTransport;
  connectedAt: number;
  /** Set once the transport closed or the connection was evicted — never reuse it. */
  closed: boolean;
}

function track(client: Client, transport: StreamableHTTPClientTransport | SSEClientTransport): McpConnection {
  const conn: McpConnection = { client, transport, connectedAt: Date.now(), closed: false };
  client.onclose = () => { conn.closed = true; };
  return conn;
}

/** Cache of active (or in-flight) MCP connections keyed by server URL + transport + headers. */
const connectionPool = new Map<string, Promise<McpConnection>>();

/** Max age before reconnecting (5 minutes). */
const MAX_CONNECTION_AGE_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 10_000;

function poolKey(serverUrl: string, kind: McpTransportKind, headers?: Record<string, string>): string {
  const headerKey = headers ? Object.keys(headers).sort().map((k) => `${k}=${headers[k]}`).join("&") : "";
  return `${serverUrl}::${kind}::${headerKey}`;
}

async function closeQuietly(conn: McpConnection) {
  try { await conn.transport.close(); } catch { /* ignore */ }
}

async function openConnection(
  serverUrl: string,
  name: string,
  kind: McpTransportKind,
  headers?: Record<string, string>,
): Promise<McpConnection> {
  const url = new URL(serverUrl);
  const requestInit = headers ? { headers } : undefined;
  let httpError: unknown;

  // Try Streamable HTTP (current MCP standard)
  if (kind === "http" || kind === "auto") {
    const transport = new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined);
    const client = new Client({ name: `meridian-${name}`, version: "1.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      return track(client, transport);
    } catch (err) {
      try { await transport.close(); } catch { /* ignore */ }
      if (kind === "http") throw err;
      httpError = err;
    }
  }

  // Legacy SSE fallback
  const transport = new SSEClientTransport(url, requestInit ? { requestInit } : undefined);
  const client = new Client({ name: `meridian-${name}`, version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  } catch (err) {
    try { await transport.close(); } catch { /* ignore */ }
    // Report the Streamable HTTP failure — it's the primary transport and
    // usually the more informative error (e.g. a 401 from the server).
    throw httpError ?? err;
  }
  return track(client, transport);
}

async function getConnection(serverUrl: string, name: string, opts?: McpClientOptions): Promise<McpConnection> {
  const kind = opts?.transport ?? "auto";
  const key = poolKey(serverUrl, kind, opts?.headers);

  const pending = connectionPool.get(key);
  if (pending) {
    try {
      const conn = await pending;
      if (!conn.closed && Date.now() - conn.connectedAt < MAX_CONNECTION_AGE_MS) return conn;
      if (connectionPool.get(key) === pending) connectionPool.delete(key);
      void closeQuietly(conn);
    } catch {
      // A failed connection attempt was cached — drop it and retry below.
      if (connectionPool.get(key) === pending) connectionPool.delete(key);
    }
  }

  // Share one in-flight connection between concurrent callers.
  const created = openConnection(serverUrl, name, kind, opts?.headers);
  connectionPool.set(key, created);
  try {
    return await created;
  } catch (err) {
    if (connectionPool.get(key) === created) connectionPool.delete(key);
    throw err;
  }
}

/** Mark a connection dead synchronously (the next getConnection opens a fresh one), then close it. */
function evictConnection(conn: McpConnection) {
  conn.closed = true;
  void closeQuietly(conn);
}

/**
 * Get or create an MCP client connection to a remote server.
 * Tries Streamable HTTP first, falls back to SSE for legacy servers.
 */
export async function getMcpClient(
  serverUrl: string,
  name: string,
  opts?: McpClientOptions,
): Promise<Client> {
  return (await getConnection(serverUrl, name, opts)).client;
}

function errorText(content: unknown): string {
  if (Array.isArray(content)) {
    const texts = content
      .filter((b): b is { type: "text"; text: string } => !!b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text);
    if (texts.length > 0) return texts.join("\n").slice(0, 500);
  }
  return "tool returned an error";
}

/** MCP SDK error code for a request that exceeded its timeout. */
const REQUEST_TIMEOUT_CODE = -32001;

/**
 * Errors that a fresh connection wouldn't fix: tool errors, JSON-RPC errors
 * from the server (invalid params, unknown tool, …), and timeouts — a slow
 * call isn't a broken connection, and retrying it would only double the wait.
 */
function isNonRetryable(err: unknown): boolean {
  if (err instanceof McpToolError) return true;
  const code = (err as { code?: unknown })?.code;
  return typeof code === "number" && ((code >= -32700 && code <= -32600) || code === REQUEST_TIMEOUT_CODE);
}

/**
 * Call an MCP tool on a remote server. Returns the tool result content.
 *
 * Throws on connection failures, timeouts, JSON-RPC errors, and on results
 * the server flags with `isError` (as `McpToolError`). A broken or expired
 * connection is dropped and the call retried once on a fresh one; timeouts
 * and server-side errors are not retried.
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
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (let attempt = 0; ; attempt++) {
    const conn = await getConnection(serverUrl, serverName, opts);
    try {
      const result = await conn.client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { timeout: timeoutMs },
      );
      if (result.isError) throw new McpToolError(toolName, errorText(result.content));
      return result.content;
    } catch (err) {
      if (isNonRetryable(err)) throw err;
      // Transport-level failure (expired session, dropped connection):
      // never reuse this connection; retry once on a fresh one.
      evictConnection(conn);
      if (attempt >= 1) throw err;
    }
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
  const pending = [...connectionPool.values()];
  connectionPool.clear();
  await Promise.all(pending.map((p) => p.then(closeQuietly, () => {})));
}
